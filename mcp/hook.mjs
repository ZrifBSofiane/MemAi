// Claude Code (and generic) SessionStart hook: inject the MemAi project card
// as `additionalContext`.
//
// Two invocation forms:
//   memai hook card                 -> JSON on stdout for Claude Code hooks:
//                                     {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
//   memai hook card --text          -> raw card text (for AGENTS.md-style hosts,
//                                     DSH instructions or shell debugging)
//   memai hook card --event SubagentStart
//
// Design rules:
//   * never fail a session: any problem is logged to stderr and we exit 0;
//   * byte-stable output when the corpus has not changed (content-addressed
//     card + no timestamps), so provider prefix caching can hit;
//   * read-only: the hook never creates a store or indexes. `memai init` does
//     that explicitly.
import { openProject, closeProject } from './paths.mjs'
import { estTokens } from '../src/tokens.mjs'

export const HOOK_EVENTS = ['SessionStart', 'SubagentStart']

const CARD_RULES = [
  '# MemAi paged memory for this repository',
  '# Prefer mem {op:"fault", target:"<symbol>"} over reading whole files; use {"op":"query"} to find symbols first.',
  '# On resume use {"op":"diff","since":"<version>"} instead of re-reading; call {"op":"index"} after edits.',
].join('\n')

/**
 * Build the text injected into the session. Returns null when there is no
 * indexed card yet.
 */
export function buildHookContext({ root = null, db = null, env = process.env, cwd = process.cwd(), maxTokens = 700 } = {}) {
  const project = openProject({ root, db, env, cwd, create: false })
  try {
    if (!project.exists) return null
    const card = project.pages.card({ budget: maxTokens })
    if (!card.ok || !card.text) return null
    return `${CARD_RULES}\n\n${card.text}`
  } finally {
    closeProject(project)
  }
}

/**
 * Produce the exact stdout payload for `memai hook card`.
 * Returns `{ text, tokens, json }`:
 *   json — the object to print as JSON, or null when there is no card yet (callers must stay
 *          silent in that case: a SessionStart hook that prints nothing is a valid no-op)
 *   text — raw additional context (for --text)
 */
export function hookCardPayload({ root = null, db = null, env = process.env, cwd = process.cwd(), event = 'SessionStart' } = {}) {
  if (!HOOK_EVENTS.includes(event)) throw new Error(`unknown hook event: ${event} (expected ${HOOK_EVENTS.join(' or ')})`)
  const additionalContext = buildHookContext({ root, db, env, cwd })
  if (!additionalContext) {
    return { text: '', tokens: 0, json: null }
  }
  return {
    text: additionalContext,
    tokens: estTokens(additionalContext),
    json: { hookSpecificOutput: { hookEventName: event, additionalContext } },
  }
}
