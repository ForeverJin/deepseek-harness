/** Xiaozhi wire parsing; binary header integers are network byte order. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SynthesisId } from './types.ts'
import type { ClientMessage, ProtocolVersion, VoiceMessage } from './types.ts'
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
/**
 * Decode client controls and enforce the current Linux audio contract.
 * @param text - UTF-8 JSON text from one device control frame.
 * @param maxTextChars - Maximum admitted detect-text length.
 * @returns The validated supported control; malformed controls throw.
 */
export function parseClient(text: string, maxTextChars: number): ClientMessage {
  const value = object(JSON.parse(text))
  switch (value.type) {
    case 'hello': {
      const version = value.version
      if (version !== 1 && version !== 2 && version !== 3) throw new Error('Unsupported protocol version')
      const audio = object(value.audio_params)
      if (value.transport !== 'websocket' || audio.format !== 'opus' || audio.sample_rate !== 16000
        || audio.channels !== 1 || audio.frame_duration !== 60) throw new Error('Expected mono Opus at 16kHz with 60ms frames')
      return { type: 'hello', version }
    }
    case 'listen':
      if (value.state === 'stop') return { type: 'listen', state: 'stop' }
      if (value.state === 'start' && (value.mode === 'auto' || value.mode === 'manual' || value.mode === 'realtime')) {
        return { type: 'listen', state: 'start', mode: value.mode }
      }
      if (value.state === 'detect' && typeof value.text === 'string' && value.text.length <= maxTextChars) {
        return { type: 'listen', state: 'detect', text: value.text }
      }
      throw new Error('Invalid listen control')
    case 'abort': return { type: 'abort' }
    case 'goodbye': return { type: 'goodbye' }
    case 'ping': return { type: 'ping' }
    case 'mcp': return { type: 'mcp' }
    default: throw new Error('Unsupported message type')
  }
}
/**
 * Validate voice-service controls before they affect conversation state.
 * @param text - UTF-8 JSON text from the speech service.
 * @param maxTextChars - Maximum final transcription length.
 * @returns The validated service control; malformed controls throw.
 */
export function parseVoice(text: string, maxTextChars: number): VoiceMessage {
  const value = object(JSON.parse(text))
  if (value.type === 'ready') return { type: 'ready' }
  if (value.type === 'transcript' && typeof value.epoch === 'number' && Number.isSafeInteger(value.epoch)
    && value.epoch >= 0 && typeof value.text === 'string' && value.text.length <= maxTextChars) {
    return { type: 'transcript', epoch: value.epoch, text: value.text }
  }
  if (value.type === 'tts' && (value.state === 'start' || value.state === 'stop') && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id)) {
    return { type: 'tts', state: value.state, id: brandString<SynthesisId>(value.id) }
  }
  if (value.type === 'error' && typeof value.message === 'string') return { type: 'error', message: value.message }
  throw new Error('Invalid voice-service message')
}
/**
 * Strip and validate one protocol 1, 2, or 3 audio envelope.
 * @param frame - Complete binary device frame.
 * @param version - Envelope version negotiated during hello.
 * @returns A shared view of the raw Opus payload; malformed envelopes throw.
 */
export function decodeAudio(frame: Buffer, version: ProtocolVersion): Buffer {
  const size = version === 1 ? 0 : version === 2 ? 16 : 4
  if (frame.length <= size) throw new Error('Empty or truncated Opus frame')
  if (version === 2 && (frame.readUInt16BE(0) !== 2 || frame.readUInt16BE(2) !== 0
    || frame.readUInt32BE(4) !== 0 || frame.readUInt32BE(12) !== frame.length - size)) throw new Error('Invalid v2 audio header')
  if (version === 3 && (frame[0] !== 0 || frame[1] !== 0 || frame.readUInt16BE(2) !== frame.length - size)) {
    throw new Error('Invalid v3 audio header')
  }
  return frame.subarray(size)
}
/**
 * Wrap one Opus packet in the negotiated Linux client protocol.
 * @param packet - Nonempty raw Opus packet.
 * @param version - Envelope version negotiated during hello.
 * @returns The original packet for v1, or a wrapped copy for v2/v3.
 */
export function encodeAudio(packet: Buffer, version: ProtocolVersion): Buffer {
  if (packet.length === 0 || packet.length > 65535) throw new Error('Invalid Opus packet length')
  if (version === 1) return packet
  const header = Buffer.alloc(version === 2 ? 16 : 4)
  if (version === 2) {
    header.writeUInt16BE(2, 0)
    header.writeUInt32BE(packet.length, 12)
  } else header.writeUInt16BE(packet.length, 2)
  return Buffer.concat([header, packet])
}
