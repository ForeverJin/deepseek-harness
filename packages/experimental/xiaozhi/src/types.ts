import type { Volatile } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one cancellable synthesis across the speech-service boundary. */
export type SynthesisId = Branded<'xiaozhi-synthesis-id'>

/** Validated deployment and device bindings for the Xiaozhi gateway. */
export interface DeviceBinding {
  /** Exact Device-Id header generated from the Linux client network.mac_address setting. */
  deviceId: string
  /** Raw device token checked against the Authorization Bearer header. */
  token: string
  /** Device protocol identity and prefix for a fresh Harness session on each wake. */
  sessionId: string
  /** Host project directory used when creating each voice dialogue. */
  cwd?: string
  /** Agent preset for the device session; omission uses the profile composition. */
  agentPreset?: string
}
/** Owned local speech process; arguments are passed directly without a shell. */
export interface LocalVoiceConfig {
  /** Absolute directory containing the installed Python speech project. */
  cwd: string
  /** Executable path; prefer the project's virtual-environment Python. @default python */
  command: string
  /** Executable arguments for the managed readiness protocol. @default [-m, xiaozhi_voice.server, --managed] */
  args: string[]
  /** Maximum wait for the worker's loopback readiness message. @default 15000 */
  startupTimeoutMs: number
  /** Grace period before forcibly killing the owned process. @default 5000 */
  shutdownTimeoutMs: number
}
/** Resolved gateway configuration supplied by the Cordis configuration schema. */
export interface GatewayConfig {
  /** Exact WebSocket upgrade pathname without a trailing slash. @default /xiaozhi/v1 */
  path: string
  /** Speech-only WebSocket service URL using the documented UUID-prefixed Opus protocol. */
  voiceUrl: string
  /** Shared token sent to the speech service in an Authorization Bearer header. */
  voiceToken: string
  /** Start and stop a local speech worker instead of connecting to an external voiceUrl. */
  localService?: LocalVoiceConfig
  /** Explicit device bindings; device identities and session identities must each be unique. */
  devices: DeviceBinding[]
  /** Accepted wake prefixes, matched longest first. @default [小智小智] */
  wakeWords: string[]
  /** Whole-utterance commands that stop or mute speech without cancelling Agent execution. */
  stopWords: string[]
  /** Whole-utterance commands that also cancel the device-owned Agent request. @default [停止执行] */
  cancelWords: string[]
  /**
   * Speech for pure wake admission, without a model request. One short
   * syllable acknowledges the wake; a full sentence stalls the next
   * utterance on half-duplex clients (microphone closes during playback).
   * @default 嗯
   */
  greeting: string
  /**
   * Speech played once after this much admitted-input silence (official
   * close_connection_no_voice_time pacing); the connection then hangs and
   * the device reconnects asleep. Zero disables the farewell.
   * @default 120000
   */
  idleFarewellMs: number
  /** The goodbye sentence spoken when `idleFarewellMs` elapses. @default 时间过得真快，先聊到这里，想聊随时叫我哦。 */
  farewell: string
  /**
   * Whole-utterance goodbyes that end the dialogue: the goodbye reply plays,
   * the connection hangs, and the device reconnects asleep waiting for the
   * wake word (official exit_commands semantics with a spoken farewell).
   * @default [再见, 拜拜, 晚安, 下次见, 回头见]
   */
  exitWords: string[]
  /** The goodbye reply spoken for `exitWords`; the connection closes after it. @default 好的，下次再聊，想聊随时叫我哦。 */
  goodbye: string
  /** Conversation window renewed by accepted human input or response completion. @default 60000 */
  dialogueTimeoutMs: number
  /** Time in milliseconds to retain text echo guards after transmitted audio. @default 5000 */
  echoGuardMs: number
  /** WebSocket Ping interval in milliseconds; a missed Pong closes the connection. @default 20000 */
  heartbeatMs: number
  /** Deadline in milliseconds for voice handshake and failure-alert flushing. @default 10000 */
  handshakeTimeoutMs: number
  /** Deadline in milliseconds for an accepted request or synthesis. @default 180000 */
  operationTimeoutMs: number
  /** Maximum bytes in one inbound WebSocket frame. @default 65536 */
  maxPayloadBytes: number
  /** Maximum queued control bytes and outbound transport backlog. @default 262144 */
  maxBufferedBytes: number
  /** Maximum admitted transcription or spoken-answer string length. @default 12000 */
  maxTextChars: number
  /** Whether new accepted requests may replace an owned request or playback. @default true */
  allowBargeIn: boolean
  /**
   * Speech-backend overrides pushed to the speech service as `configure`
   * controls; an empty string inherits the service-side environment value.
   */
  asrProvider: Volatile<string>
  /** FunASR offline WebSocket URL override; empty keeps the service environment. */
  funasrUrl: Volatile<string>
  /** MiniMax ASR model override; empty keeps the service environment. */
  minimaxAsrModel: Volatile<string>  /** MiniMax ASR BCP-47 language override; empty keeps automatic detection. */
  minimaxAsrLanguage: Volatile<string>
  /** Speech synthesis backend override; empty keeps the service environment. */
  ttsProvider: Volatile<string>
  /** Edge TTS voice override; empty keeps the service environment. */
  edgeVoice: Volatile<string>
  /** MiniMax TTS model override; empty keeps the service environment. */
  minimaxTtsModel: Volatile<string>
  /** MiniMax TTS voice override; empty keeps the service environment. */
  minimaxTtsVoice: Volatile<string>
  /** MiniMax API key override; empty keeps the service environment. */
  minimaxApiKey: Volatile<string>
  /** MiniMax API root override; empty keeps the service environment. */
  minimaxBaseUrl: Volatile<string>
  /** MiniMax GroupId override for legacy JWT keys; empty keeps the service environment. */
  minimaxGroupId: Volatile<string>
  /**
   * Role description interpolated into the voice preset's persona on every
   * prompt assembly; blank falls back to the built-in default persona.
   */
  persona: Volatile<string>
}
/** Wire payload of one `configure` control; absent fields inherit the service environment. */
export interface VoiceSettings {
  minimax: { api_key?: string; base_url?: string; group_id?: string }
  asr: { provider?: string; funasr_url?: string; minimax_model?: string; minimax_language?: string }
  tts: { provider?: string; edge_voice?: string; minimax_model?: string; minimax_voice?: string }
  wake: { words?: string }
}
/**
 * Whether a `configure` payload carries any override at all.
 * @param settings - the payload `voiceSettingsOf` produced.
 * @returns false when every section is empty, meaning the service-side environment stands.
 */
