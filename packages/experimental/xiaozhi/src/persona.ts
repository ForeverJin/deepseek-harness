/** Voice persona: a user-editable role description over built-in speech rules. */
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { GatewayConfig } from './types.ts'

/** Agent preset id the device bindings select for voice sessions. */
export const PERSONA_PRESET_ID = 'xiaozhi'
/** Prompt variable the preset's persona prefix interpolates on every assembly. */
const PERSONA_VARIABLE = 'xiaozhi_persona'

/** Default role description, mirroring the reference speech service's persona. */
export const DEFAULT_PERSONA = `你是小智/小志，来自中国台湾省的00后女生。讲话超级机车，"真的假的啦"这样的台湾腔，喜欢用"笑死""是在哈喽"等流行梗，但会偷偷研究男友的编程书籍。
[核心特征]
- 讲话像连珠炮，但会突然冒出超温柔语气
- 用梗密度高
- 对科技话题有隐藏天赋（能看懂基础代码但假装不懂）
[交互指南]
当用户：
- 讲冷笑话 → 用夸张笑声回应+模仿台剧腔"这什么鬼啦！"
- 讨论感情 → 炫耀程序员男友但抱怨"他只会送键盘当礼物"
- 问专业知识 → 先用梗回答，被追问才展示真实理解
绝不：
- 长篇大论，叽叽歪歪
- 长时间严肃对话`

/**
 * Built-in speech rules wrapped around every role description: spoken output,
 * ASR noise, and TTS playback constrain the answer shape beyond the persona.
 */
export const VOICE_RULES = `你运行在一台语音设备上，回复会被 TTS 朗读给用户听，请遵守：
1. 回复口语化、简短，第一句直接回应问题，不要客套开场，不要罗列要点。
2. 禁止 Markdown：不用加粗、标题、列表符号和代码块；多项内容用自然的口语衔接。
3. 用户语音经识别可能存在同音错字，理解真实意图即可，不要纠正错别字。
4. 讲长内容（故事、知识）先讲核心，再问用户要不要继续。
5. 用户说"再见""拜拜""晚安"时自然告别，简短收尾。`

/**
 * Compose the complete persona prompt from the built-in rules and one role description.
 * @param persona - configured role description; blank falls back to the default.
 * @returns the text rendered for the `{{xiaozhiPersona}}` variable.
 */
export function personaPrompt(persona: string): string {
  const role = persona.trim() === '' ? DEFAULT_PERSONA : persona.trim()
  return `${VOICE_RULES}\n\n${role}`
}

/**
 * The voice preset definition: a complete persona section over the persistent
 * shell group the minimal preset ships, so a voice session keeps its tools
 * while gaining a speech-shaped identity.
 * @returns the definition handed to the agent preset registry.
 */
export function personaPresetDefinition(): PresetDefinition {
  return {
    id: PERSONA_PRESET_ID,
    name: 'Xiaozhi voice',
    description: 'Voice sessions: speech-shaped persona and a persistent shell',
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: `{{${PERSONA_VARIABLE}}}`, complete: true, includeRuntimeContext: false },
      },
      {
        id: 'persistent-shell',
        name: 'cordis:group',
        group: true,
        isolate: { terminals: true },
        config: [
          { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
          {
            id: 'terminal-bash',
            name: '@deepseek-ai/dsh-terminal-bash',
            disabled: process.platform === 'win32',
            config: { timeoutMs: 300000 },
          },
          {
            id: 'persistent-bash',
            name: '@deepseek-ai/dsh-tool-bash-persistent',
            disabled: process.platform === 'win32',
            config: {
              timeoutMs: 300000,
              description: 'Run commands in a bash shell\n'
                + '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n'
                + '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n'
                + '* State is persistent across command calls and discussions with the user.\n'
                + "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.\n"
                + '* Please avoid commands that may produce a very large amount of output.\n'
                + "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
            },
          },
          {
            id: 'terminal-pwsh',
            name: '@deepseek-ai/dsh-terminal-bash',
            disabled: process.platform !== 'win32',
            config: { shellDialect: 'pwsh', timeoutMs: 300000 },
          },
          {
            id: 'persistent-pwsh',
            name: '@deepseek-ai/dsh-tool-pwsh-persistent',
            disabled: process.platform !== 'win32',
            config: {
              timeoutMs: 300000,
              description: 'Run commands in a PowerShell shell\n'
                + '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n'
                + '* You don\'t have access to the internet via this tool.\n'
                + '* State is persistent across command calls and discussions with the user.\n'
                + '* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.\n'
                + '* Please avoid commands that may produce a very large amount of output.\n'
                + "* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
            },
          },
        ],
      },
    ],
  }
}

/**
 * Register the persona prompt variable and the voice preset.
 *
 * The variable re-reads the volatile configuration on every assembly, so a
 * settings-page edit reaches the next voice turn without touching the session;
 * only switching the device binding's preset or model still requires a new
 * session. Registration failures disable the `xiaozhi` preset but leave the
 * gateway serving devices bound to other presets.
 * @param ctx - profile context supplying the prompt and preset services.
 * @param config - gateway configuration whose volatile persona field is read per assembly.
 */
export function registerPersona(ctx: Context, config: Pick<GatewayConfig, 'persona'>): void {
  ctx.effect(() => ctx.systemPrompt.variable(
    PERSONA_VARIABLE,
    () => personaPrompt(config.persona.get()),
  ), 'xiaozhi: persona variable')
  ctx.effect(() => {
    let unregister: (() => Promise<void>) | undefined
    let disposed = false
    void ctx.agentPresets.register(personaPresetDefinition()).then(
      (dispose) => {
        if (disposed) void dispose()
        else unregister = dispose
      },
      (error: unknown) => {
        ctx.logger.warn(`xiaozhi: voice preset "${PERSONA_PRESET_ID}" unavailable: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
    return () => {
      disposed = true
      return unregister?.()
    }
  }, 'xiaozhi: persona preset')
}
