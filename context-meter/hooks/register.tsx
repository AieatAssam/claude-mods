import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { agentRows, bar, dur, k, level, snap, type Last, type Tracked } from './format'
import type { AgentRow } from '../types'

// ponytail: thresholds hardcoded; make them userConfig options if you want to tune them.
const CTX_WARN = [60, 80] as const
const LIMIT_WARN = 80

const AGENT_ICON: Record<AgentRow['state'], string> = { running: '●', waiting: '◌', done: '✓', failed: '✗' }
const AGENT_COLOR: Record<AgentRow['state'], string> = { running: 'suggestion', waiting: 'warning', done: 'success', failed: 'error' }
// ponytail: subagent colour assumes a 200k window; the API gives no per-model window to a mod.
const SUBAGENT_WINDOW = 200_000
const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const snapAtom =atom({ plugin: 'context-meter', key: 'snap' } as const, null)

let tools = 0
let last: Last = null
const warned = new Set<string>()
const seen = new Map<string, Tracked>()
let hasRunning = false

async function refresh($: EngineInterface) {
  // `summary` breakdown is a local estimate (no API call); we only want its auto-compact threshold.
  const [u, model, turns, now, list] = await Promise.all([$.session.usage({ breakdown: 'summary' }), $.session.model(), $.session.turns(), $.clock.now(), $.agent.list()])
  const agents = agentRows(list, seen, now)
  hasRunning = agents.some(a => a.state === 'running')
  const s = snap(u, model, turns, last, now, agents)
  await update($, snapAtom, () => s)
  $.ui.status(undefined) // clear the plain-text line v0.1 pinned

  const pct = s.ctx?.pct ?? 0
  for (const t of CTX_WARN) {
    if (pct >= t && !warned.has(`ctx${t}`)) {
      warned.add(`ctx${t}`)
      $.ui.toast(`Context ${pct}% of the way to auto-compact: /compact or start a fresh session soon`)
    }
  }
  if (pct < CTX_WARN[0]) CTX_WARN.forEach(t => warned.delete(`ctx${t}`)) // re-arm after compaction

  for (const r of u.rateLimits) {
    const key = `rl-${r.kind}-${r.resetsAt}`
    if (r.percentUsed >= LIMIT_WARN && !warned.has(key)) {
      warned.add(key)
      $.ui.toast(`${r.kind.replace('_', '-')} limit ${Math.round(r.percentUsed)}% used`)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    // ponytail: 5s tick only redraws while a subagent runs; elapsed times are coarse by design.
    $.clock.every(5000, () => (hasRunning ? refresh($) : undefined))
    return r
  })

  on('prompt.submit', ($, e, next) => {
    tools = 0
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      seen.set(r.agentId, { model: r.model, startedAt: await $.clock.now(), tools: 0 })
      await refresh($)
    }
    return r
  })

  // Each model request a subagent sends: keep its input size (uncached + cache read + cache write) as its context.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const t = e.agentId ? seen.get(e.agentId) : undefined
    if (t && r.usage) t.ctx = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
    return r
  })

  on('tool.call', ($, e, next) => {
    const t = e.agentId ? seen.get(e.agentId) : undefined
    if (t) t.tools += 1
    else if (!e.agentId) tools += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const t = seen.get(e.agentId)
      if (t) t.endedAt = await $.clock.now()
    } else {
      last = { seconds: Math.round(e.durationMs / 1000), tools }
    }
    await refresh($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapAtom)
    if (!s || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text color="subtle">  │  </Text>

    return (
      <Box key="meter" flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text color="claude" bold>{s.model}</Text>
          {sep}
          {s.ctx ? (
            <Text>
              <Text color={level(s.ctx.pct)}>{bar(s.ctx.pct)} {s.ctx.pct}%</Text>
              <Text color="subtle"> {k(s.ctx.tokens)}/{k(s.ctx.window)}</Text>
            </Text>
          ) : (
            <Text color="subtle">{bar(0)} –/{k(s.window)}</Text>
          )}
          {s.limits.map(l => (
            <Text>
              <Text color="subtle">  │  </Text>
              <Text color="ide">{l.name} </Text>
              <Text color={level(l.pct)}>{l.pct}%</Text>
              {l.reset ? <Text color="subtle"> ↻{l.reset}</Text> : null}
            </Text>
          ))}
          {s.usd !== null ? (
            <Text>
              <Text color="subtle">  │  </Text>
              <Text color="merged">${s.usd.toFixed(2)}</Text>
            </Text>
          ) : null}
          {sep}
          <Text color="suggestion">{s.turns}↵</Text>
          {s.last ? <Text color="subtle">  {s.last.seconds}s · {s.last.tools}⚒</Text> : null}
        </Box>
        {s.agents?.length ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Text color="subtle">⑂ </Text>
            {s.agents.map((a, i) => (
              <Text>
                {i ? <Text color="subtle">   </Text> : null}
                <Text color={AGENT_COLOR[a.state]}>{AGENT_ICON[a.state]} </Text>
                <Text color="ide">{a.type}</Text>
                {a.model ? <Text color="claude">·{a.model}</Text> : null}
                <Text color={a.state === 'running' ? 'text' : 'subtle'}> {clip(a.description)}</Text>
                {a.ctx ? <Text color={level((a.ctx / SUBAGENT_WINDOW) * 100)}> ◔{k(a.ctx)}</Text> : null}
                <Text color="subtle"> {dur(a.seconds)}{a.tools ? ` · ${a.tools}⚒` : ''}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        <Box display="none" hover={{ display: 'flex' }} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text><Text color="claude" bold>{s.model}</Text><Text color="subtle">  model running this session</Text></Text>
          <Text>
            <Text color="success">▰▰▱</Text>
            <Text color="subtle"> context used: tokens sent on the last request / your auto-compact point (100% = it compacts). </Text>
            <Text color="success">green</Text><Text color="subtle"> &lt;60%, </Text>
            <Text color="warning">amber</Text><Text color="subtle"> &lt;80%, </Text>
            <Text color="error">red</Text><Text color="subtle"> → /compact or fresh session</Text>
          </Text>
          <Text><Text color="ide">5h / 7d</Text><Text color="subtle">  share of your plan's 5-hour and weekly rate limit used; ↻ time until it resets</Text></Text>
          <Text><Text color="merged">$</Text><Text color="subtle">  API-equivalent cost of this session so far</Text></Text>
          <Text><Text color="suggestion">↵</Text><Text color="subtle">  prompts you've sent this session</Text></Text>
          <Text color="subtle">s · ⚒  how long the last turn took, and how many tool calls it made</Text>
          <Text>
            <Text color="subtle">⑂ subagents: </Text>
            <Text color="suggestion">● running</Text><Text color="subtle">, </Text>
            <Text color="warning">◌ waiting</Text><Text color="subtle">, </Text>
            <Text color="success">✓ done</Text><Text color="subtle">, </Text>
            <Text color="error">✗ failed</Text>
            <Text color="subtle">; type·model, task, ◔ its context (green/amber/red vs 200k), time running · tool calls. Finished ones stay 2 min.</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
