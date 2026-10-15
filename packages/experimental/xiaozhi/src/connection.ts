/** One device socket owns wake admission, provider work, and its accepted turn. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import WebSocket, { type RawData } from 'ws'
import { decodeAudio, encodeAudio, parseClient, parseVoice } from './protocol.ts'
import { WakeGate, speechSynthesisText, speechText } from './wakeup.ts'
import { hasVoiceSettings, voiceSettingsOf } from './types.ts'
import type { GatewayConfig, DeviceBinding, ListenMode, ProtocolVersion, SynthesisId } from './types.ts'

interface VoiceRequest {
  id: SessionRequestId
  sessionId: SessionId
  turn?: number
  answer: string
  answered: boolean
  /** Live chunks already produced speech for this turn; committed messages stay deduped. */
  streamed?: boolean
  muted?: boolean
  admitting: boolean
  control: AbortController
}

/** Sentence-end boundaries; the unsplit tail waits for one of these. */
const SENTENCE_PAUSES = ['。', '！', '？', '!', '?', '；', ';', '\n'] as const
/** The answer's opening words additionally break at comma-shaped pauses. */
const FIRST_SENTENCE_PAUSES = [...SENTENCE_PAUSES, '，', '、', '~', '：', ','] as const

/** Split speakable prose into TTS-sized sentences (official FIRST/MIDDLE/LAST pacing). */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？!?；;\n])/).map(part => part.trim()).filter(part => part.length > 0)
  const first = parts[0]
  if (first === undefined) return []
  // The opening words additionally break at the first comma-shaped pause
  // (official first_sentence_punctuations) so the first synthesis starts
  // before a full stop exists; later sentences wait for real sentence ends.
  const pause = first.search(/[，、~：,]/)
  if (pause === -1) return parts
  const head = first.slice(0, pause + 1).trim()
  const tail = first.slice(pause + 1).trim()
  if (head && tail) return [head, tail, ...parts.slice(1)]
  return parts
}
function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Voice dialogue phase of a connected device, for desktop companions:
     * listening (microphone capture open), thinking (owned turn running),
     * speaking (synthesis playback active), idle otherwise.
     */
    'xiaozhi/voice-phase': (session: SessionId, phase: 'idle' | 'listening' | 'thinking' | 'speaking') => void
  }
}

/** A socket-local runtime; each wake starts a fresh Harness dialogue. */
export class DeviceConnection {
  private readonly lifetime = new AbortController()
  private readonly gate: WakeGate
  private readonly provider: WebSocket
  private version: ProtocolVersion | undefined
  private ready = false
  private failing = false
  private listening = false
  private phase: 'idle' | 'listening' | 'thinking' | 'speaking' = 'idle'
  private epoch = 0
  private queue = Promise.resolve()
  private queuedBytes = 0
  private openingTurn: number | undefined
  private request: VoiceRequest | undefined
  private speech: { id: SynthesisId; text: string } | undefined
  /** Pending sentences of the owned request, spoken one synthesize at a time. */
  private speechQueue: string[] = []
  /** Live-stream state of the owned request's current attempt. */
  private streamAttempt: string | undefined
  private streamBuffer = ''
  private streamFirstSentence = true
  private streamedChars = 0
  private deadline: NodeJS.Timeout | undefined
  private voiceSettingsSynced = false
  private lastVoiceSettings: string | undefined
  private readonly heartbeat: NodeJS.Timeout
  private alive = true
  private readonly handshake: NodeJS.Timeout
  private idleTimer: NodeJS.Timeout | undefined
  private farewellPending = false
  /** Farewell the model left in handle_exit_intent's say_goodbye, spoken when its turn produced no prose. */
  private exitGoodbye: string | undefined
  /** Whether this connection ever admitted wake, prompt, or stop input. */
  private dialogueSeen = false
  /** Acoustic wake may also arrive as a prefixed ASR transcript. */
  private acousticWakePending = false
  private dialogueCreation: AbortController | undefined
  /** Current Harness dialogue identity; device controls retain the configured identity. */
  sessionId

