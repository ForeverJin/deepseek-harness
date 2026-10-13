/** Optional authenticated Xiaozhi WebSocket gateway for a Harness web profile. */
import { timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session'
import { WebSocketServer } from 'ws'
import { DeviceConnection } from './connection.ts'
import { startLocalVoice } from './local-voice.ts'
import { normalize } from './wakeup.ts'
import type { GatewayConfig } from './types.ts'
export type { GatewayConfig, DeviceBinding } from './types.ts'

export const name = 'xiaozhi'
export const inject = ['webServer', 'sessionController', 'sessions', 'agents']
/** Deployment-owned tunables; invalid bindings fail before any route is mounted. */
export const Config: z<GatewayConfig> = z.object({
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
  stopWords: z.array(z.string()).default(['停止', '停一下', '别说了']),
  cancelWords: z.array(z.string()).default(['停止执行']),
  greeting: z.string().default('我在，请说。'),
  dialogueTimeoutMs: z.number().default(60000),
  echoGuardMs: z.number().default(3000),
  heartbeatMs: z.number().default(20000),
  handshakeTimeoutMs: z.number().default(10000),
  operationTimeoutMs: z.number().default(180000),
  maxPayloadBytes: z.number().default(65536),
  maxBufferedBytes: z.number().default(262144),
  maxTextChars: z.number().default(12000),
  allowBargeIn: z.boolean().default(true),
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
  for (const words of [config.wakeWords, config.stopWords, config.cancelWords]) {
    if (words.length === 0 || words.some(word => !normalize(word))) throw new Error('xiaozhi: wake and stop words must be nonempty')
  }
  for (const value of [config.dialogueTimeoutMs, config.echoGuardMs, config.heartbeatMs, config.handshakeTimeoutMs,
    config.operationTimeoutMs, config.maxPayloadBytes, config.maxBufferedBytes, config.maxTextChars]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('xiaozhi: limits must be positive bounded integers')
  }
  if (config.greeting.length > config.maxTextChars || config.maxPayloadBytes > config.maxBufferedBytes) throw new Error('xiaozhi: inconsistent limits')
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
  ctx.effect(() => async () => {
    disposed = true
    for (const connection of [...connections.values()]) connection.dispose()
    await Promise.all(pending)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }, 'xiaozhi: connections')
}