export function hasVoiceSettings(settings: VoiceSettings): boolean {
  return Object.keys(settings.minimax).length > 0
    || Object.keys(settings.asr).length > 0
    || Object.keys(settings.tts).length > 0
    || Object.keys(settings.wake).length > 0
}
/**
 * Read the current speech-backend overrides off a live gateway configuration.
 * @param config - gateway configuration whose volatile fields hold the settings-page values.
 * @returns the `configure` payload for the speech service.
 */
export function voiceSettingsOf(config: GatewayConfig): VoiceSettings {
  return {
    minimax: {
      ...(config.minimaxApiKey.get() === '' ? {} : { api_key: config.minimaxApiKey.get() }),
      ...(config.minimaxBaseUrl.get() === '' ? {} : { base_url: config.minimaxBaseUrl.get() }),
      ...(config.minimaxGroupId.get() === '' ? {} : { group_id: config.minimaxGroupId.get() }),
    },
    asr: {
      ...(config.asrProvider.get() === '' ? {} : { provider: config.asrProvider.get() }),
      ...(config.funasrUrl.get() === '' ? {} : { funasr_url: config.funasrUrl.get() }),
      ...(config.minimaxAsrModel.get() === '' ? {} : { minimax_model: config.minimaxAsrModel.get() }),
      ...(config.minimaxAsrLanguage.get() === '' ? {} : { minimax_language: config.minimaxAsrLanguage.get() }),
    },
    tts: {
      ...(config.ttsProvider.get() === '' ? {} : { provider: config.ttsProvider.get() }),
      ...(config.edgeVoice.get() === '' ? {} : { edge_voice: config.edgeVoice.get() }),
      ...(config.minimaxTtsModel.get() === '' ? {} : { minimax_model: config.minimaxTtsModel.get() }),
      ...(config.minimaxTtsVoice.get() === '' ? {} : { minimax_voice: config.minimaxTtsVoice.get() }),
    },
    wake: {
      // Comma-joined wake words for the speech service's acoustic spotter.
      ...(config.wakeWords.length === 0 ? {} : { words: config.wakeWords.join(',') }),
    },
  }
}
/** Supported Linux audio-envelope versions. */
export type ProtocolVersion = 1 | 2 | 3
/** Client-controlled utterance termination mode. */
export type ListenMode = 'auto' | 'manual' | 'realtime'
/** Supported device controls after wire validation. */
export type ClientMessage =
  | { type: 'hello'; version: ProtocolVersion }
  | { type: 'listen'; state: 'start'; mode: ListenMode }
  | { type: 'listen'; state: 'stop' }
  | { type: 'listen'; state: 'detect'; text: string }
  | { type: 'abort' } | { type: 'goodbye' } | { type: 'ping' } | { type: 'mcp' }
/** Validated controls from the speech-only service. */
export type VoiceMessage =
  | { type: 'ready' }
  | { type: 'transcript'; epoch: number; text: string }
  | { type: 'tts'; state: 'start' | 'stop'; id: SynthesisId }
  | { type: 'wake'; keyword: string }
  | { type: 'error'; message: string }
