/** Locale-owned copy for the Xiaozhi voice settings card. */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Dictionary namespace for this plugin. */
export const NS = 'settings.xiaozhi'

/** English copy and key source. */
export const en = {
  title: 'Xiaozhi Voice',
  summary: 'Set the role description and the ASR and TTS backends the speech service uses for Xiaozhi devices.',
  personaSection: 'Role description',
  persona: 'Persona spoken to the voice session',
  personaHint: 'Takes effect from the next utterance without restarting or recreating the session; clearing it restores the built-in default.',
  asrSection: 'Speech recognition (ASR)',
  ttsSection: 'Speech synthesis (TTS)',
  minimaxSection: 'MiniMax connection',
  provider: 'Provider',
  providerAuto: 'Follow speech service (ASR_PROVIDER)',
  providerFunasr: 'FunASR offline WebSocket',
  providerMinimax: 'MiniMax API',
  ttsProviderAuto: 'Follow speech service (TTS_PROVIDER)',
  ttsProviderEdge: 'Edge TTS (online, needs ffmpeg)',
  funasrUrl: 'FunASR WebSocket URL',
  funasrUrlHint: 'ws:// or wss:// endpoint of your FunASR offline server.',
  edgeVoice: 'Edge TTS voice',
  edgeVoiceHint: 'For example zh-CN-XiaoxiaoNeural.',
  minimaxAsrModel: 'MiniMax ASR model',
  minimaxAsrLanguage: 'MiniMax ASR language',
  minimaxAsrLanguageHint: 'BCP-47 code such as zh or en; empty auto-detects.',
  minimaxTtsModel: 'MiniMax TTS model',
  minimaxTtsVoice: 'MiniMax TTS voice',
  minimaxApiKey: 'MiniMax API key',
  minimaxApiKeyHint: 'Write-only: the stored key never displays. Blank keeps the stored key.',
  clearKey: 'Clear stored key',
  minimaxBaseUrl: 'MiniMax API base URL',
  minimaxBaseUrlHint: 'For example https://api.minimaxi.com.',
  minimaxGroupId: 'MiniMax GroupId',
  minimaxGroupIdHint: 'Only for legacy JWT keys; leave empty for sk- keys.',
  inheritNotice: 'Empty fields inherit the speech-service machine environment (ASR_PROVIDER, FUNASR_URL, TTS_PROVIDER, TTS_VOICE, MINIMAX_*). Saving takes effect from the next utterance or synthesis, without a service restart.',
  invalidValue: 'This value is not accepted.',
  overridden: 'Overridden', reset: 'Reset to default',
  unavailable: 'Xiaozhi voice settings are unavailable while the gateway plugin is not loaded.',
  readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.', save: 'Save', saving: 'Saving…',
}

/** Locale dictionary key union. */
export type XiaozhiLocaleKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<XiaozhiLocaleKey, string> = {
  title: '小智语音',
  summary: '设置语音会话的角色描述，以及语音服务为小智设备使用的识别（ASR）与合成（TTS）后端。',
  personaSection: '角色描述',
  persona: '语音会话的人设',
  personaHint: '保存后从下一句话开始生效，无需重启或删除会话；清空恢复内置默认人设。',
  asrSection: '语音识别（ASR）',
  ttsSection: '语音合成（TTS）',
  minimaxSection: 'MiniMax 连接',
  provider: '提供商',
  providerAuto: '跟随语音服务配置（ASR_PROVIDER）',
  providerFunasr: 'FunASR 离线 WebSocket',
  providerMinimax: 'MiniMax API',
  ttsProviderAuto: '跟随语音服务配置（TTS_PROVIDER）',
  ttsProviderEdge: 'Edge TTS（联网，需 ffmpeg）',
  funasrUrl: 'FunASR WebSocket 地址',
  funasrUrlHint: 'FunASR offline 服务的 ws:// 或 wss:// 地址。',
  edgeVoice: 'Edge TTS 音色',
  edgeVoiceHint: '例如 zh-CN-XiaoxiaoNeural。',
  minimaxAsrModel: 'MiniMax ASR 模型',
  minimaxAsrLanguage: 'MiniMax ASR 语言',
  minimaxAsrLanguageHint: 'BCP-47 语言代码，如 zh、en；留空自动检测。',
  minimaxTtsModel: 'MiniMax TTS 模型',
  minimaxTtsVoice: 'MiniMax TTS 音色',
  minimaxApiKey: 'MiniMax API 密钥',
  minimaxApiKeyHint: '只写不读：已保存的密钥不会显示；留空保存表示不修改。',
  clearKey: '清除已保存的密钥',
  minimaxBaseUrl: 'MiniMax API 根地址',
  minimaxBaseUrlHint: '例如 https://api.minimaxi.com。',
  minimaxGroupId: 'MiniMax GroupId',
  minimaxGroupIdHint: '仅旧版 JWT 密钥需要；sk- 开头的密钥留空即可。',
  inheritNotice: '留空的字段沿用语音服务机器的环境变量（ASR_PROVIDER、FUNASR_URL、TTS_PROVIDER、TTS_VOICE、MINIMAX_*）。保存后从下一次收音或合成开始生效，无需重启语音服务。',
  invalidValue: '该值不被接受。',
  overridden: '已覆盖', reset: '恢复默认',
  unavailable: '小智语音网关未加载，设置暂不可用。',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改', save: '保存', saving: '保存中…',
}

/**
 * Read shared form chrome from the plugin dictionary.
 * @param t - current locale reader.
 * @returns localized form labels.
 */
export function formLabels(t: (key: XiaozhiLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
