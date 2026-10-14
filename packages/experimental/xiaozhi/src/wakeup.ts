/** Chinese readings of 0-9 for digit transliteration. */
const DIGIT_CHARS = '零一二三四五六七八九'
/** Digit place units inside one 4-digit group. */
const SECTION_UNITS = ['', '十', '百', '千']
/** Group place units for the integer part, in ascending group order. */
const GROUP_UNITS = ['', '万', '亿', '万亿']

/**
 * Read one integer run the way TTS voices speak it and ASR transcribes it back,
 * so "26 度" said aloud compares equal to the "二十六度" that returns.
 * @param run - Consecutive ASCII digits.
 * @returns Chinese-numeral reading, or a per-digit reading when too long.
 */
function digitsToChinese(run: string): string {
  const perDigit = () => Array.from(run, digit => DIGIT_CHARS[Number(digit)] ?? digit).join('')
  if (run.length > 12) return perDigit()
  const groups: string[] = []
  for (let rest = run; rest !== ''; rest = rest.slice(0, -4)) groups.unshift(rest.slice(-4))
  let out = ''
  groups.forEach((group, index) => {
    if (Number(group) === 0) {
      if (out !== '' && !out.endsWith('零')) out += '零'
      return
    }
    let section = ''
    let pendingZero = false
    for (let position = 0; position < group.length; position++) {
      const digit = Number(group[position])
      const unit = SECTION_UNITS[group.length - 1 - position] ?? ''
      if (digit === 0) { if (section !== '') pendingZero = true; continue }
      if (pendingZero) { section += '零'; pendingZero = false }
      if (digit === 1 && unit === '十' && section === '') section = '十'
      else section += (DIGIT_CHARS[digit] ?? String(digit)) + unit
    }
    out += section + (GROUP_UNITS[groups.length - 1 - index] ?? '')
  })
  return out === '' ? '零' : out
}

/** Emoji sequences, including skin-tone and ZWJ-joined composites. */
const EMOJI_PATTERN = /\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?)*/gu

/**
 * Normalize speech for wake, stop, and echo comparisons.
 * @param text - Original speech text.
 * @returns NFKC lowercase text with digits read in Chinese, emoji dropped, and
 * punctuation and whitespace removed, so echo matching survives ASR numeral
 * transcription and display-only emoji.
 */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(EMOJI_PATTERN, '')
    .replace(/(\d)\.(\d)/g, '$1点$2').replace(/\d+/g, digitsToChinese).replace(/[\p{P}\p{Z}\s]/gu, '')
}

/** Code points of normalized text; astral characters (emoji leftovers, rare CJK extensions) must not split. */
const codePoints = (text: string): string[] => Array.from(text)

/** Character bigrams of normalized text, used for echo similarity. */
function bigrams(text: string): Set<string> {
  const grams = new Set<string>(), points = codePoints(text)
  for (let index = 0; index + 1 < points.length; index++) grams.add((points[index] ?? '') + (points[index + 1] ?? ''))
  return grams
}

/**
 * Longest-common-subsequence ratio of a transcript against spoken text: how
 * much of the transcript reads off in order inside the spoken text. Tolerates
 * ASR rewriting whole words ("男友" heard as "哪有") that share no bigrams.
 * @param left - Normalized transcript.
 * @param right - Normalized clause.
 * @returns LCS length divided by the transcript length.
 */
function lcsRatio(left: string, right: string): number {
  const a = codePoints(left), b = codePoints(right)
  if (a.length === 0) return 0
  let previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    previous = current
  }
  return (previous[b.length] ?? 0) / a.length
}

/**
 * Whether two normalized texts are close enough that the second can be the first
 * heard back through the speaker-microphone loop with ASR word errors.
 * @param left - Normalized transcript.
 * @param right - Normalized spoken text or sentence.
 * @returns True when character-bigram similarity is at least 0.55.
 */
function similar(left: string, right: string): boolean {
  if (left.length < 2 || right.length < 2) return left === right
  const leftGrams = bigrams(left)
  const rightGrams = bigrams(right)
  let shared = 0
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared++
  return (2 * shared) / (leftGrams.size + rightGrams.size) >= 0.55
}

/** Clause terminators: streaming synthesizes comma-carried lines as one unit, and the echo's VAD segments at those pauses. */
const CLAUSE_SPLIT = /[。！？!?；;，,\n]+/

/** One retained echo guard: the whole normalized sentence plus its clause fragments. */
type SpeechGuard = { text: string; parts: string[]; until: number }

/**
 * Whether a normalized transcript echoes spoken text: an exact substring, or a
 * fuzzy match against the whole sentence or any of its clauses (comma-carried
 * streamed lines, whose echo arrives VAD-segmented per pause).
 * @param clean - Normalized transcript.
 * @param guard - Retained guard for speech sent toward the speaker.
 * @returns True when the transcript should be treated as echo.
 */
