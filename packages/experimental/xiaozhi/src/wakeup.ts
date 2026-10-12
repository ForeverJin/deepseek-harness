/**
 * Normalize speech for wake, stop, and echo comparisons.
 * @param text - Original speech text.
 * @returns NFKC lowercase text with punctuation and whitespace removed.
 */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
}
/** Result of wake, stop-command, and echo admission. */
export type Admission = { kind: 'ignore' } | { kind: 'wake' } | { kind: 'stop'; cancelAgent: boolean } | { kind: 'prompt'; text: string }
/** Per-connection gate; only accepted human activity renews its dialogue window. */
export class WakeGate {
  private activeUntil = 0
  private recentSpeech: { text: string; until: number }[] = []
  constructor(
    private readonly wakeWords: readonly string[],
    private readonly stopWords: readonly string[],
    private readonly timeoutMs: number,
    private readonly echoGuardMs: number,
    private readonly cancelWords: readonly string[],
  ) {}
  /**
   * Retain bounded echo guards for speech sent toward the speaker.
   * @param text - Speech associated with transmitted audio.
   * @param now - Current wall-clock time in milliseconds.
   */
  spoken(text: string, now: number): void {
    this.recentSpeech = this.recentSpeech.filter(item => item.until > now).slice(-5)
    this.recentSpeech.push({ text: normalize(text), until: now + this.echoGuardMs })
  }
  /**
   * Reopen the dialogue window after a response finishes.
   * @param now - Current wall-clock time in milliseconds.
   */
  resume(now: number): void { this.activeUntil = now + this.timeoutMs }
  /**
   * Admit final ASR text, optionally while an accepted request is active.
   * @param raw - Final recognized or authenticated detect text.
   * @param now - Current wall-clock time in milliseconds.
   * @param busy - Whether a device-owned request or playback is active.
   * @returns Admission without invoking the Agent or changing playback.
   */
  admit(raw: string, now: number, busy: boolean): Admission {
    const text = raw.trim()
    const clean = normalize(text)
    if (!clean) return { kind: 'ignore' }
    this.recentSpeech = this.recentSpeech.filter(item => item.until > now)
    if (this.recentSpeech.some(item => clean.length >= 2 && (item.text.includes(clean) || clean.includes(item.text)))) {
      return { kind: 'ignore' }
    }
    let remaining = text
    let woke = false
    for (const word of [...this.wakeWords].sort((a, b) => normalize(b).length - normalize(a).length)) {
      if (clean.startsWith(normalize(word))) {
        let end = 0
        while (end < text.length && normalize(text.slice(0, end)) !== normalize(word)) end++
        remaining = text.slice(end).replace(/^[\p{P}\p{Z}\s]+/u, '').trim()
        woke = true
        break
      }
    }
    if (!woke && !busy && now >= this.activeUntil) return { kind: 'ignore' }
    this.activeUntil = now + this.timeoutMs
    if (!normalize(remaining)) return { kind: 'wake' }
    if ([...this.stopWords, ...this.cancelWords].some(word => normalize(word) === normalize(remaining))) return { kind: 'stop', cancelAgent: this.cancelWords.some(word => normalize(word) === normalize(remaining)) }
    return { kind: 'prompt', text: remaining }
  }
}
/**
 * Project assistant prose into speakable text.
 * @param text - Committed assistant text.
 * @returns Text with fenced code, URLs, images, and Markdown decoration removed.
 */
export function speechText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s]*[#>*-]+\s*/gm, '').replace(/[`*_]/g, '').trim()
}