  constructor(
    private readonly ctx: Context,
    private readonly socket: WebSocket,
    private readonly binding: DeviceBinding,
    private readonly config: GatewayConfig,
    private readonly onClose: () => void,
  ) {
    this.sessionId = SessionId(binding.sessionId)
    this.gate = new WakeGate(
      config.wakeWords, config.stopWords, config.dialogueTimeoutMs, config.echoGuardMs,
      config.cancelWords, config.exitWords,
    )
    this.provider = new WebSocket(config.voiceUrl, {
      headers: { Authorization: `Bearer ${config.voiceToken}` }, maxPayload: config.maxPayloadBytes,
      handshakeTimeout: config.handshakeTimeoutMs,
    })
    this.provider.on('message', (data, binary) => {
      try { this.receiveVoice(bytes(data), binary) } catch (error) { this.fail(error) }
    })
    this.provider.on('error', (error) => { this.fail(error) })
    this.provider.on('close', () => { if (!this.lifetime.signal.aborted) this.fail(new Error('Voice service disconnected')) })
    this.provider.on('open', () => {
      this.sendProvider({ type: 'hello', sample_rate: 16000, frame_duration: 60 })
      this.syncVoiceSettings()
    })
    socket.on('error', (error) => { this.fail(error) })
    socket.on('close', () => { this.dispose() })
    socket.on('pong', () => { this.alive = true })
    socket.on('message', (data, binary) => {
      if (this.failing) return
      const frame = bytes(data)
      this.queuedBytes += frame.length
      if (this.queuedBytes > config.maxBufferedBytes) { this.fail(new Error('Device input overflow')); return }
      // Abort must not wait behind cold-session activation or ASR admission.
      if (!binary) {
        try {
          const message = parseClient(frame.toString('utf8'), config.maxTextChars)
          if (message.type === 'abort') {
            this.queuedBytes -= frame.length
            this.stop(true)
            return
          }
        } catch (error) { this.fail(error); return }
      }
      this.queue = this.queue.then(async () => {
        try {
          if (!this.lifetime.signal.aborted) await this.receiveClient(frame, binary)
        } finally { this.queuedBytes -= frame.length }
      }).catch((error: unknown) => { this.fail(error) })
    })
    this.heartbeat = setInterval(() => {
      if (!this.alive) { this.fail(new Error('Device heartbeat expired')); return }
      this.alive = false
      socket.ping()
    }, config.heartbeatMs)
    this.handshake = setTimeout(() => { this.fail(new Error('Voice handshake timed out')) }, config.handshakeTimeoutMs)
    this.armIdleFarewell()
  }