function isEcho(clean: string, guard: SpeechGuard): boolean {
  if (clean.length >= 2 && (guard.text.includes(clean) || clean.includes(guard.text))) return true
  const grams = bigrams(clean)
  return [guard.text, ...guard.parts].some((part) => {
    if (part.length < 2) return false
    if (similar(clean, part)) return true
    // A mid-clause fragment of a long clause still shares most of its bigrams
    // with the whole, while Dice collapses on the length gap.
    if (clean.length >= 6 && grams.size > 0) {
      let shared = 0
      const target = bigrams(part)
      for (const gram of grams) if (target.has(gram)) shared++
      if (shared / grams.size >= 0.65) return true
    }
    // ASR can rewrite whole words with no shared characters at all ("男友"
    // heard as "哪有"); ordered alignment still recognizes the fragment.
    if (clean.length >= 4 && lcsRatio(clean, part) >= 0.6) return true
    return false
  })
}
/** Result of wake, stop-command, and echo admission. */
export type Admission = { kind: 'ignore' } | { kind: 'wake' } | { kind: 'stop'; cancelAgent: boolean } | { kind: 'prompt'; text: string; woke?: true }
/** Per-connection gate; only accepted human activity renews its dialogue window. */
export class WakeGate {
  private activeUntil = 0
  private recentSpeech: SpeechGuard[] = []
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
    const clean = normalize(text)
    // The gateway calls this once per relayed audio frame; a frame refreshes
    // the window of the sentence already playing instead of appending a new
    // entry, so the ring keeps distinct sentences rather than N copies of the
    // current one squeezing the sentence whose echo is still in flight.
    const latest = this.recentSpeech[this.recentSpeech.length - 1]
    if (latest !== undefined && latest.text === clean) { latest.until = now + this.echoGuardMs; return }
    this.recentSpeech = this.recentSpeech.filter(item => item.until > now).slice(-5)
    this.recentSpeech.push({
      text: clean,
      // Clauses are split before normalization: normalized text carries no
      // punctuation, so splitting there would never split anything.
      parts: text.split(CLAUSE_SPLIT).map(normalize).filter(part => part.length >= 2),
      until: now + this.echoGuardMs,
    })
  }
  /**
   * Reopen the dialogue window after a response finishes.
   * @param now - Current wall-clock time in milliseconds.
   */
  resume(now: number): void { this.activeUntil = now + this.timeoutMs }
  /**
   * Compact echo-guard state for admission diagnostics.
   * @param now - Current wall-clock time in milliseconds.
   * @returns One entry per live guard: text and remaining milliseconds.
   */
  guardState(now: number): string {
    const live = this.recentSpeech.filter(item => item.until > now)
    return live.length === 0 ? 'none'
      : live.map(item => `${JSON.stringify(item.text)}(${item.parts.length}句)${item.until - now}ms`).join(' | ')
  }
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
    if (this.recentSpeech.some(item => isEcho(clean, item))) return { kind: 'ignore' }
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
    if (!woke) {
      // The echo guard above already drops transcripts of our own TTS heard back through
      // the microphone, so speech while busy that survived it is genuine user input:
      // the connection layer decides barge-in (allowBargeIn) instead of dropping it here.
      // Blanket-ignoring busy speech would invite-then-ignore right after a wake
      // greeting told the user to speak.
      if (!busy && now >= this.activeUntil) return { kind: 'ignore' }
    }
    this.activeUntil = now + this.timeoutMs
    if (!normalize(remaining)) return { kind: 'wake' }
    if ([...this.stopWords, ...this.cancelWords].some(word => normalize(word) === normalize(remaining))) return { kind: 'stop', cancelAgent: this.cancelWords.some(word => normalize(word) === normalize(remaining)) }
    return { kind: 'prompt', text: remaining, ...(woke ? { woke: true as const } : {}) }
  }
}
/**
 * Remove chain-of-thought that some OpenAI-compatible backends inline into text
 * blocks instead of native thinking blocks.
 */
function stripInlineThinking(text: string): string {
  return text.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, '')
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, '')
    .replace(/<\/(?:think|thinking|reasoning)>/gi, '')
}

/**
 * Project assistant prose into speakable text.
 * @param text - Committed assistant text.
 * @returns Text with chain-of-thought, fenced code, URLs, images, and Markdown decoration removed.
 */
export function speechText(text: string): string {
  return stripInlineThinking(text).replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s]*[#>*-]+\s*/gm, '').replace(/[`*_]/g, '').trim()
}

/**
 * Project display prose into synthesis text: the client keeps the leading
 * emoji for its transcript and expression affordances, but TTS must not
 * read it, so every emoji sequence drops out of the synthesized payload.
 * @param text - speakable text as shown to the user.
 * @returns the same text without emoji sequences.
 */
export function speechSynthesisText(text: string): string {
  return text.replace(EMOJI_PATTERN, '').replace(/ {2,}/g, ' ').trim()
}
