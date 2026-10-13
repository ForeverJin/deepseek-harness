/** @vitest-environment jsdom */
/** What the browser half registers on the Plugins page, and that it leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, XIAOZHI_PACKAGE } from '../src/client/index.ts'

/** One Host view of a served namespace. */
function view(ns: string, revision = 0) {
  return { ns, schema: {}, value: {}, applies: 'live' as const, secrets: [], revision }
}

/** @param served - namespaces the Host describes; omitted answers a failed read. */
async function bench(served?: string[]) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describeSettings = vi.fn(() => Promise.resolve(served === undefined
    ? { ok: false as const, error: new RemoteError('gateway/internal', 'no provider', {}) }
    : { ok: true as const, value: { writable: true, hasDocument: true, namespaces: served.map(ns => view(ns)) } }))
  new TestRemote(ctx, { settings: { describe: describeSettings } })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, describeSettings }
}

/** The Plugins page's bundle-config slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'plugins.bundle.config': { kind: 'keyed', scope: 'root' } },
  } as never, () => null)
}

describe('ui-xiaozhi apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('registers the settings form for its package while the Host serves the namespace', async () => {
    const { ctx, slots } = await bench(['xiaozhi-voice'])
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    await vi.waitFor(() => { expect(slots.entries('plugins.bundle.config')).toHaveLength(1) })
    const entry = slots.entries('plugins.bundle.config')[0]!
    expect(entry.options).toMatchObject({ key: XIAOZHI_PACKAGE })
    expect(entry.locale).toBe('settings.xiaozhi')
    const face = (entry.inject as () => { hooks: Record<string, unknown> })()
    expect(Object.keys(face.hooks)).toEqual(['xiaozhiCard'])
    await ctx.fiber.dispose()
    expect(slots.entries('plugins.bundle.config')).toHaveLength(0)
  })

  it('registers nothing while the Host serves no xiaozhi namespace', async () => {
    const { ctx, slots } = await bench(['shell'])
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('plugins.bundle.config')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
