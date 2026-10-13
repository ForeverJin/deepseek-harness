/** Scripted speech worker using the same readiness and parent-pipe lifecycle. */
import { WebSocketServer } from 'ws'
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
server.on('listening', () => {
  const address = server.address()
  process.stdout.write(JSON.stringify({ type: 'xiaozhi_voice_ready', port: address.port }) + '\n')
})
server.on('connection', (socket, request) => {
  if (request.headers.authorization !== `Bearer ${process.env.VOICE_TOKEN}`) { socket.terminate(); return }
  socket.on('message', data => {
    const value = JSON.parse(data.toString())
    if (value.type === 'crash') process.exit(1)
    if (value.type === 'hello') socket.send(JSON.stringify({ type: 'ready' }))
    if (value.type === 'synthesize') {
      socket.send(JSON.stringify({ type: 'tts', state: 'start', id: value.id }))
      socket.send(JSON.stringify({ type: 'tts', state: 'stop', id: value.id }))
    }
  })
})
process.stdin.resume()
process.stdin.on('end', () => {
  for (const socket of server.clients) socket.terminate()
  server.close()
})