  /** Rearm the idle farewell; admitted activity and finished speech renew it. */
  private armIdleFarewell(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.config.idleFarewellMs <= 0) return
    // A connection that never carried a dialogue is asleep waiting for wake:
    // saying goodbye (and hanging up, which auto-reconnects back into the same
    // idle state) every timeout would loop the farewell out loud forever.
    if (!this.dialogueSeen) return
    this.idleTimer = setTimeout(() => {
      // A turn or playback in progress pushes the farewell past its end.
      if (this.request !== undefined || this.speech !== undefined || this.speechQueue.length > 0) {
        this.armIdleFarewell()
        return
      }
      // Official close_connection_no_voice_time pacing: say goodbye once,
      // then hang the connection; the device reconnects and waits for wake.
      this.farewellPending = true
      this.speak(this.config.farewell)
    }, this.config.idleFarewellMs)
  }

  private send(socket: WebSocket, data: string | Buffer): void {
    if (this.lifetime.signal.aborted) return
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer.byteLength(data) > this.config.maxBufferedBytes) {
      throw new Error('Voice transport unavailable or over capacity')
    }
    socket.send(data, (error) => { if (error) this.fail(error) })
  }
  private sendProvider(value: object): void { this.send(this.provider, JSON.stringify(value)) }
  private sendClient(value: object): void { this.send(this.socket, JSON.stringify({ session_id: this.binding.sessionId, ...value })) }
  /** Publish the dialogue phase for desktop companions listening on the event bus. */
  private setPhase(phase: 'idle' | 'listening' | 'thinking' | 'speaking'): void {
    if (this.phase === phase) return
    this.phase = phase
    this.ctx.emit('xiaozhi/voice-phase', SessionId(this.binding.sessionId), phase)
  }

  /** Microphone epoch changes must not override playback or an owned turn. */
  private refreshPhase(): void {
    this.setPhase(this.speech !== undefined || this.speechQueue.length > 0 ? 'speaking'
      : this.request !== undefined || this.dialogueCreation !== undefined ? 'thinking'
        : this.listening ? 'listening' : 'idle')
  }

  private async receiveClient(frame: Buffer, binary: boolean): Promise<void> {
    if (binary) {
      if (this.version === undefined || !this.ready) throw new Error('Audio before hello')
      if (!this.listening) return
      this.send(this.provider, decodeAudio(frame, this.version))
      return
    }
    const message = parseClient(frame.toString('utf8'), this.config.maxTextChars)
    if (message.type === 'hello') {
      if (this.version !== undefined) throw new Error('Duplicate hello')
      this.version = message.version
      this.publishHello()
      return
    }
    if (message.type === 'goodbye') { this.dispose(); return }
    if (message.type === 'ping') { this.sendClient({ type: 'pong' }); return }
    if (this.version === undefined || !this.ready) throw new Error('Control before hello')
    switch (message.type) {
      case 'listen':
        if (message.state === 'start') this.startListening(message.mode)
        else if (message.state === 'stop') {
          this.listening = false
          this.refreshPhase()
          this.sendProvider({ type: 'listen', state: 'stop', epoch: this.epoch })
        } else await this.admit(message.text)
        break
      case 'abort': this.stop(true); break
      // Device MCP is not advertised by this gateway; initialization belongs to a later plugin.
      case 'mcp': break
    }
  }

  private publishHello(): void {
    if (!this.ready || this.version === undefined) return
    clearTimeout(this.handshake)
    this.sendClient({
      type: 'hello', version: this.version, transport: 'websocket',
      audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 },
      features: { mcp: false },
    })
  }

  private startListening(mode: ListenMode): void {
    this.listening = true
    this.epoch++
    this.refreshPhase()
    this.syncVoiceSettings()
    this.sendProvider({ type: 'listen', state: 'start', mode, epoch: this.epoch })
  }

  /**
   * Push speech-backend overrides to the speech service when the live
   * configuration changed since the last push. Volatile values are not
   * observable, so re-reads happen at the open, listen, and synthesize
   * boundaries; the next utterance or synthesis already uses the new backends.
   */
  private syncVoiceSettings(): void {
    if (this.provider.readyState !== WebSocket.OPEN) return
    const settings = voiceSettingsOf(this.config)
    const fingerprint = JSON.stringify(settings)
    if (this.voiceSettingsSynced && fingerprint === this.lastVoiceSettings) return
    if (!this.voiceSettingsSynced && !hasVoiceSettings(settings)) return
    this.voiceSettingsSynced = true
    this.lastVoiceSettings = fingerprint
    this.sendProvider({ type: 'configure', ...settings })
  }

  private receiveVoice(frame: Buffer, binary: boolean): void {
    if (this.lifetime.signal.aborted || this.failing) return
    if (binary) {
      if (frame.length <= 36) throw new Error('Truncated provider audio')
      if (this.speech === undefined || frame.subarray(0, 36).toString('ascii') !== this.speech.id) return
      if (this.version === undefined) throw new Error('Provider audio before client hello')
      this.gate.spoken(this.speech.text, Date.now())
      this.send(this.socket, encodeAudio(frame.subarray(36), this.version))
      return
    }
    const message = parseVoice(frame.toString('utf8'), this.config.maxTextChars)
    switch (message.type) {
      case 'ready':
        if (this.ready) throw new Error('Duplicate provider ready')
        this.ready = true
        this.publishHello()
        break
      case 'transcript':
        if (!this.ready || this.version === undefined) throw new Error('Transcript before hello')
        if (message.epoch !== this.epoch) return
        this.queuedBytes += Buffer.byteLength(message.text)
        if (this.queuedBytes > this.config.maxBufferedBytes) throw new Error('Transcript input overflow')
        this.queue = this.queue.then(async () => {
          try {
            if (!this.lifetime.signal.aborted && message.epoch === this.epoch) await this.admit(message.text)
          } finally { this.queuedBytes -= Buffer.byteLength(message.text) }
        }).catch((error: unknown) => { this.fail(error) })
        break
      case 'tts':
        if (message.id !== this.speech?.id) return
        if (message.state === 'start') {
          // Admission already opened Speaking; between sentences the client
          // dipped to Listening, so this start re-arms audio acceptance.
          this.sendClient({ type: 'tts', state: 'start' })
          this.sendClient({ type: 'tts', state: 'sentence_start', text: this.speech.text })
        } else {
          this.sendClient({ type: 'tts', state: 'stop' })
          this.speech = undefined
          // More sentences of the same answer follow immediately; only the
          // last one closes the dialogue window and the deadline.
          if (this.speechQueue.length > 0) {
            this.speakNext()
            return
          }
          this.clearDeadline()
          this.gate.resume(Date.now())
          this.refreshPhase()
          // The farewell's last frame played out: hang the connection so the
          // device reconnects asleep instead of holding an open microphone.
          if (this.farewellPending) { this.dispose(); return }
          this.armIdleFarewell()
        }
        break
      case 'wake': {
        // Acoustic hit from the speech service's local spotter; transcript
        // matching remains the fallback path for missed detections.
        if (!this.ready || this.version === undefined) return
        // During playback the microphone stays open (client barge-in), so an
        // acoustic hit is almost surely loudspeaker echo of our own speech;
        // interruptions belong to the transcript path, exactly like the
        // official backend where only device-side detection exists.
        if (this.speech !== undefined || this.speechQueue.length > 0) return
        this.queue = this.queue.then(async () => {
          if (this.lifetime.signal.aborted || this.speech !== undefined || this.speechQueue.length > 0) return
          if (this.request !== undefined && !this.config.allowBargeIn) return
          this.stop(true)
          this.acousticWakePending = true
          if (!await this.newDialogue()) return
          this.dialogueSeen = true
          this.farewellPending = false
          this.armIdleFarewell()
          this.sendClient({ type: 'stt', text: message.keyword })
          this.sendClient({ type: 'tts', state: 'start' })
          this.speak(this.config.greeting)
        }).catch((error: unknown) => { this.fail(error) })
        break
      }
      case 'error': throw new Error(`Voice service: ${message.message}`)
    }
  }

  /** Create an independent task before greeting or submitting the first prompt. */
  private async newDialogue(): Promise<boolean> {
    this.sessionId = SessionId(`${this.binding.sessionId}-${randomUUID()}`)
    this.openingTurn = undefined
    const control = new AbortController()
    this.dialogueCreation = control
    this.armDeadline()
    try {
      await this.ctx.sessionController.create({
        sessionId: this.sessionId,
        ...(this.binding.cwd === undefined ? {} : { cwd: this.binding.cwd }),
        ...(this.binding.agentPreset === undefined ? {} : { agentPreset: this.binding.agentPreset }),
      })
      return !control.signal.aborted && !this.lifetime.signal.aborted
    } finally {
      this.dialogueCreation = undefined
      this.refreshPhase()
      this.clearDeadline()
    }
  }

  private async admit(text: string): Promise<void> {
    const busy = this.request !== undefined || this.speech !== undefined
    const admission = this.gate.admit(text, Date.now(), busy)
    // Admission diagnostics: which way each final ASR text went and why the
    // echo guards did or did not drop it. Transcripts are user-visible in the
    // device chat anyway; configure payloads are never logged. warn because
    // the web profile's console filters info-level plugin output.
    this.ctx.logger.warn(`xiaozhi: admit ${admission.kind} busy=${busy} guards=${this.gate.guardState(Date.now())} text=${JSON.stringify(text)}`)
    if (admission.kind === 'ignore') return
    this.dialogueSeen = true
    if (admission.kind === 'stop') { this.stop(admission.cancelAgent); return }
    if (admission.kind === 'exit') {
      // The user closed the conversation: cancel any owned turn, play one
      // goodbye, then hang — exactly the idle-farewell teardown, so the device
      // reconnects asleep and only the wake word reopens the dialogue.
      this.stop(true)
      this.sendClient({ type: 'stt', text })
      this.sendClient({ type: 'tts', state: 'start' })
      this.farewellPending = true
      this.speak(this.config.goodbye)
      return
    }
    if (busy && !this.config.allowBargeIn) return
    this.stop(true)
    const acousticWake = this.acousticWakePending
    this.acousticWakePending = false
    if (!acousticWake && (admission.kind === 'wake' || admission.woke === true)) {
      if (!await this.newDialogue()) return
    }
    // Fresh user activity cancels a pending farewell and restarts the clock.
    this.farewellPending = false
    this.exitGoodbye = undefined
    this.armIdleFarewell()
    if (admission.kind === 'wake') {
      this.sendClient({ type: 'stt', text })
      // Speaking starts at admission (official send_stt_message pacing) so the
      // device shows the reply state while the answer is still generated.
      this.sendClient({ type: 'tts', state: 'start' })
      this.speak(this.config.greeting)
      return
    }
    const control = new AbortController()
    const operation: VoiceRequest = { id: brandString<SessionRequestId>(randomUUID()), sessionId: this.sessionId, answer: '', answered: false, admitting: true, control }
    this.request = operation
    this.resetStreamState()
    this.setPhase('thinking')
    this.armDeadline()
    this.sendClient({ type: 'stt', text: admission.text })
    this.sendClient({ type: 'tts', state: 'start' })
    try {
      await this.ctx.sessionController.create({
        sessionId: this.sessionId,
        ...(this.binding.cwd === undefined ? {} : { cwd: this.binding.cwd }),
        ...(this.binding.agentPreset === undefined ? {} : { agentPreset: this.binding.agentPreset }),
      })
      control.signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      await this.ctx.sessionController.prompt({
        requestId: operation.id, sessionId: operation.sessionId, mode: 'queue',
        content: [{ type: 'text', text: admission.text }],
      }, control.signal)
      // Later admission awaits may complete after the initial cancellation check.
      if (control.signal.aborted) this.cancelOwned(operation)
    } catch (error) {
      if (!control.signal.aborted) throw error
    } finally {
      operation.admitting = false
      if (control.signal.aborted && this.request === operation) this.request = undefined
    }
  }

  /**
   * Capture ownership before asynchronous pre-step admission can begin.
   * @param message - Inbox message claimed by the attached Agent.
   * @param turn - Turn assigned at inbox claim.
   */
  claimed(message: UserMessage, turn: number): void {
    const request = this.request
    if (request === undefined || message.source.kind !== 'user' || !('rpcId' in message.source)
      || message.source.rpcId !== request.id) return
    request.turn = turn
    this.openingTurn = turn
    if (request.control.signal.aborted) this.cancelOwned(request)
  }
  /**
   * Observe new durable events correlated with the device prompt identity.
   * @param event - Newly appended event from the bound session.
   */
  observe(event: SessionEvent): void {
    try { this.observeCommitted(event) } catch (error) { this.fail(error) }
  }

  private observeCommitted(event: SessionEvent): void {
    const request = this.request
    if (request === undefined) return
    if (event.type === 'turn/start') this.openingTurn = event.data.turn
    if (event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source
      && event.data.source.rpcId === request.id) {
      if (this.openingTurn === undefined) throw new Error('User message has no open turn')
      request.turn = this.openingTurn
    }
    // The model recognized a goodbye (official handle_exit_intent): the turn
    // keeps running so the model's own farewell reply streams out and plays,
    // and the pending-farewell teardown hangs the connection once it drains.
    // A later admitted prompt cancels the pending farewell as usual.
    if (event.type === 'tool/call' && event.data.name === 'handle_exit_intent' && event.data.turn === request.turn) {
      let goodbye: unknown
      try { goodbye = (JSON.parse(event.data.arguments) as Record<string, unknown>).say_goodbye } catch { goodbye = undefined }
      this.exitGoodbye = typeof goodbye === 'string' && goodbye.trim() !== '' ? goodbye : undefined
      this.farewellPending = true
    }
    if (request.control.signal.aborted) return
    if (event.type === 'assistant/message' && event.data.turn === request.turn && event.data.interrupted !== true) {
      const content = event.data.message.content
      const firstTool = content.findIndex(block => block.type === 'tool-call')
      const prose = (firstTool === -1 ? content : content.slice(0, firstTool))
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (prose.trim()) request.answer = prose
      // A pure-text message is the spoken reply, unless live streaming already
      // spoke it: chunk-level pacing enqueues sentences while the model is
      // still generating, so the committed message only updates bookkeeping.
      // When nothing streamed into the queue yet (no boundary arrived, or no
      // frames flowed), the whole message enqueues here and owns the buffer,
      // keeping the stream-end flush from double-speaking the tail.
      // Text preceding tool calls in a message is the agent narrating its next
      // step — streaming speaks that too (official pacing), the fallback path
      // keeps it unspoken.
      if (firstTool === -1 && request.muted !== true && request.streamed !== true) {
        this.streamBuffer = ''
        this.enqueueAnswer(speechText(prose))
      }
    }
    if (event.type === 'turn/end' && event.data.turn === request.turn) {
      this.request = undefined
      if (event.data.reason.kind === 'completed') this.gate.resume(Date.now())
      if (event.data.reason.kind === 'completed' && request.muted !== true) {
        const answer = speechText(request.answer)
        if (answer.length > this.config.maxTextChars) { this.fail(new Error('Answer exceeds speech limit')); return }
        // Streaming already queued the reply; speak() here only covers event
        // shapes that produced no enqueueable message. A goodbye turn that
        // committed no prose (a bare handle_exit_intent call) still speaks the
        // farewell the model left in say_goodbye.
        if (!request.answered) {
          if (answer === '' && this.farewellPending) {
            const goodbye = this.exitGoodbye !== undefined && this.exitGoodbye.length <= this.config.maxTextChars
              ? this.exitGoodbye : this.config.goodbye
            this.enqueueAnswer(goodbye)
          } else this.enqueueAnswer(answer)
        } else if (!answer && this.speech === undefined && this.speechQueue.length === 0) {
          this.clearDeadline()
          this.sendClient({ type: 'tts', state: 'stop' })
          this.gate.resume(Date.now())
          this.refreshPhase()
        }
      } else if (event.data.reason.kind === 'aborted') {
        // A cancelled answer stops mid-sentence at most; never start new ones.
        this.speechQueue = []
      } else if (event.data.reason.kind !== 'completed') this.fail(new Error('Harness turn did not complete'))
      this.refreshPhase()
    }
  }

  /**
   * Feed one live assistant-stream frame; text deltas of the owned turn
   * enqueue sentences at punctuation boundaries while still generating.
   * @param frame - One ordered start, chunk, or end publication.
   */
  streamFrame(frame: AssistantStreamFrame): void {
    try { this.receiveStreamFrame(frame) } catch (error) { this.fail(error) }
  }

  private receiveStreamFrame(frame: AssistantStreamFrame): void {
    const request = this.request
    if (request === undefined || request.control.signal.aborted || request.muted === true) return
    if (frame.type === 'start') {
      // Only the owned turn's attempts accumulate; attempts of other prompts
      // into the same session must not leak into this answer.
      if (request.turn === undefined || frame.turn !== request.turn) return
      this.streamAttempt = frame.attemptId
      return
    }
    if (frame.type === 'chunk') {
      if (frame.attemptId !== this.streamAttempt || frame.chunk.type !== 'text-delta') return
      this.streamBuffer += frame.chunk.text
      // Cut at the LAST boundary in the buffer (official _get_segment_text
      // rfind): the longest complete segment leaves, the tail keeps waiting.
      let cut = -1
      for (const pause of this.streamFirstSentence ? FIRST_SENTENCE_PAUSES : SENTENCE_PAUSES) {
        const at = this.streamBuffer.lastIndexOf(pause)
        if (at > cut) cut = at
      }
      if (cut === -1) return
      const segment = this.streamBuffer.slice(0, cut + 1)
      this.streamBuffer = this.streamBuffer.slice(cut + 1)
      this.enqueueStreamSegment(segment)
      return
    }
    if (frame.attemptId !== this.streamAttempt) return
    this.streamAttempt = undefined
    if (frame.outcome.kind === 'abandoned' || frame.outcome.eventType !== 'assistant/message') {
      // A retried or cancelled attempt committed no message; already-started
      // sentences finish, but nothing new starts from this text. A retry
      // streams its own full text.
      this.speechQueue = []
      this.streamBuffer = ''
      return
    }
    // The durable message follows immediately; speak the unsplit tail now so
    // the answer does not wait for punctuation the model never wrote.
    if (this.streamBuffer !== '') this.enqueueStreamSegment(this.streamBuffer)
    this.streamBuffer = ''
  }

  private enqueueStreamSegment(segment: string): void {
    const cleaned = speechText(segment)
    if (cleaned === '') return
    this.streamedChars += cleaned.length
    if (this.streamedChars > this.config.maxTextChars) throw new Error('Answer exceeds speech limit')
    this.streamFirstSentence = false
    const request = this.request
    if (request !== undefined) { request.answered = true; request.streamed = true }
    this.speechQueue.push(cleaned)
    if (this.speech === undefined) this.speakNext()
  }

  /** Drop live-stream state; new prompts and cancellations start clean. */
  private resetStreamState(): void {
    this.streamAttempt = undefined
    this.streamBuffer = ''
    this.streamFirstSentence = true
    this.streamedChars = 0
  }

  /** Queue reply sentences for sequential synthesis; start speaking when idle. */
  private enqueueAnswer(text: string): void {
    const sentences = splitSentences(text)
    if (sentences.length === 0) return
    const request = this.request
    if (request !== undefined) request.answered = true
    this.speechQueue.push(...sentences)
    if (this.speech === undefined) this.speakNext()
  }

  /** Speak the next queued sentence; the tts stop of one advances to the next. */
  private speakNext(): void {
    const sentence = this.speechQueue.shift()
    if (sentence !== undefined) this.speak(sentence)
  }

  private speak(text: string): void {
    if (!text) { this.gate.resume(Date.now()); return }
    this.speech = { id: brandString<SynthesisId>(randomUUID()), text }
    this.setPhase('speaking')
    this.gate.spoken(text, Date.now())
    this.armDeadline()
    this.syncVoiceSettings()
    // The client transcript keeps a leading emoji for its expression affordance;
    // the synthesis payload drops emoji so TTS never reads them. An all-emoji
    // sentence keeps its original text rather than synthesizing an empty string.
    const synthesis = speechSynthesisText(text)
    this.sendProvider({ type: 'synthesize', id: this.speech.id, text: synthesis === '' ? text : synthesis })
  }

  private clearDeadline(): void {
    if (this.deadline !== undefined) clearTimeout(this.deadline)
    this.deadline = undefined
  }
  private armDeadline(): void {
    this.clearDeadline()
    this.deadline = setTimeout(() => { this.fail(new Error('Voice operation timed out')) }, this.config.operationTimeoutMs)
  }

  private cancelOwned(request: VoiceRequest): void {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) return
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message =>
      message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === request.id)
    if (pending !== undefined) {
      agent.inbox.remove(pending.id)
      return
    }
    if (request.turn !== undefined && request.turn === this.openingTurn) {
      this.ctx.sessionController.cancel({ sessionId: request.sessionId })
    }
  }
  private stop(cancelAgent: boolean): void {
    const request = this.request
    this.speechQueue = []
    this.resetStreamState()
    if (cancelAgent) {
      this.dialogueCreation?.abort()
      if (request?.admitting !== true) this.request = undefined
      request?.control.abort()
    } else if (request !== undefined) request.muted = true
    if (cancelAgent && request !== undefined) this.cancelOwned(request)
    if (this.speech !== undefined) {
      const id = this.speech.id
      this.speech = undefined
      if (this.provider.readyState === WebSocket.OPEN) this.sendProvider({ type: 'cancel', id })
      if (this.socket.readyState === WebSocket.OPEN) this.sendClient({ type: 'tts', state: 'stop' })
    } else if ((request !== undefined || this.dialogueCreation !== undefined) && this.socket.readyState === WebSocket.OPEN) this.sendClient({ type: 'tts', state: 'stop' })
    if (cancelAgent || request === undefined) this.clearDeadline()
    this.gate.resume(Date.now())
    this.refreshPhase()
  }

  private fail(error: unknown): void {
    if (this.lifetime.signal.aborted || this.failing) return
    this.failing = true
    this.ctx.logger.warn(`xiaozhi: ${error instanceof Error ? error.message : String(error)}`)
    try { this.stop(true) } catch (cancelError) { this.ctx.logger.warn('xiaozhi: cancellation failed: ' + String(cancelError)) }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.clearDeadline()
      this.deadline = setTimeout(() => { this.dispose() }, this.config.handshakeTimeoutMs)
      // Linux displays alert.message; flush the alert before tearing down its socket.
      this.socket.send(JSON.stringify({ type: 'alert', status: 'error', message: '语音连接失败，请重新连接。', emotion: 'sad' }), () => { this.dispose() })
    } else this.dispose()
  }

  /** Stop owned work and release both sockets; repeated teardown is harmless. */
  dispose(): void {
    if (this.lifetime.signal.aborted) return
    try { this.stop(true) } catch (error) { this.ctx.logger.warn(`xiaozhi: cancellation failed: ${String(error)}`) }
    this.setPhase('idle')
    this.lifetime.abort()
    clearInterval(this.heartbeat)
    clearTimeout(this.handshake)
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.clearDeadline()
    this.provider.terminate()
    this.socket.terminate()
    this.onClose()
  }

  /** Await outstanding prompt admission after cancellation during plugin unload. */
  async settled(): Promise<void> { await this.queue }
}
