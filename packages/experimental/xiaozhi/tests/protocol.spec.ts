import { describe, expect, it } from 'vitest'
import { decodeAudio, encodeAudio, parseClient, parseVoice } from '../src/protocol.ts'
import { voiceSettingsOf } from '../src/types.ts'
import { WakeGate, speechSynthesisText, speechText } from '../src/wakeup.ts'

const hello = { type: 'hello', transport: 'websocket', version: 3, audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }

describe('Xiaozhi audio protocol', () => {
  it.each([1, 2, 3] as const)('round trips protocol %s frames', (version) => {
    const packet = Buffer.from([0xf8, 0x12, 0x34])
    expect(decodeAudio(encodeAudio(packet, version), version)).toEqual(packet)
  })
  it('rejects truncated and mismatched frame envelopes', () => {
    for (const version of [1, 2, 3] as const) expect(() => decodeAudio(Buffer.alloc(0), version)).toThrow()
    const frame = encodeAudio(Buffer.from([1]), 3)
    frame.writeUInt16BE(20, 2)
    expect(() => decodeAudio(frame, 3)).toThrow()
    expect(() => decodeAudio(Buffer.alloc(16), 2)).toThrow()
  })
  it('validates handshake formats and final transcript bounds', () => {
    expect(parseClient(JSON.stringify(hello), 10)).toEqual({ type: 'hello', version: 3 })
    expect(() => parseClient(JSON.stringify({ ...hello, version: 4 }), 10)).toThrow()
    expect(() => parseClient(JSON.stringify({ ...hello, audio_params: { ...hello.audio_params, sample_rate: 24000 } }), 10)).toThrow()
    expect(() => parseVoice(JSON.stringify({ type: 'transcript', epoch: -1, text: 'a' }), 10)).toThrow()
    expect(() => parseVoice(JSON.stringify({ type: 'transcript', epoch: 1, text: 'a'.repeat(11) }), 10)).toThrow()
  })
  it('accepts acoustic wake hits and rejects malformed ones', () => {
    expect(parseVoice(JSON.stringify({ type: 'wake', keyword: '小智' }), 10)).toEqual({ type: 'wake', keyword: '小智' })
    expect(() => parseVoice(JSON.stringify({ type: 'wake', keyword: '' }), 10)).toThrow()
    expect(() => parseVoice(JSON.stringify({ type: 'wake' }), 10)).toThrow()
    expect(() => parseVoice(JSON.stringify({ type: 'wake', keyword: 'x'.repeat(11) }), 10)).toThrow()
  })
  it('carries configured wake words into the configure payload', () => {
    const config = {
      minimaxApiKey: { get: () => '' }, minimaxBaseUrl: { get: () => '' }, minimaxGroupId: { get: () => '' },
      asrProvider: { get: () => '' }, funasrUrl: { get: () => '' }, minimaxAsrModel: { get: () => '' }, minimaxAsrLanguage: { get: () => '' },
      ttsProvider: { get: () => '' }, edgeVoice: { get: () => '' }, minimaxTtsModel: { get: () => '' }, minimaxTtsVoice: { get: () => '' },
      wakeWords: ['小智', '你好小智'],
    } as unknown as import('../src/types.ts').GatewayConfig
    expect(voiceSettingsOf(config).wake).toEqual({ words: '小智,你好小智' })
  })
})

