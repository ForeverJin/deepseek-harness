/** Exit-intent tool: official goodbye contract, scoped registration, pure execution. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/exit-tool.ts'

/** The registered definition surface the assertions read. */
interface RegisteredTool {
  name: string
  description: string
  parameters: { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  output: { render: (args: unknown, value: unknown) => { type: string; text: string }[] }
  execute: (args: unknown, exec: never) => Promise<unknown>
}

/** Minimal tools-service double capturing registrations without dispatch machinery. */
function registerOnce(): { registrations: RegisteredTool[]; ctx: Context } {
  const registrations: RegisteredTool[] = []
  const ctx = {
    tools: {
      register(definition: RegisteredTool): () => void {
        registrations.push(definition)
        return () => {
          const at = registrations.indexOf(definition)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
    },
  } as unknown as Context
  return { registrations, ctx }
}

describe('Exit-intent tool plugin', () => {
  it('is a preset-scoped plugin injecting the tools service', () => {
    expect(name).toBe('xiaozhi-exit-tool')
    expect(inject).toContain('tools')
  })

  it('registers the official goodbye contract', () => {
    const { registrations, ctx } = registerOnce()
    apply(ctx)
    expect(registrations).toHaveLength(1)
    const tool = registrations[0]
    if (tool === undefined) throw new Error('exit tool was not registered')
    expect(tool.name).toBe('handle_exit_intent')
    expect(tool.description).toContain('结束对话')
    expect(tool.parameters.properties?.say_goodbye?.type).toBe('string')
    expect(tool.parameters.properties?.say_goodbye?.description).toContain('告别语')
    expect(tool.parameters.required).toContain('say_goodbye')
    expect(tool.output.render({}, { handled: true })).toEqual([{ type: 'text', text: '将播放告别语并结束本次对话' }])
  })

  it('executes pure and rejects a missing farewell', async () => {
    const { registrations, ctx } = registerOnce()
    apply(ctx)
    const tool = registrations[0]
    if (tool === undefined) throw new Error('exit tool was not registered')
    await expect(tool.execute({ say_goodbye: '再见，下次再聊' }, {} as never)).resolves.toEqual({ handled: true })
    await expect(tool.execute({}, {} as never)).rejects.toThrow()
  })
})
