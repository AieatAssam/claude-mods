import type { AgentInfo, SessionUsage } from 'claude-code'
import type { AgentRow, Snap } from '../types'

export type Tracked = { model: string; startedAt: number; endedAt?: number; tools: number; ctx?: number; usd?: number }
export type Usage = Omit<SessionUsage, 'startedAt'>
/** Auto-compaction facts from /context's breakdown, cached per model. */
export type Cut = { autoCompactThreshold?: number; isAutoCompactEnabled?: boolean }

export const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${s}s`)

const STATE: Record<AgentInfo['status'], AgentRow['state']> = {
  pending: 'running', running: 'running', waiting: 'waiting', idle: 'waiting',
  completed: 'done', failed: 'failed', killed: 'failed',
}

// ponytail: list prices per MTok (cached 2026-11), by family; update when prices change.
// [input, output, cache read]; cache writes bill at 1.25x input (5-minute TTL).
const PRICES: [RegExp, number, number, number][] = [
  [/fable|mythos/i, 8, 40, 0.2],
  [/opus/i, 4, 20, 0.2],
  [/sonnet/i, 2, 10, 0.1],
  [/haiku/i, 0.1, 0.5, 0.01],
]
type Tokens = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** One request's cost at list price; 0 for a model we have no price for. Haiku 5.5 prompts over 100k bill 5x. */
export const requestUsd = (model: string, u: Tokens) => {
  const p = PRICES.find(([re]) => re.test(model))
  if (!p) return 0
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const x = /haiku/i.test(model) && prompt > 100_000 ? 5 : 1
  const [, inp, out, read] = p
  return (x * (u.input_tokens * inp + u.cache_creation_input_tokens * inp * 1.25 + u.cache_read_input_tokens * read + u.output_tokens * out)) / 1e6
}

/** A subagent's window: 1M when its model string says [1m], else 200k. */
export const subagentWindow = (rawModel: string) => (/\[1m\]/i.test(rawModel) ? 1_000_000 : 200_000)

/** Agents from $.agent.list(), enriched with what the spawn/tool hooks saw. Finished ones linger 2 min. */
export const agentRows = (list: AgentInfo[], seen: Map<string, Tracked>, now: number): AgentRow[] =>
  list.flatMap(a => {
    const t = seen.get(a.id)
    const state = STATE[a.status]
    const end = state === 'done' || state === 'failed' ? t?.endedAt ?? now : now
    if (t?.endedAt && now - t.endedAt > 120_000) return []
    return [{
      id: a.id,
      type: a.type,
      description: a.name ?? a.description,
      model: t ? shortModel(t.model) : '',
      seconds: t ? Math.max(0, Math.round((end - t.startedAt) / 1000)) : 0,
      tools: t?.tools ?? 0,
      ctx: t?.ctx ?? 0,
      window: subagentWindow(t?.model ?? ''),
      usd: t?.usd ?? 0,
      state,
    }]
  })

export type Last = { seconds: number; tools: number } | null

/** Filled and empty parts as two spans of one glyph width, so the empty part can be drawn dim. */
export const bar = (pct: number, width = 8) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '━'.repeat(filled), off: '─'.repeat(width - filled) }
}

export const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/** Under a cent reads "<$0.01", so a real but tiny cost never shows as $0.00. */
export const money = (usd: number) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`)

export const until = (iso: string | undefined, now: number) => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!(ms > 0)) return ''
  const m = Math.round(ms / 60000)
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}

/** green under 60%, amber under 80%, red from 80% */
export const level = (pct: number) => (pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'success')

const LIMIT_NAME: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// "claude-opus-5-5[1m]" / "Opus 5.5" → "opus-5-5"
export const shortModel = (m: string) => m.toLowerCase().replace(/^claude-/, '').replace(/[ .]/g, '-').replace(/\[.*\]$/, '')

/** What the bar measures against: the auto-compact point while auto-compaction is on, else the model window. */
export const limitOf = (window: number, cut?: Cut): { max: number; basis: 'autocompact' | 'window' } =>
  cut?.isAutoCompactEnabled && cut.autoCompactThreshold
    ? { max: cut.autoCompactThreshold, basis: 'autocompact' }
    : { max: window, basis: 'window' }

/** `live`, when set, replaces the usage's token count (the main thread's last request, seen mid-turn). */
export const snap = (u: Usage, model: string, turns: number, last: Last, now: number, agents: AgentRow[] = [], cut?: Cut, live?: number): Snap => {
  const { max, basis } = limitOf(u.context.window, cut)
  const tokens = live ?? u.context.tokens
  return {
    agents,
    model: shortModel(model),
    ctx: tokens === undefined ? null : { pct: Math.round((tokens / max) * 100), tokens, window: max, basis },
    window: max,
    limits: u.rateLimits.map(r => ({ name: LIMIT_NAME[r.kind] ?? r.kind, pct: Math.round(r.percentUsed), reset: until(r.resetsAt, now) })),
    usd: u.cost?.usd ?? null,
    turns,
    last,
  }
}
