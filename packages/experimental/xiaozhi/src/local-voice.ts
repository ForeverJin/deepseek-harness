/** Owned speech worker startup, readiness, and shutdown over a private pipe. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { LocalVoiceConfig } from './types.ts'

/**
 * Start a speech worker; publish its loopback endpoint only after readiness.
 * @param config - Explicit executable, arguments, project path, and deadlines.
 * @param onExit - Called if an established worker exits before disposal.
 * @returns The authenticated endpoint and an idempotent disposer awaiting exit.
 */
export async function startLocalVoice(
  config: LocalVoiceConfig, onExit: () => void,
): Promise<{ url: string; token: string; dispose: () => Promise<void> }> {
  if (!isAbsolute(config.cwd) || !config.command.trim()
    || !config.args.length || config.args.some(arg => typeof arg !== 'string')
    || [config.startupTimeoutMs, config.shutdownTimeoutMs]
      .some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2147483647)) {
    throw new Error('xiaozhi: invalid local speech worker configuration')
  }
  const token = randomUUID()
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|HOME|USERPROFILE|TEMP|TMP|LANG|LC_.*|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)
      || /^(VOICE_|VAD_|ECHO_|FUNASR_|MINIMAX_|ASR_|TTS_|FFMPEG$)/.test(key)) env[key] = value
  }
  Object.assign(env, { VOICE_TOKEN: token, VOICE_HOST: '127.0.0.1', VOICE_PORT: '0', PYTHONUNBUFFERED: '1' })
  const child = spawn(config.command, config.args, { cwd: config.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // The worker's stderr carries its diagnostics (Silero fallback, echo-guard
  // drops) as numbers-only lines; surface them on the host's stderr so
  // silent audio drops are diagnosable from the harness log.
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })
  // Parent pipe closure asks Python to stop; no credentials travel in argv or logs.
  child.stdin.on('error', () => { /* A worker exiting first may close stdin. Exit is observed below. */ })
  let closed = false, disposed = false, established = false
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  let rejectReady: (error: Error) => void = () => {}
  child.once('error', () => {
    rejectReady(new Error('xiaozhi: speech worker could not start; check executable and dependencies'))
  })
  child.once('close', () => {
    closed = true
    finish()
    rejectReady(new Error('xiaozhi: speech worker exited before readiness; check speech backend and native dependencies'))
    if (established && !disposed) onExit()
  })
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (stopping !== undefined) return stopping
    disposed = true
    stopping = (async () => {
      if (closed) return
      child.stdin.end()
      const kill = setTimeout(() => { child.kill('SIGKILL') }, config.shutdownTimeoutMs)
      try { await done } finally { clearTimeout(kill) }
    })()
    return stopping
  }
  let buffer = ''
  try {
    const port = await new Promise<number>((resolve, reject) => {
      rejectReady = reject
      const timeout = setTimeout(() => { reject(new Error('xiaozhi: speech worker startup timed out')) }, config.startupTimeoutMs)
      const receive = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (Buffer.byteLength(buffer) > 4096) { reject(new Error('xiaozhi: invalid speech worker readiness')); return }
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const value: unknown = JSON.parse(buffer.slice(0, newline))
          if (value === null || typeof value !== 'object' || !('type' in value) || !('port' in value)
            || value.type !== 'xiaozhi_voice_ready' || typeof value.port !== 'number'
            || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Invalid readiness')
          resolve(value.port)
        } catch { reject(new Error('xiaozhi: invalid speech worker readiness')) }
      }
      child.stdout.on('data', receive)
      void done.finally(() => { clearTimeout(timeout) })
      // Remove startup-only listeners as soon as either outcome settles.
      const clean = () => { clearTimeout(timeout); child.stdout.off('data', receive) }
      const originalResolve = resolve, originalReject = reject
      resolve = (value) => { clean(); originalResolve(value) }
      reject = (error) => { clean(); originalReject(error) }
      rejectReady = reject
    })
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('xiaozhi: speech worker exited during startup')
    established = true
    return { url: `ws://127.0.0.1:${port}/voice`, token, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
