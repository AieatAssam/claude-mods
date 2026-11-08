export type Snap = {
  model: string
  ctx: { pct: number; tokens: number; window: number } | null
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
  /** running | waiting | done | failed */
  state: 'running' | 'waiting' | 'done' | 'failed'
}

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { snap: Snap | null }
  }
}
