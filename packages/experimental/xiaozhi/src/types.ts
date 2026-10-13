import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one cancellable synthesis across the speech-service boundary. */
export type SynthesisId = Branded<'xiaozhi-synthesis-id'>

/** Validated deployment and device bindings for the Xiaozhi gateway. */
export interface DeviceBinding {
  /** Exact Device-Id header generated from the Linux client network.mac_address setting. */
  deviceId: string
  /** Raw device token checked against the Authorization Bearer header. */
  token: string
  /** Stable Harness session identity retained across device reconnects. */
  sessionId: string
  /** Host project directory used when creating or restoring the device session. */
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
  /** Speech for pure wake admission, without a model request. @default 我在，请说。 */
  greeting: string
  /** Conversation window renewed by accepted human input or response completion. @default 60000 */
  dialogueTimeoutMs: number
  /** Time in milliseconds to retain text echo guards after transmitted audio. @default 3000 */
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
  | { type: 'error'; message: string }
