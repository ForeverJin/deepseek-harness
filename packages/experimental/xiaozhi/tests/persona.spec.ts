/** Voice persona: prompt composition, preset definition, and registration wiring. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import type { GatewayConfig } from '../src/types.ts'
import { DEFAULT_PERSONA, PERSONA_PRESET_ID, VOICE_RULES, currentTimeLine, personaPresetDefinition, personaPrompt, registerPersona } from '../src/persona.ts'

/** Registry stub recording handed definitions without mounting plugin trees. */
class StubPresetRegistry extends Service {
  constructor(ctx: Context, private readonly options: { registered: PresetDefinition[] }) { super(ctx, 'agentPresets') }
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    this.options.registered.push(definition)
    return async () => {
      const at = this.options.registered.indexOf(definition)
      if (at >= 0) this.options.registered.splice(at, 1)
    }
  }
}

/** One gateway configuration carrying a mutable volatile persona. */
function personaConfig(): { config: Pick<GatewayConfig, 'persona'>; set: (persona: string) => void } {
  let current = DEFAULT_PERSONA
  return {
    config: { persona: { get: () => current } },
    set: (persona: string) => { current = persona },
  }
}

describe('Persona prompt composition', () => {
  const wednesday = new Date('2026-10-14T23:30:00')

  it('wraps a custom role description after the built-in speech rules with the time line', () => {
    expect(personaPrompt('你是一位严肃的船长', wednesday))
      .toBe(`${VOICE_RULES}\n\n你是一位严肃的船长\n\n当前时间：${currentTimeLine(wednesday)}`)
    expect(currentTimeLine(wednesday)).toBe('2026-10-14 23:30 星期三')
  })

  it('falls back to the default persona on blank or whitespace input', () => {
    expect(personaPrompt('', wednesday)).toBe(`${VOICE_RULES}\n\n${DEFAULT_PERSONA}\n\n当前时间：${currentTimeLine(wednesday)}`)
    expect(personaPrompt('  \n\t ', wednesday)).toBe(`${VOICE_RULES}\n\n${DEFAULT_PERSONA}\n\n当前时间：${currentTimeLine(wednesday)}`)
  })

  it('keeps an inner literal brace group in the role text verbatim', () => {
    expect(personaPrompt('输出 {{例子}} 时保持原样', wednesday)).toContain('{{例子}}')
  })

  it('locks the output language and constrains emoji to one leading mark', () => {
    expect(VOICE_RULES).toContain('始终用中文回答')
    expect(VOICE_RULES).toContain('至多放一个表情')
  })
})

describe('Voice preset definition', () => {
  it('builds the persona section over the persistent shell group', () => {
    const definition = personaPresetDefinition()
    expect(definition.id).toBe(PERSONA_PRESET_ID)
    const [persona, shell] = definition.plugins
    expect(persona).toMatchObject({
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: '{{xiaozhi_persona}}', complete: true, includeRuntimeContext: false },
    })
    expect(shell).toMatchObject({ name: 'cordis:group', group: true, isolate: { terminals: true } })
    const rows = shell?.config as { id: string; name: string; disabled?: boolean }[]
    expect(rows.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-terminal',
      '@deepseek-ai/dsh-terminal-bash',
      '@deepseek-ai/dsh-tool-bash-persistent',
      '@deepseek-ai/dsh-terminal-bash',
      '@deepseek-ai/dsh-tool-pwsh-persistent',
    ])
    const windows = process.platform === 'win32'
    expect(rows.map(row => row.disabled === true)).toEqual([false, windows, windows, !windows, !windows])
  })
})

describe('Persona registration', () => {
  it('serves the volatile persona on every assembly and unregisters with its context', async () => {
    const ctx = new Context()
    const registered: PresetDefinition[] = []
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(StubPresetRegistry, { registered })
    const { config, set } = personaConfig()
    registerPersona(ctx, config)
    await expect.poll(() => registered.map(definition => definition.id)).toEqual([PERSONA_PRESET_ID])
    // The variable evaluates per assembly, so its rendered time tracks the
    // wall clock; assert the stable prefix and the time line's presence.
    const rendered = (await ctx.systemPrompt.assemble()).variables.xiaozhi_persona
    expect(rendered?.startsWith(`${VOICE_RULES}\n\n${DEFAULT_PERSONA}\n\n当前时间：`)).toBe(true)
    expect(rendered).toMatch(/当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 星期[一二三四五六日]/)
    set('你是一位温柔的诗人')
    expect((await ctx.systemPrompt.assemble()).variables.xiaozhi_persona?.startsWith(`${VOICE_RULES}\n\n你是一位温柔的诗人\n\n当前时间：`)).toBe(true)
    await ctx.fiber.dispose()
    expect(registered).toHaveLength(0)
  })
})
