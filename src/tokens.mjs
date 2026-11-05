// Token accounting for MemAi.
//
// WHY: the monetised, rate-limited resource is model tokens, not disk or CPU.
// So every response is measured and budgeted in tokens.
//
// ESTIMATOR: tokens = ceil(chars / CHARS_PER_TOKEN).
// A BPE tokenizer is unavailable offline, so chars/4 is the textbook default.
// We calibrate it against the *real* DeepSeek tokenizer using provider-reported
// usage in this machine's DSH session logs (`tools/calibrate-session.mjs`):
//
//   6 real sessions, 252 assistant turns, 37,092,363 prompt tokens
//   (inputTokens + cacheReadTokens + cacheWriteTokens) vs 147,103,482 chars
//   of reconstructed visible context  =>  3.966 chars/token.
//
// chars/4 therefore under-counts tokens by ~0.9% on real agent traffic
// (code + tool-call JSON + English). We use the measured 3.966.
// Re-run the calibration and pass --cpt to override for another model.
export const DEFAULT_CHARS_PER_TOKEN = 3.966

let CPT = DEFAULT_CHARS_PER_TOKEN

/** Set the chars-per-token constant (e.g. from calibration or the CLI). */
export function setCharsPerToken(v) {
  if (!(typeof v === 'number' && isFinite(v) && v > 1 && v < 20)) throw new Error(`bad chars/token: ${v}`)
  CPT = v
}
export function charsPerToken() { return CPT }

/** Estimate model tokens for a string. Deterministic, no tokenizer needed. */
export function estTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / CPT)
}

/** Estimate tokens of a JSON-serialisable payload exactly as sent (JSON text). */
export function estPayloadTokens(obj) {
  return estTokens(typeof obj === 'string' ? obj : JSON.stringify(obj))
}

/**
 * Truncate `text` so that estTokens(result.text) <= budget, cutting on a line
 * boundary and appending a compact marker. Never returns more than `budget`
 * tokens (for budget <= 0 returns an empty body).
 * @returns {{text:string, tokens:number, truncated:boolean, omittedLines:number, omittedTokens:number}}
 */
export function clampText(text, budget) {
  const total = estTokens(text)
  if (budget <= 0) return { text: '', tokens: 0, truncated: text.length > 0, omittedLines: lineCount(text), omittedTokens: total }
  if (total <= budget) return { text, tokens: total, truncated: false, omittedLines: 0, omittedTokens: 0 }
  const lines = text.split('\n')
  // Reserve room for the marker itself (it is computed after we know the cut).
  let lo = 0
  let hi = lines.length
  let best = ''
  let bestLines = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const body = lines.slice(0, mid).join('\n')
    const marker = `\n… [truncated: ${lines.length - mid} lines / ~${total - estTokens(body)} tokens omitted; use a tighter target]`
    const candidate = body + marker
    if (estTokens(candidate) <= budget) { best = candidate; bestLines = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (!best) return { text: '', tokens: 0, truncated: true, omittedLines: lines.length, omittedTokens: total }
  const kept = lines.slice(0, bestLines).join('\n')
  return {
    text: best,
    tokens: estTokens(best),
    truncated: true,
    omittedLines: lines.length - bestLines,
    omittedTokens: Math.max(0, total - estTokens(kept)),
  }
}

function lineCount(s) { return s ? s.split('\n').length : 0 }

/** char length of the longest prefix of `lines` whose tokens fit in budget. */
export function clampLines(lines, budget) { return clampText(lines.join('\n'), budget) }
