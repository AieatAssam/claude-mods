export type Snap = {
  model: string
  /** basis: 'autocompact' when measured against the auto-compact point, 'window' when against the model window */
  ctx: { pct: number; tokens: number; window: number; basis: 'autocompact' | 'window' } | null
  window: number
  limits: { name: string; pct: number; reset: string }[]
  usd: number | null
  turns: number
  last: { seconds: number; tools: number } | null
  agents?: AgentRow[]
}

export type AgentRow = {
  id: string
  type: string
  description: string
  model: string
  seconds: number
  tools: number
  /** input tokens on its latest model request; 0 before the first */
  ctx: number
  /** the window its ctx is measured against: 200k, or 1M for a [1m] model */
  window: number
  /** estimated USD from its requests' tokens at list prices; 0 before the first */
  usd: number
  /** running | waiting | done | failed */
  state: 'running' | 'waiting' | 'done' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { snap: Snap | null; legend: boolean }
  }
}
