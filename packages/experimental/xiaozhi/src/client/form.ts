/** Staged speech-backend overrides over the `xiaozhi-voice` settings namespace. */

import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The fields this card edits; every backend field absent or empty inherits the service environment. */
export interface XiaozhiSettings {
  persona?: string
  asrProvider?: string
  funasrUrl?: string
  minimaxAsrModel?: string
  minimaxAsrLanguage?: string
  ttsProvider?: string
  edgeVoice?: string
  minimaxTtsModel?: string
  minimaxTtsVoice?: string
  minimaxApiKey?: string
  minimaxBaseUrl?: string
  minimaxGroupId?: string
}

/** Effective values and drafts presented by the card. */
export interface XiaozhiCardState extends SettingsFormShell {
  persona: SettingsFieldState
  asrProvider: SettingsFieldState
  funasrUrl: SettingsFieldState
  minimaxAsrModel: SettingsFieldState
  minimaxAsrLanguage: SettingsFieldState
  ttsProvider: SettingsFieldState
  edgeVoice: SettingsFieldState
  minimaxTtsModel: SettingsFieldState
  minimaxTtsVoice: SettingsFieldState
  minimaxApiKey: SettingsFieldState
  minimaxBaseUrl: SettingsFieldState
  minimaxGroupId: SettingsFieldState
}

/** Actions and observable state bound by the slot renderer. */
export interface XiaozhiCardFace extends SettingsFormActions {
  hooks: {
    xiaozhiCard: SnapshotStore<XiaozhiCardState>
  }
  /** Clear the stored MiniMax key; redaction hides the user layer from the staged model. */
  clearKey: () => void
}

/**
 * A multi-line text field that keeps inner newlines; a whitespace-only draft
 * clears the override so the built-in default persona applies again.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsMultilineField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: text }
    },
  }
}

/** Stages the persona and speech-backend overrides until the reader saves them. */
export class XiaozhiCardController {
  private readonly form: SettingsFormModel<XiaozhiSettings>
  private readonly store: SnapshotStore<XiaozhiCardState>

  /**
   * @param scope - Host-backed configuration form for the `xiaozhi-voice` namespace.
   */
  constructor(private readonly scope: SettingsFormScope<XiaozhiSettings>) {
    this.form = new SettingsFormModel(scope, [
      settingsMultilineField('persona'),
      ...['asrProvider', 'funasrUrl', 'minimaxAsrModel', 'minimaxAsrLanguage',
        'ttsProvider', 'edgeVoice', 'minimaxTtsModel', 'minimaxTtsVoice',
        'minimaxApiKey', 'minimaxBaseUrl', 'minimaxGroupId',
      ].map(field => settingsTextField(field))])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      persona: this.form.field('persona'),
      asrProvider: this.form.field('asrProvider'),
      funasrUrl: this.form.field('funasrUrl'),
      minimaxAsrModel: this.form.field('minimaxAsrModel'),
      minimaxAsrLanguage: this.form.field('minimaxAsrLanguage'),
      ttsProvider: this.form.field('ttsProvider'),
      edgeVoice: this.form.field('edgeVoice'),
      minimaxTtsModel: this.form.field('minimaxTtsModel'),
      minimaxTtsVoice: this.form.field('minimaxTtsVoice'),
      minimaxApiKey: this.form.field('minimaxApiKey'),
      minimaxBaseUrl: this.form.field('minimaxBaseUrl'),
      minimaxGroupId: this.form.field('minimaxGroupId'),
    }))
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the key clear action.
   */
  inject(): XiaozhiCardFace {
    return { hooks: { xiaozhiCard: this.store }, clearKey: () => { void this.clearKey() }, ...this.form.actions() }
  }

  /** Clear the stored key outside staging: the redacted user layer hides its presence from `plan()`. */
  private async clearKey(): Promise<void> {
    await this.scope.mutate([{ op: 'unset', path: ['minimaxApiKey'] }])
  }

  /** Release accepted-value subscriptions. */
  dispose(): void { this.form.dispose() }
}
