/** Optional authenticated Xiaozhi WebSocket gateway for a Harness web profile. */
import { timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { WebSocketServer } from 'ws'
import { DeviceConnection } from './connection.ts'
import { startLocalVoice } from './local-voice.ts'
import { DEFAULT_PERSONA, registerPersona } from './persona.ts'
import { normalize } from './wakeup.ts'
import type { GatewayConfig } from './types.ts'
export type { GatewayConfig, DeviceBinding } from './types.ts'

export const name = 'xiaozhi'
export const inject = ['webServer', 'sessionController', 'sessions', 'agents']

/** Empty string or a bounded token without whitespace, for model/voice/key-style overrides. */
const overrideToken = /^(?:|\S{1,128})$/
/** Empty string or an http(s) URL, for the MiniMax API root. */
const httpUrl = /^(?:|https?:\/\/\S{1,2040})$/
/** Empty string or a WebSocket URL, for the FunASR endpoint. */
const wsUrl = /^(?:|wss?:\/\/\S{1,2040})$/

/** Deployment-owned tunables; invalid bindings fail before any route is mounted. */
export const Config = z.object({
  path: z.string().default('/xiaozhi/v1'),
  voiceUrl: z.string().default(''),
  voiceToken: z.string().default(''),
  localService: z.object({
    cwd: z.string().required(), command: z.string().default('python'),
    args: z.array(z.string()).default(['-m', 'xiaozhi_voice.server', '--managed']),
    startupTimeoutMs: z.number().default(15000), shutdownTimeoutMs: z.number().default(5000),
  }).default(undefined as never),
  devices: z.array(z.object({
    deviceId: z.string().required(), token: z.string().required(), sessionId: z.string().required(),
    cwd: z.string(), agentPreset: z.string(),
  })).required(),
  wakeWords: z.array(z.string()).default(['小智小智']),
  // The spoken stop vocabulary mirrors the official server's STOP_COMMANDS:
  // exact full-phrase matches after normalization, so single syllables like
  // 停 only trigger when the whole transcript is that word.
  stopWords: z.array(z.string()).default([
    '停', '停止', '停下', '停下来', '停一下', '停止一下', '暂停', '暂停一下',
    '别说了', '别说', '不要说', '不要说了', '闭嘴', '打住', '住口',
    '停止播放', '暂停播放', '停止播报', '暂停播报',
    '请停止', '请停一下', '请别说了', '请不要说了',
  ]),
  cancelWords: z.array(z.string()).default(['停止执行']),
  // One syllable of acknowledgement: the user hears the wake landed without a
  // full greeting sentence stalling the next utterance (with client barge-in
  // the microphone stays open even while it plays).
  greeting: z.string().default('嗯'),
  // Official close_connection_no_voice_time pacing: say goodbye once after
  // this much admitted-input silence, then hang; the device reconnects asleep.
  idleFarewellMs: z.number().default(120000),
  farewell: z.string().default('时间过得真快，先聊到这里，想聊随时叫我哦。'),
  // Whole-utterance goodbyes end the dialogue: goodbye reply, connection hang,
  // device reconnects asleep waiting for the wake word (official exit_commands).
  exitWords: z.array(z.string()).default(['再见', '拜拜', '晚安', '下次见', '回头见']),
  goodbye: z.string().default('好的，下次再聊，想聊随时叫我哦。'),
  dialogueTimeoutMs: z.number().default(60000),
  echoGuardMs: z.number().default(5000),
  heartbeatMs: z.number().default(20000),
  handshakeTimeoutMs: z.number().default(10000),
  operationTimeoutMs: z.number().default(180000),
  maxPayloadBytes: z.number().default(65536),
  maxBufferedBytes: z.number().default(262144),
  maxTextChars: z.number().default(12000),
  allowBargeIn: z.boolean().default(true),
  // Speech-backend overrides pushed to the speech service; empty inherits its environment.
  asrProvider: z.union(['', 'funasr', 'minimax', 'sherpa']).default('').volatile(),
  funasrUrl: z.string().pattern(wsUrl).default('').volatile(),
  minimaxAsrModel: z.string().pattern(overrideToken).default('').volatile(),
  minimaxAsrLanguage: z.string().pattern(overrideToken).default('').volatile(),
  ttsProvider: z.union(['', 'edge', 'minimax']).default('').volatile(),
  edgeVoice: z.string().pattern(overrideToken).default('').volatile(),
  minimaxTtsModel: z.string().pattern(overrideToken).default('').volatile(),
  minimaxTtsVoice: z.string().pattern(overrideToken).default('').volatile(),
  minimaxApiKey: z.string().role('secret').pattern(overrideToken).default('').volatile(),
  minimaxBaseUrl: z.string().pattern(httpUrl).default('').volatile(),
  minimaxGroupId: z.string().pattern(overrideToken).default('').volatile(),
  persona: z.string().default(DEFAULT_PERSONA).volatile(),
})

function equalToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Register the gateway after its optional owned worker becomes ready.
 * @param ctx - Profile context supplying the injected Harness services.
 * @param config - Resolved device and speech deployment configuration.
 * @returns Readiness after the device upgrade route is registered.
 */
export async function apply(ctx: Context, config: GatewayConfig): Promise<void> {
  // The browser half serves a hand-written Plugins-page form for the
  // `xiaozhi-voice` namespace, so the settings service must not offer an
  // auto-generated one beside it.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // The voice persona: one prompt variable plus the `xiaozhi` agent preset.
  // Optional injection keeps plain gateways serving devices bound to other
  // presets in deployments without the prompt or preset services.
  ctx.inject(['systemPrompt', 'agentPresets'], (child) => { registerPersona(child, config) })
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(config.path)) throw new Error('xiaozhi: invalid route path')
  if (config.localService === undefined) {
    const url = new URL(config.voiceUrl)
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.username || url.password) throw new Error('xiaozhi: invalid voice URL')
    if (!config.voiceToken.trim()) throw new Error('xiaozhi: external voice token is required')
  } else if (config.voiceUrl || config.voiceToken) throw new Error('xiaozhi: localService cannot be combined with external voice credentials')
  if (config.devices.length === 0) throw new Error('xiaozhi: device bindings are required')
  const deviceIds = new Set<string>(), sessionIds = new Set<string>()
  for (const binding of config.devices) {
    if (!binding.deviceId.trim() || !binding.token.trim() || !binding.sessionId.trim()
      || deviceIds.has(binding.deviceId) || sessionIds.has(binding.sessionId)) throw new Error('xiaozhi: device and session bindings must be unique and nonempty')
    deviceIds.add(binding.deviceId)
    sessionIds.add(binding.sessionId)
  }
  for (const words of [config.wakeWords, config.stopWords, config.cancelWords, config.exitWords]) {
    if (words.length === 0 || words.some(word => !normalize(word))) throw new Error('xiaozhi: wake and stop words must be nonempty')
  }
  for (const value of [config.dialogueTimeoutMs, config.echoGuardMs, config.heartbeatMs, config.handshakeTimeoutMs,
    config.operationTimeoutMs, config.maxPayloadBytes, config.maxBufferedBytes, config.maxTextChars]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('xiaozhi: limits must be positive bounded integers')
  }
  if (config.greeting.length > config.maxTextChars || config.farewell.length > config.maxTextChars
    || config.goodbye.length > config.maxTextChars || config.maxPayloadBytes > config.maxBufferedBytes) {
    throw new Error('xiaozhi: inconsistent limits')
  }
  if (!Number.isSafeInteger(config.idleFarewellMs) || config.idleFarewellMs < 0 || config.idleFarewellMs > 2147483647) {
    throw new Error('xiaozhi: idleFarewellMs must be a nonnegative bounded integer')
  }
  let workerAvailable = true
  let voiceConfig = config
  const localService = config.localService
  if (localService !== undefined) {
    await ctx.effect(async () => {
      const worker = await startLocalVoice(localService, () => {
        workerAvailable = false
        ctx.logger.warn('xiaozhi: local speech worker exited; reload the plugin after checking dependencies')
      })
      voiceConfig = { ...config, voiceUrl: worker.url, voiceToken: worker.token }
      return worker.dispose
    }, 'xiaozhi: local speech worker')
  }
  const server = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes, perMessageDeflate: false })
  const connections = new Map<string, DeviceConnection>()
  const pending = new Set<Promise<void>>()
  let disposed = false
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: config.path,
    handler(request, socket, head) {
      if (!workerAvailable) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const id = request.headers['device-id']
      const auth = request.headers.authorization
      const binding = typeof id === 'string' ? config.devices.find(device => device.deviceId === id) : undefined
      if (disposed || binding === undefined || typeof auth !== 'string' || !equalToken(auth, `Bearer ${binding.token}`)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (connections.has(binding.deviceId)) {
        socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      server.handleUpgrade(request, socket, head, (ws) => {
        const connection = new DeviceConnection(ctx, ws, binding, voiceConfig, () => {
          connections.delete(binding.deviceId)
          const settlement = connection.settled()
          pending.add(settlement)
          void settlement.finally(() => pending.delete(settlement))
        })
        connections.set(binding.deviceId, connection)
      })
    },
  }), 'xiaozhi: upgrade route')
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    for (const connection of connections.values()) {
      if (connection.sessionId === agent.id) connection.claimed(message, turn)
    }
  })
  ctx.on('session/event', (session, event) => {
    for (const connection of connections.values()) {
      if (connection.sessionId === session.id) connection.observe(event)
    }
  })
  // Token-level pacing: text deltas of the owned turn start sentences while
  // the model is still generating (official streaming-TTS behavior); the
  // committed-message path remains as the fallback when no frames flow.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    for (const connection of connections.values()) {
      if (connection.sessionId === agent.id) connection.streamFrame(frame)
    }
  }, { global: true })
  ctx.effect(() => async () => {
    disposed = true
    for (const connection of [...connections.values()]) connection.dispose()
    await Promise.all(pending)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }, 'xiaozhi: connections')
}
