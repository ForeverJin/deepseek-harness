/** Real Loader, AgentLoop and SessionController with scripted external speech/model providers. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import yaml from 'js-yaml'
import * as Xiaozhi from '../src/index.ts'
import { decodeAudio, encodeAudio } from '../src/protocol.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const hello = { type: 'hello', version: 3, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }
async function fixture(script: ConstructorParameters<typeof MockAdapter>[0], local = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-xiaozhi-'))
  const voice = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(voice, 'listening')
  const address = voice.address()
  if (typeof address !== 'object' || address === null) throw new Error('Missing voice test port')
  const syntheses: { id: string; text: string; socket: WebSocket }[] = [], cancellations: string[] = [], uplink: Buffer[] = []
  const configures: Record<string, unknown>[] = []
  voice.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer voice-secret')
    let epoch = 0
    socket.on('message', (data, binary) => {
      const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (binary) {
        uplink.push(frame)
        socket.send(JSON.stringify({ type: 'transcript', epoch, text: '小智小智，语音请求' }))
        return
      }
      const message = JSON.parse(frame.toString('utf8')) as Record<string, unknown>
      if (message.type === 'configure') configures.push(message)
      if (message.type === 'hello') socket.send(JSON.stringify({ type: 'ready' }))
      if (message.type === 'listen' && message.state === 'start' && typeof message.epoch === 'number') epoch = message.epoch
      if (message.type === 'cancel' && typeof message.id === 'string') cancellations.push(message.id)
      if (message.type === 'synthesize' && typeof message.id === 'string' && typeof message.text === 'string') {
        syntheses.push({ id: message.id, text: message.text, socket })
        socket.send(JSON.stringify({ type: 'tts', state: 'start', id: message.id }))
        socket.send(Buffer.concat([Buffer.from(message.id), Buffer.from([0xf8, 0x12])]))
        if (message.text !== '长回答') socket.send(JSON.stringify({ type: 'tts', state: 'stop', id: message.id }))
      }
    })
  })
  const ctx = new Context(), adapter = new MockAdapter(script)
  adapter.listModels = async () => [{ provider: 'mock', id: 'mock', name: 'mock' }]
  const services = { inject: ['agents', 'agentLoop', 'llm', 'sessions', 'sessionProjections'], async apply(scope: Context) {
    scope.effect(() => scope.llm.registerAdapter(['mock'], adapter), 'xiaozhi test model')
    createSessionTestController(scope, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: directory })
    await scope.agents.create({ sessionId: SessionId('voice-device'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: directory } })
  } }
  const rows = yaml.load(readFileSync(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')) as EntryOptions[]
  rows.push({ id: 'voice', name: 'cordis:xiaozhi', config: {
    voiceUrl: `ws://127.0.0.1:${address.port}/voice`, voiceToken: 'voice-secret', dialogueTimeoutMs: 1000,
    devices: [{ deviceId: 'linux-mic', token: 'device-secret', sessionId: 'voice-device', cwd: directory }],
    asrProvider: 'minimax', minimaxTtsVoice: 'male-qn-qingse',
  } })
  if (local) {
    const row = rows.at(-1)!
    row.config = { devices: [{ deviceId: 'linux-mic', token: 'device-secret', sessionId: 'voice-device', cwd: directory }],
      localService: { cwd: fileURLToPath(new URL('./fixtures/', import.meta.url)),
        command: process.execPath, args: ['local-voice.mjs'], startupTimeoutMs: 3000, shutdownTimeoutMs: 1000 } }
  }
  const configFile = join(directory, 'cordis.yml')
  writeFileSync(configFile, yaml.dump(rows))
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { sessions: SessionStore, agents: AgentRegistry, loop: AgentLoop,
    llm: LlmRuntime, system: SystemPrompt, tools: ToolRuntime, projections: SessionProjectionRegistry,
    web: WebServer, fixture: services, xiaozhi: Xiaozhi })
  await ctx.loader.root.update(yaml.load(readFileSync(configFile, 'utf8')) as EntryOptions[])
  await ctx.loader.await()
  expect(ctx.get('sessionController')).toBeDefined()
  const url = `ws://127.0.0.1:${ctx.webServer.port}/xiaozhi/v1`
  async function connect(token = 'device-secret') {
    const socket = new WebSocket(url, { headers: { 'Device-Id': 'linux-mic', Authorization: `Bearer ${token}` } })
    const controls: Record<string, unknown>[] = [], audio: Buffer[] = []
    socket.on('message', (data, binary) => {
      const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (binary) audio.push(frame)
      else controls.push(JSON.parse(frame.toString('utf8')) as Record<string, unknown>)
    })
    await once(socket, 'open')
    socket.send(JSON.stringify(hello))
    await expect.poll(() => controls.some(message => message.type === 'hello')).toBe(true)
    return { socket, controls, audio, send(value: object) { socket.send(JSON.stringify(value)) },
      async stopped(count = 1) { await expect.poll(() => controls.filter(message => message.type === 'tts' && message.state === 'stop').length).toBeGreaterThanOrEqual(count) } }
  }
  return {
    ctx, adapter, syntheses, cancellations, uplink, configures, url, connect, voiceConnections: () => voice.clients.size,
    async close() {
      await ctx.fiber.dispose()
      for (const socket of voice.clients) socket.terminate()
      await new Promise<void>((resolve) => { voice.close(() => { resolve() }) })
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

it('gates wake, records real prompts and committed replies, and requires wake after reconnect', async () => {
  const app = await fixture([textResponse('第一回答'), textResponse('第二回答')])
  try {
    const client = await app.connect()
    // Voice dialogue phases published for desktop companions.
    const phases: string[] = []
    // The event declaration lives in src/connection.ts; the aggregate test program does not
    // see that interface merge, so assert the name and keep the payload typed here.
    app.ctx.on('xiaozhi/voice-phase' as never, ((_session: SessionId, phase: string) => phases.push(phase)) as never)
    // Non-empty overrides reach the speech service as one configure right after the gateway hello.
    await expect.poll(() => app.configures.length).toBeGreaterThanOrEqual(1)
    expect(app.configures[0]).toEqual({
      type: 'configure', minimax: {}, asr: { provider: 'minimax' }, tts: { minimax_voice: 'male-qn-qingse' },
      wake: { words: '小智小智' },
    })
    client.send({ type: 'listen', state: 'start', mode: 'auto' })
    client.send({ type: 'listen', state: 'stop' })
    client.send({ type: 'listen', state: 'detect', text: '背景谈话' })
    client.send({ type: 'listen', state: 'detect', text: '小智小智' })
    await client.stopped()
    expect(app.adapter.requests).toHaveLength(0)
    expect(app.syntheses[0]?.text).toBe('嗯')
    client.send({ type: 'listen', state: 'detect', text: '查看目录' })
    await client.stopped(2)
    expect(app.adapter.requests).toHaveLength(1)
    const session = app.ctx.sessions.get(SessionId('voice-device'))!
    expect(session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.content))
      .toEqual([[{ type: 'text', text: '查看目录' }]])
    expect(app.syntheses[1]?.text).toBe('第一回答')
    expect(phases).toEqual(['listening', 'idle', 'speaking', 'idle', 'thinking', 'speaking', 'idle'])
    expect(decodeAudio(client.audio[0]!, 3)).toEqual(Buffer.from([0xf8, 0x12]))
    client.socket.close()
    await once(client.socket, 'close')
    await expect.poll(() => app.voiceConnections()).toBe(0)
    const reconnect = await app.connect()
    reconnect.send({ type: 'listen', state: 'detect', text: '继续' })
    reconnect.send({ type: 'listen', state: 'detect', text: '小智小智，第二个请求' })
    await reconnect.stopped()
    expect(app.adapter.requests).toHaveLength(2)
    expect(app.syntheses[2]?.text).toBe('第二回答')
    expect(session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' || event.type === 'assistant/message'
        ? [{ role: event.type, text: (event.type === 'user/message' ? event.data.content : event.data.message.content)
          .filter(block => block.type === 'text').map(block => block.text).join('') }] : [],
    )).toMatchInlineSnapshot(`
[
  {
    "role": "user/message",
    "text": "查看目录",
  },
  {
    "role": "assistant/message",
    "text": "第一回答",
  },
  {
    "role": "user/message",
    "text": "第二个请求",
  },
  {
    "role": "assistant/message",
    "text": "第二回答",
  },
]
`)
    expect(session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(2)
  } finally { await app.close() }
})

it('keeps a leading emoji for the client transcript while synthesizing without it', async () => {
  const app = await fixture([textResponse('😄好呀，这就来。')])
  try {
    const client = await app.connect()
    client.send({ type: 'listen', state: 'detect', text: '小智小智，讲个笑话' })
    await client.stopped(2)
    // The first sentence also breaks at its comma (official first-sentence
    // pacing) so the opening words synthesize before a full stop exists.
    expect(app.syntheses.map(item => item.text)).toEqual(['好呀，', '这就来。'])
    expect(client.controls.filter(message => message.type === 'tts' && message.state === 'sentence_start').map(message => message.text))
      .toEqual(['😄好呀，', '这就来。'])
  } finally { await app.close() }
})

it('forwards Opus and discards late cancelled playback packets', async () => {
  const app = await fixture([textResponse('长回答')])
  try {
    const client = await app.connect()
    client.send({ type: 'listen', state: 'start', mode: 'auto' })
    client.socket.send(encodeAudio(Buffer.from([0xf8, 0x34]), 3))
    await expect.poll(() => app.syntheses.length).toBe(1)
    await expect.poll(() => client.audio.length).toBe(1)
    expect(app.uplink[0]).toEqual(Buffer.from([0xf8, 0x34]))
    client.send({ type: 'listen', state: 'detect', text: '停止' })
    await client.stopped()
    await expect.poll(() => app.cancellations.length).toBe(1)
    const old = app.syntheses[0]!
    old.socket.send(Buffer.concat([Buffer.from(old.id), Buffer.from([0xf8, 0x77])]))
    old.socket.send(JSON.stringify({ type: 'tts', state: 'stop', id: old.id }))
    client.send({ type: 'ping' })
    await expect.poll(() => client.controls.some(message => message.type === 'pong')).toBe(true)
    expect(client.audio).toHaveLength(1)
  } finally { await app.close() }
})

it('cancels a generating Agent and removes its route on unload', async () => {
  const app = await fixture(['hang'])
  try {
    const client = await app.connect()
    client.send({ type: 'listen', state: 'detect', text: '小智小智，开始工作' })
    await expect.poll(() => app.adapter.requests.length).toBe(1)
    client.send({ type: 'abort' })
    await client.stopped()
    await expect.poll(() => app.ctx.agents.get(SessionId('voice-device'))?.status).toBe('idle')
    expect(app.syntheses).toHaveLength(0)
    const closed = once(client.socket, 'close')
    await app.ctx.loader.resolve('voice').fiber?.dispose()
    await closed
    const socket = new WebSocket(app.url)
    const failure = await new Promise<Error>((resolve) => { socket.once('error', resolve) })
    expect(failure.message).toMatch(/socket hang up|Unexpected server response/)
    socket.terminate()
  } finally { await app.close() }
})

it('rejects a wrong device token before upgrading the connection', async () => {
  const app = await fixture([])
  try {
    const socket = new WebSocket(app.url, { headers: { 'Device-Id': 'linux-mic', Authorization: 'Bearer wrong' } })
    socket.on('error', () => {})
    const response = await new Promise<IncomingMessage>((resolve) => {
      socket.once('unexpected-response', (_request, value) => { resolve(value) })
    })
    expect(response.statusCode).toBe(401)
    socket.terminate()
  } finally { await app.close() }
})

it('stops speech without cancelling work until the explicit execution stop', async () => {
  const app = await fixture(['hang'])
  try {
    const client = await app.connect()
    client.send({ type: 'listen', state: 'detect', text: '小智小智，开始工作' })
    await expect.poll(() => app.adapter.requests.length).toBe(1)
    client.send({ type: 'listen', state: 'detect', text: '停止' })
    await client.stopped()
    expect(app.ctx.agents.get(SessionId('voice-device'))?.status).toBe('running')
    client.send({ type: 'listen', state: 'detect', text: '停止执行' })
    await client.stopped(2)
    await expect.poll(() => app.ctx.agents.get(SessionId('voice-device'))?.status).toBe('idle')
    expect(app.syntheses).toHaveLength(0)
  } finally { await app.close() }
})

it('reports malformed audio through the Linux alert protocol before disconnecting', async () => {
  const app = await fixture([])
  try {
    const client = await app.connect()
    const closed = once(client.socket, 'close')
    client.send({ type: 'listen', state: 'start', mode: 'auto' })
    client.socket.send(Buffer.alloc(4))
    await closed
    expect(client.controls.find(message => message.type === 'alert')).toMatchObject({
      status: 'error', message: '语音连接失败，请重新连接。', emotion: 'sad',
    })
    expect(app.adapter.requests).toHaveLength(0)
  } finally { await app.close() }
})

it('removes its queued prompt without cancelling another active user turn', async () => {
  const app = await fixture(['hang'])
  try {
    const client = await app.connect()
    const agent = app.ctx.agents.get(SessionId('voice-device'))!
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'another user task' }], source: { kind: 'user' } }))
    await expect.poll(() => app.adapter.requests.length).toBe(1)
    client.send({ type: 'listen', state: 'detect', text: '小智小智，排队语音任务' })
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(1)
    client.send({ type: 'abort' })
    await client.stopped()
    await expect.poll(() => agent.inbox.nextTurn.length).toBe(0)
    expect(agent.status).toBe('running')
    expect(app.adapter.requests).toHaveLength(1)
    app.ctx.sessionController.cancel({ sessionId: agent.id })
    await expect.poll(() => agent.status).toBe('idle')
    expect(app.syntheses).toHaveLength(0)
  } finally { await app.close() }
})

it('cancels an owned claim during pre-step admission before invoking the model', async () => {
  const app = await fixture([])
  try {
    let entered = false
    app.ctx.on('agent/pre-step', async ({ signal }, next) => {
      entered = true
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return next()
    })
    const client = await app.connect()
    client.send({ type: 'listen', state: 'detect', text: '小智小智，取消准备中的请求' })
    await expect.poll(() => entered).toBe(true)
    client.send({ type: 'abort' })
    await client.stopped()
    await expect.poll(() => app.ctx.agents.get(SessionId('voice-device'))?.status).toBe('idle')
    expect(app.adapter.requests).toHaveLength(0)
    expect(app.syntheses).toHaveLength(0)
  } finally { await app.close() }
})

it('loads an owned speech worker through Loader and releases its endpoint on unload', async () => {
  const app = await fixture([textResponse('本地服务回答')], true)
  try {
    const client = await app.connect()
    client.send({ type: 'listen', state: 'detect', text: '小智小智，查看目录' })
    await client.stopped()
    expect(app.adapter.requests).toHaveLength(1)
    expect(client.controls.filter(message => message.type === 'tts' && message.state === 'sentence_start').map(message => message.text))
      .toEqual(['本地服务回答'])
  } finally { await app.close() }
  const probe = new WebSocket(app.url)
  await expect(once(probe, 'open')).rejects.toThrow()
})
