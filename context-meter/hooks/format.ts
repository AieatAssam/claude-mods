import type { AgentInfo, SessionUsage } from 'claude-code'
import type { AgentRow, Snap } from '../types'

export type Tracked = { model: string; startedAt: number; endedAt?: number; tools: number; ctx?: number }

export const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${s}s`)

const STATE: Record<AgentInfo['status'], AgentRow['state']> = {
  pending: 'running', running: 'running', waiting: 'waiting', idle: 'waiting',
  completed: 'done', failed: 'failed', killed: 'failed',
}

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
      state,
    }]
  })

export type Last = { seconds: number; tools: number } | null

export const bar = (pct: number, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

export const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

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

/** The token count to measure against: where auto-compact fires, else the compaction window, else the model window. */
export const limitOf = (u: Omit<SessionUsage, 'startedAt'>) =>
  u.context.breakdown?.autoCompactThreshold ?? u.context.breakdown?.rawMaxTokens ?? u.context.window

export const snap = (u: Omit<SessionUsage, 'startedAt'>, model: string, turns: number, last: Last, now: number, agents: AgentRow[] = []): Snap => {
  const max = limitOf(u)
  const { tokens } = u.context
  return {
  agents,
  model: shortModel(model),
  ctx: tokens === undefined ? null : { pct: Math.round((tokens / max) * 100), tokens, window: max },
  window: max,
  limits: u.rateLimits.map(r => ({ name: LIMIT_NAME[r.kind] ?? r.kind, pct: Math.round(r.percentUsed), reset: until(r.resetsAt, now) })),
  usd: u.cost?.usd ?? null,
  turns,
  last,
  }
}
