/** One device socket owns wake admission, provider work, and its accepted turn. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import WebSocket, { type RawData } from 'ws'
import { decodeAudio, encodeAudio, parseClient, parseVoice } from './protocol.ts'
import { WakeGate, speechText } from './wakeup.ts'
import type { GatewayConfig, DeviceBinding, ListenMode, ProtocolVersion, SynthesisId } from './types.ts'

interface VoiceRequest {
  id: SessionRequestId
  turn?: number
  answer: string
  muted?: boolean
  admitting: boolean
  control: AbortController
}
function bytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

/** A socket-local runtime; reconnects retain only the configured Harness session. */
export class DeviceConnection {
  private readonly lifetime = new AbortController()
  private readonly gate: WakeGate
  private readonly provider: WebSocket
  private version: ProtocolVersion | undefined
  private ready = false
  private failing = false
  private listening = false
  private epoch = 0
  private queue = Promise.resolve()
  private queuedBytes = 0
  private openingTurn: number | undefined
  private request: VoiceRequest | undefined
  private speech: { id: SynthesisId; text: string } | undefined
  private deadline: NodeJS.Timeout | undefined
  private readonly heartbeat: NodeJS.Timeout
  private alive = true
  private readonly handshake: NodeJS.Timeout
  /** Stable Harness session identity configured for this device. */
  readonly sessionId

  constructor(
    private readonly ctx: Context,
    private readonly socket: WebSocket,
    private readonly binding: DeviceBinding,
    private readonly config: GatewayConfig,
    private readonly onClose: () => void,
  ) {
    this.sessionId = SessionId(binding.sessionId)
    this.gate = new WakeGate(config.wakeWords, config.stopWords, config.dialogueTimeoutMs, config.echoGuardMs, config.cancelWords)
    this.provider = new WebSocket(config.voiceUrl, {
      headers: { Authorization: `Bearer ${config.voiceToken}` }, maxPayload: config.maxPayloadBytes,
      handshakeTimeout: config.handshakeTimeoutMs,
    })
    this.provider.on('message', (data, binary) => {
      try { this.receiveVoice(bytes(data), binary) } catch (error) { this.fail(error) }
    })
    this.provider.on('error', (error) => { this.fail(error) })
    this.provider.on('close', () => { if (!this.lifetime.signal.aborted) this.fail(new Error('Voice service disconnected')) })
    this.provider.on('open', () => { this.sendProvider({ type: 'hello', sample_rate: 16000, frame_duration: 60 }) })
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
  }

  private send(socket: WebSocket, data: string | Buffer): void {
    if (this.lifetime.signal.aborted) return
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer.byteLength(data) > this.config.maxBufferedBytes) {
      throw new Error('Voice transport unavailable or over capacity')
    }
    socket.send(data, (error) => { if (error) this.fail(error) })
  }
  private sendProvider(value: object): void { this.send(this.provider, JSON.stringify(value)) }
  private sendClient(value: object): void { this.send(this.socket, JSON.stringify({ session_id: this.sessionId, ...value })) }

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
    this.sendProvider({ type: 'listen', state: 'start', mode, epoch: this.epoch })
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
          this.sendClient({ type: 'tts', state: 'start' })
          this.sendClient({ type: 'tts', state: 'sentence_start', text: this.speech.text })
        } else {
          this.sendClient({ type: 'tts', state: 'stop' })
          this.speech = undefined
          this.clearDeadline()
          this.gate.resume(Date.now())
        }
        break
      case 'error': throw new Error(`Voice service: ${message.message}`)
    }
  }

  private async admit(text: string): Promise<void> {
    const busy = this.request !== undefined || this.speech !== undefined
    const admission = this.gate.admit(text, Date.now(), busy)
    if (admission.kind === 'ignore') return
    if (admission.kind === 'stop') { this.stop(admission.cancelAgent); return }
    if (busy && !this.config.allowBargeIn) return
    this.stop(true)
    if (admission.kind === 'wake') {
      this.sendClient({ type: 'stt', text })
      this.speak(this.config.greeting)
      return
    }
    const control = new AbortController()
    const operation: VoiceRequest = { id: brandString<SessionRequestId>(randomUUID()), answer: '', admitting: true, control }
    this.request = operation
    this.armDeadline()
    this.sendClient({ type: 'stt', text: admission.text })
    try {
      await this.ctx.sessionController.create({
        sessionId: this.sessionId,
        ...(this.binding.cwd === undefined ? {} : { cwd: this.binding.cwd }),
        ...(this.binding.agentPreset === undefined ? {} : { agentPreset: this.binding.agentPreset }),
      })
      control.signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      await this.ctx.sessionController.prompt({
        requestId: operation.id, sessionId: this.sessionId, mode: 'queue',
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
    if (request.control.signal.aborted) return
    if (event.type === 'assistant/message' && event.data.turn === request.turn && event.data.interrupted !== true) {
      request.answer = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    }
    if (event.type === 'turn/end' && event.data.turn === request.turn) {
      this.request = undefined
      this.clearDeadline()
      if (event.data.reason.kind === 'completed') this.gate.resume(Date.now())
      if (event.data.reason.kind === 'completed' && request.muted !== true) {
        const answer = speechText(request.answer)
        if (answer.length > this.config.maxTextChars) { this.fail(new Error('Answer exceeds speech limit')); return }
        if (answer) this.speak(answer)
        else { this.sendClient({ type: 'tts', state: 'stop' }); this.gate.resume(Date.now()) }
      } else if (event.data.reason.kind !== 'aborted' && event.data.reason.kind !== 'completed') this.fail(new Error('Harness turn did not complete'))
    }
  }

  private speak(text: string): void {
    if (!text) { this.gate.resume(Date.now()); return }
    this.speech = { id: brandString<SynthesisId>(randomUUID()), text }
    this.gate.spoken(text, Date.now())
    this.armDeadline()
    this.sendProvider({ type: 'synthesize', ...this.speech })
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
    const agent = this.ctx.agents.get(this.sessionId)
    if (agent === undefined) return
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message =>
      message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === request.id)
    if (pending !== undefined) {
      agent.inbox.remove(pending.id)
      return
    }
    if (request.turn !== undefined && request.turn === this.openingTurn) {
      this.ctx.sessionController.cancel({ sessionId: this.sessionId })
    }
  }
  private stop(cancelAgent: boolean): void {
    const request = this.request
    if (cancelAgent) {
      if (request?.admitting !== true) this.request = undefined
      request?.control.abort()
    } else if (request !== undefined) request.muted = true
    if (cancelAgent && request !== undefined) this.cancelOwned(request)
    if (this.speech !== undefined) {
      const id = this.speech.id
      this.speech = undefined
      if (this.provider.readyState === WebSocket.OPEN) this.sendProvider({ type: 'cancel', id })
      if (this.socket.readyState === WebSocket.OPEN) this.sendClient({ type: 'tts', state: 'stop' })
    } else if (request !== undefined && this.socket.readyState === WebSocket.OPEN) this.sendClient({ type: 'tts', state: 'stop' })
    if (cancelAgent || request === undefined) this.clearDeadline()
    this.gate.resume(Date.now())
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
    this.lifetime.abort()
    clearInterval(this.heartbeat)
    clearTimeout(this.handshake)
    this.clearDeadline()
    this.provider.terminate()
    this.socket.terminate()
    this.onClose()
  }

  /** Await outstanding prompt admission after cancellation during plugin unload. */
  async settled(): Promise<void> { await this.queue }
}
