// Calibrate the token estimator against REAL provider-reported usage, using
// local DSH session logs (.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd).
//
// DSH writes multi-frame zstd JSONL. `assistant/message` records carry the
// provider's actual usage: inputTokens (cache miss) + cacheReadTokens (cache
// hit) + cacheWriteTokens. We reconstruct the exact visible context that was
// sent at that step (system prompt + tool schemas + every message/tool result
// so far, in chars) and take chars/token = contextChars / promptTokens.
//
// The aggregate is the model's real chars/token on this machine's agent
// traffic (code + tool JSON + English). It is used to calibrate src/tokens.mjs.
// Only aggregate counts are printed -- no message content.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ||
  path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function readZstdJsonl(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  let i = 0
  while (true) {
    const idx = buf.indexOf(MAGIC, i)
    if (idx < 0) break
    starts.push(idx)
    i = idx + 4
  }
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch { /* tail */ }
  }
  return out.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}

const blockText = (b) => {
  if (!b || typeof b !== 'object') return 0
  if (typeof b.text === 'string') return b.text.length
  if (b.type === 'tool-call') return (b.name?.length || 0) + (b.arguments?.length || 0) + 24
  return 0
}
const contentChars = (msg) => {
  if (!msg) return 0
  if (typeof msg.content === 'string') return msg.content.length
  if (!Array.isArray(msg.content)) return 0
  return msg.content.reduce((a, b) => a + blockText(b), 0)
}

export function calibrateSession(recs) {
  let systemChars = 0
  let toolsChars = 0
  let convoChars = 0
  const samples = []
  for (const rec of recs) {
    if (rec.type === 'system/message') systemChars += contentChars(rec.data?.message)
    else if (rec.type === 'request/header') toolsChars = JSON.stringify(rec.data?.header?.tools ?? []).length
    else if (rec.type === 'user/message' || rec.type === 'agent/inbox/spliced') {
      const ins = rec.data?.inserted
      if (Array.isArray(ins)) for (const m of ins) convoChars += contentChars(m) + 16
      else convoChars += contentChars(rec.data) + 16
    } else if (rec.type === 'assistant/message') {
      convoChars += contentChars(rec.data?.message) + 16
      const u = rec.data?.usage
      if (u) {
        const prompt = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
        if (prompt >= 1000) {
          const ctx = systemChars + toolsChars + convoChars
          samples.push({ prompt, ctx, out: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: u.cacheWriteTokens ?? 0, input: u.inputTokens ?? 0 })
        }
      }
    } else if (rec.type === 'tool/result') {
      convoChars += contentChars(rec.data?.message ?? rec.data) + 16
    }
  }
  return samples
}

export function calibrate({ limitSessions = 50, verbose = false } = {}) {
  if (!fs.existsSync(SESSIONS_ROOT)) return { available: false, sessions: [], note: `no sessions at ${SESSIONS_ROOT}` }
  const rows = []
  for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
    const wsDir = path.join(SESSIONS_ROOT, ws)
    let entries = []
    try { entries = fs.readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const f = path.join(wsDir, e.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      let recs
      try { recs = readZstdJsonl(f) } catch { continue }
      const samples = calibrateSession(recs)
      if (!samples.length) continue
      let prompt = 0, ctx = 0, out = 0, cacheRead = 0, cacheWrite = 0, input = 0
      for (const s of samples) { prompt += s.prompt; ctx += s.ctx; out += s.out; cacheRead += s.cacheRead; cacheWrite += s.cacheWrite; input += s.input }
      rows.push({ session: e.name.slice(0, 8), recs: recs.length, samples: samples.length, prompt, ctx, ratio: ctx / prompt, out, cacheRead, cacheWrite, input })
      if (rows.length >= limitSessions) break
    }
    if (rows.length >= limitSessions) break
  }
  const prompt = rows.reduce((a, r) => a + r.prompt, 0)
  const ctx = rows.reduce((a, r) => a + r.ctx, 0)
  const result = {
    available: rows.length > 0,
    rows,
    samples: rows.reduce((a, r) => a + r.samples, 0),
    promptTokens: prompt,
    contextChars: ctx,
    charsPerToken: prompt ? ctx / prompt : null,
    cacheHitShare: rows.reduce((a, r) => a + r.cacheRead, 0) / Math.max(1, prompt + rows.reduce((a, r) => a + r.cacheRead, 0)),
  }
  if (verbose) {
    for (const r of rows) console.log(`${r.session} recs=${r.recs} n=${r.samples} promptTok=${r.prompt} ctxChars=${r.ctx} chars/tok=${r.ratio.toFixed(3)} cacheRead=${r.cacheRead}`)
    console.log(`TOTAL n=${result.samples} promptTokens=${result.promptTokens} ctxChars=${result.contextChars} chars/token=${result.charsPerToken.toFixed(3)}`)
  }
  return result
}

if (process.argv[1]?.endsWith('calibrate-session.mjs')) {
  const r = calibrate({ verbose: true })
  if (!r.available) console.log('calibration unavailable:', r.note)
  else console.log(JSON.stringify({ charsPerToken: Number(r.charsPerToken.toFixed(3)), samples: r.samples, sessions: r.rows.length, promptTokens: r.promptTokens, contextChars: r.contextChars }, null, 2))
}
