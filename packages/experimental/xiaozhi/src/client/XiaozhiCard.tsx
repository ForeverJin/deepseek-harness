/** The Xiaozhi voice settings card on the Plugins page. */

import { useId } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels } from './locales.ts'
import type { XiaozhiCardFace } from './form.ts'
import css from './XiaozhiCard.module.css'

/** Framework-derived props for the Xiaozhi voice settings form. */
export type XiaozhiCardProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.xiaozhi'> & InjectFace<XiaozhiCardFace>

/**
 * Render the staged speech-backend overrides with one configuration page and save footer.
 * @param props - Locale, the form snapshot, and its actions.
 * @returns The summary sentence or the settings form.
 */
export function XiaozhiCard(props: XiaozhiCardProps) {
  const { t } = props
  const state = props.useXiaozhiCard(snapshot => snapshot)
  const personaId = useId()
  const asrId = useId(), ttsId = useId(), keyId = useId(), urlId = useId(), groupId = useId()
  const asrVoiceId = useId(), asrLangId = useId(), edgeId = useId(), ttsVoiceId = useId(), ttsModelId = useId()
  if (props.view === 'summary') return t('summary')
  const disabled = !state.writable || state.saving
  const field = (
    id: string, key: 'funasrUrl' | 'minimaxAsrModel' | 'minimaxAsrLanguage' | 'edgeVoice' | 'minimaxTtsModel' | 'minimaxTtsVoice' | 'minimaxBaseUrl' | 'minimaxGroupId',
    label: string, hint?: string,
  ) => (
    <SettingsValueField id={id} label={label}
      {...(hint === undefined ? {} : { hint })}
      {...state[key]} overriddenLabel={t('overridden')} resetLabel={t('reset')} invalidLabel={t('invalidValue')}
      disabled={disabled} onEdit={(value) => { props.edit(key, value) }} onReset={() => { props.resetField(key) }} />
  )
  return (
    <SettingsForm labels={formLabels(t)}
      state={state} onSave={props.save} onDiscard={props.discard}>
      <p className={css.notice}>{t('inheritNotice')}</p>
      <section className={css.section} aria-labelledby={`${personaId}-heading`}>
        <h3 className={css.heading} id={`${personaId}-heading`}>{t('personaSection')}</h3>
        <div className={css.field}>
          <label htmlFor={`${personaId}-text`}>{t('persona')}</label>
          <textarea id={`${personaId}-text`} className={css.textarea} rows={10} spellCheck={false}
            value={state.persona.text} disabled={disabled}
            aria-invalid={state.persona.invalid || undefined}
            onChange={(event) => { props.edit('persona', event.target.value) }} />
          <div className={css.toolbar}>
            {state.persona.overridden
              ? (
                <Button size="sm" variant="outline" disabled={disabled}
                  onClick={() => { props.resetField('persona') }}>{t('reset')}</Button>
              )
              : null}
            <span className={css.hint}>{t('personaHint')}</span>
          </div>
          {state.persona.invalid ? <span className={css.hint}>{t('invalidValue')}</span> : null}
        </div>
      </section>
      <section className={css.section} aria-labelledby={`${asrId}-heading`}>
        <h3 className={css.heading} id={`${asrId}-heading`}>{t('asrSection')}</h3>
        <div className={css.field}>
          <label htmlFor={`${asrId}-provider`}>{t('provider')}</label>
          <select id={`${asrId}-provider`} value={state.asrProvider.text} disabled={disabled}
            onChange={(event) => { props.edit('asrProvider', event.target.value) }}>
            <option value="">{t('providerAuto')}</option>
            <option value="funasr">{t('providerFunasr')}</option>
            <option value="minimax">{t('providerMinimax')}</option>
          </select>
        </div>
        {state.asrProvider.text === 'funasr' ? field(asrVoiceId, 'funasrUrl', t('funasrUrl'), t('funasrUrlHint')) : null}
        {state.asrProvider.text === 'minimax' ? (
          <>
            {field(asrVoiceId, 'minimaxAsrModel', t('minimaxAsrModel'))}
            {field(asrLangId, 'minimaxAsrLanguage', t('minimaxAsrLanguage'), t('minimaxAsrLanguageHint'))}
          </>
        ) : null}
      </section>
      <section className={css.section} aria-labelledby={`${ttsId}-heading`}>
        <h3 className={css.heading} id={`${ttsId}-heading`}>{t('ttsSection')}</h3>
        <div className={css.field}>
          <label htmlFor={`${ttsId}-provider`}>{t('provider')}</label>
          <select id={`${ttsId}-provider`} value={state.ttsProvider.text} disabled={disabled}
            onChange={(event) => { props.edit('ttsProvider', event.target.value) }}>
            <option value="">{t('ttsProviderAuto')}</option>
            <option value="edge">{t('ttsProviderEdge')}</option>
            <option value="minimax">{t('providerMinimax')}</option>
          </select>
        </div>
        {state.ttsProvider.text === 'edge' ? field(edgeId, 'edgeVoice', t('edgeVoice'), t('edgeVoiceHint')) : null}
        {state.ttsProvider.text === 'minimax' ? (
          <>
            {field(ttsModelId, 'minimaxTtsModel', t('minimaxTtsModel'))}
            {field(ttsVoiceId, 'minimaxTtsVoice', t('minimaxTtsVoice'))}
          </>
        ) : null}
      </section>
      {(state.asrProvider.text === 'minimax' || state.ttsProvider.text === 'minimax' || state.minimaxApiKey.overridden || state.minimaxBaseUrl.overridden || state.minimaxGroupId.overridden)
        ? (
          <section className={css.section} aria-labelledby={`${keyId}-heading`}>
            <h3 className={css.heading} id={`${keyId}-heading`}>{t('minimaxSection')}</h3>
            <div className={css.field}>
              <label htmlFor={`${keyId}-key`}>{t('minimaxApiKey')}</label>
              <input id={`${keyId}-key`} className={css.input} type="password" autoComplete="new-password"
                value={state.minimaxApiKey.text} disabled={disabled}
                onChange={(event) => { props.edit('minimaxApiKey', event.target.value) }} />
              <div className={css.toolbar}>
                <Button size="sm" variant="outline" disabled={disabled} onClick={props.clearKey}>{t('clearKey')}</Button>
                <span className={css.hint}>{t('minimaxApiKeyHint')}</span>
              </div>
            </div>
            {field(urlId, 'minimaxBaseUrl', t('minimaxBaseUrl'), t('minimaxBaseUrlHint'))}
            {field(groupId, 'minimaxGroupId', t('minimaxGroupId'), t('minimaxGroupIdHint'))}
          </section>
        )
        : null}
    </SettingsForm>
  )
}
