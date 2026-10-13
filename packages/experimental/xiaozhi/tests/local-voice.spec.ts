/** Real child-process readiness, failure, and shutdown tests. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { once } from 'node:events'
import { startLocalVoice } from '../src/local-voice.ts'
import type { LocalVoiceConfig } from '../src/types.ts'
const config: LocalVoiceConfig = {
  cwd: fileURLToPath(new URL('./fixtures/', import.meta.url)), command: process.execPath,
  args: ['local-voice.mjs'], startupTimeoutMs: 2000, shutdownTimeoutMs: 1000,
}
it('publishes an authenticated loopback endpoint and awaits idempotent shutdown', async () => {
  let exited = false
  const worker = await startLocalVoice(config, () => { exited = true })
  const socket = new WebSocket(worker.url, { headers: { Authorization: `Bearer ${worker.token}` } })
  try {
    await once(socket, 'open')
    const message = new Promise<string>((resolve) => {
      socket.once('message', (data) => {
        const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        resolve(frame.toString('utf8'))
      })
    })
    socket.send(JSON.stringify({ type: 'hello' }))
    const data = await message
    expect(JSON.parse(data)).toEqual({ type: 'ready' })
  } finally {
    socket.terminate()
    await worker.dispose()
    await worker.dispose()
  }
  expect(exited).toBe(false)
  const probe = new WebSocket(worker.url)
  await expect(once(probe, 'open')).rejects.toThrow()
})
it('rejects failed startup without publishing an endpoint', async () => {
  await expect(startLocalVoice({ ...config, args: ['--eval', 'process.exit(1)'] }, () => {}))
    .rejects.toThrow('before readiness')
})
it('bounds startup and forcibly stops an unresponsive child', async () => {
  await expect(startLocalVoice({ ...config, args: ['--eval', 'setInterval(() => {}, 100)'], startupTimeoutMs: 100, shutdownTimeoutMs: 100 }, () => {}))
    .rejects.toThrow('startup timed out')
})
it('does not accept arbitrary child output as readiness', async () => {
  await expect(startLocalVoice({ ...config, args: ['--eval', 'console.log("bad");setInterval(() => {}, 100)'], shutdownTimeoutMs: 100 }, () => {}))
    .rejects.toThrow('invalid speech worker readiness')
})

it('reports unexpected worker exit and settles subsequent disposal', async () => {
  let exits = 0
  const worker = await startLocalVoice(config, () => { exits++ })
  const socket = new WebSocket(worker.url, { headers: { Authorization: `Bearer ${worker.token}` } })
  try {
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'crash' }))
    await expect.poll(() => exits).toBe(1)
  } finally {
    socket.terminate()
    await worker.dispose()
  }
})
it('contains executable spawn errors and releases startup waiters', async () => {
  await expect(startLocalVoice({ ...config, command: '/missing-xiaozhi-python' }, () => {}))
    .rejects.toThrow('could not start')
})
