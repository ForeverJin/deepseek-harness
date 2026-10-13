/**
 * The Xiaozhi voice settings page, browser half: speech-backend overrides
 * staged over the `xiaozhi-voice` namespace. The page registers into the
 * Plugins page's `plugins.bundle.config` slot for this package while the Host
 * serves the namespace, so deployments without the gateway bundle never see
 * the form.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { XiaozhiCard } from './XiaozhiCard.tsx'
import { XiaozhiCardController } from './form.ts'
import { en, zh, type XiaozhiLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Xiaozhi voice settings card copy. */
    'settings.xiaozhi': XiaozhiLocaleKey
  }
}

/**
 * Namespace of the Xiaozhi gateway settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const XIAOZHI_NS = 'xiaozhi-voice'

/** This package's npm name; the Plugins page keys bundle config forms by it. */
export const XIAOZHI_PACKAGE = '@deepseek-ai/dsh-experimental-xiaozhi'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the Xiaozhi voice settings form while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('settings.xiaozhi', { zh, en }), 'ui-xiaozhi: dictionaries')
  const card = new XiaozhiCardController(ctx.configForms.get(XIAOZHI_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-xiaozhi: settings form subscription')
  ctx.effect(() => ctx.configForms.whileServed([XIAOZHI_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: XIAOZHI_PACKAGE,
    locale: 'settings.xiaozhi',
    inject: () => card.inject(),
  }, XiaozhiCard))), 'ui-xiaozhi: page')
}