describe('Wake admission', () => {
  const gate = () => new WakeGate(['小智小智'], ['停止', '停止执行'], 1000, 300, ['停止执行'])
  it('ignores ambient speech and opens a window on pure wake', () => {
    const value = gate()
    expect(value.admit('今天天气很好', 10, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('我们讨论小智小智这个词', 10, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('小智，小智！', 10, false)).toEqual({ kind: 'wake' })
    expect(value.admit('你好', 20, false)).toEqual({ kind: 'prompt', text: '你好' })
    expect(value.admit('你好', 1020, false)).toEqual({ kind: 'ignore' })
  })
  it('preserves a request following the wake prefix', () => {
    expect(gate().admit('小智小智，查看目录', 1, false)).toEqual({ kind: 'prompt', text: '查看目录' })
  })
  it('filters echo before waking and renews only accepted activity', () => {
    const value = gate()
    value.spoken('小智小智，请你说话', 1)
    expect(value.admit('小智小智', 2, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('查看目录', 3, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('小智小智', 302, false)).toEqual({ kind: 'wake' })
  })
  it('matches entire stop commands while a request is active', () => {
    const value = gate()
    expect(value.admit('停止', 1, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('停止', 1, true)).toEqual({ kind: 'stop', cancelAgent: false })
    expect(value.admit('停止执行', 1, true)).toEqual({ kind: 'stop', cancelAgent: true })
    value.resume(2000)
    expect(value.admit('继续', 2500, false)).toEqual({ kind: 'prompt', text: '继续' })
  })
  it('admits non-echo speech while busy so the user can speak over the greeting', () => {
    const value = gate()
    // A query asked while the wake greeting or an answer plays must become a prompt
    // (the connection layer barges in); only our own TTS heard back is dropped.
    expect(value.admit('今天天气怎么样', 1, true)).toEqual({ kind: 'prompt', text: '今天天气怎么样' })
    expect(value.admit('小智小智，查目录', 2, true)).toEqual({ kind: 'prompt', text: '查目录' })
  })
  it('still ignores echo of played audio while busy', () => {
    const value = gate()
    value.spoken('今天天气晴朗，降水概率仅百分之四', 1)
    expect(value.admit('今天天气晴朗，降水概率仅百分之四', 2, true)).toEqual({ kind: 'ignore' })
    expect(value.admit('降水概率仅百分之四', 3, true)).toEqual({ kind: 'ignore' })
    expect(value.admit('帮我看看别的', 4, true)).toEqual({ kind: 'prompt', text: '帮我看看别的' })
  })
  it('ignores ASR-noisy speaker echo per sentence instead of looping on it', () => {
    const value = gate()
    value.spoken('我是 MiniMax 开发的编程助手，可以帮你查看目录。还会讲解代码。', 1)
    value.resume(2)
    expect(value.admit('我是MiniMax的编程助手', 50, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('可以帮你查看目录', 60, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('还会讲解代码', 70, false)).toEqual({ kind: 'ignore' })
    expect(value.admit('帮我看看别的', 80, false)).toEqual({ kind: 'prompt', text: '帮我看看别的' })
    expect(value.admit('小智小智', 400, false)).toEqual({ kind: 'wake' })
  })
  it('removes code and formatting from the speech projection', () => {
    expect(speechText('# 回答\n```ts\nsecret()\n```\n[文档](https://example.com) **好**')).toBe('回答\n\n文档 好')
  })
  it('strips inlined chain-of-thought tags from the speech projection', () => {
    expect(speechText('<think>先查一下目录</think>答案在这里')).toBe('答案在这里')
    expect(speechText('<THINK>先查一下</THINK>答案')).toBe('答案')
    expect(speechText('前半<thinking>盘算中</thinking>后半')).toBe('前半后半')
    expect(speechText('<think>未闭合的思考被截断')).toBe('')
    expect(speechText('孤儿闭合</think>之后的内容')).toBe('孤儿闭合之后的内容')
  })
  it('drops emoji from the synthesis text but keeps it for display', () => {
    expect(speechSynthesisText('😄好呀，我在呢')).toBe('好呀，我在呢')
    expect(speechSynthesisText('好的呢 😆')).toBe('好的呢')
    expect(speechSynthesisText('🧑‍💻复杂序列也整体移除')).toBe('复杂序列也整体移除')
    expect(speechSynthesisText('没有表情的句子')).toBe('没有表情的句子')
    expect(speechSynthesisText('🤔')).toBe('')
  })
})
