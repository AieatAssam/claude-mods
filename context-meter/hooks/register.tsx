import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'
import { agentRows, bar, dur, k, level, money, snap, shortModel, type Cut, type Last, type Tracked } from './format'
import type { AgentRow } from '../types'

// ponytail: thresholds hardcoded; make them userConfig options if you want to tune them.
const CTX_WARN = [60, 80] as const
const LIMIT_WARN = 80
const TICK_MS = 5000 // redraws ↻ countdowns and live subagent times
const STALE_MS = 30_000 // with nothing running, still refresh this often
const LEGEND_DELAY_MS = 700 // a pointer just passing over ⓘ must not open the legend
const LEGEND_HIDE_MS = 300 // leaving ⓘ for a moment (a redraw, a twitch) must not close it
const FOLLOW_UP_MS = 1500 // the cost ledger can lag a subagent's turn.complete
const PLACEHOLDER_WINDOW = 200_000
const LEGEND_KEY = 'legend-trigger'

const AGENT_ICON: Record<AgentRow['state'], string> = { running: '●', waiting: '◌', done: '✓', failed: '✗' }
const AGENT_COLOR: Record<AgentRow['state'], string> = { running: 'suggestion', waiting: 'warning', done: 'success', failed: 'error' }
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const snapAtom = atom({ plugin: 'context-meter', key: 'snap' } as const, null)
const legendAtom = atom({ plugin: 'context-meter', key: 'legend' } as const, false)

let tools = 0
let last: Last = null
let mainCtx: number | undefined // the main thread's latest request, live mid-turn
let cut: Cut | undefined // auto-compact facts for cutModel; undefined = ask again
let cutModel = ''
const warned = new Set<string>()
const seen = new Map<string, Tracked>()
let hasRunning = false
let primed = false // false until the first refresh of this load
let busy = false
let dirty = false
let lastRefresh = 0
let tick: Timer | undefined
let followUp: Timer | undefined
let legendTimer: Timer | undefined
let legendHide: Timer | undefined

const pickCut = (b?: { autoCompactThreshold?: number; isAutoCompactEnabled: boolean }): Cut =>
  b ? { autoCompactThreshold: b.autoCompactThreshold, isAutoCompactEnabled: b.isAutoCompactEnabled } : {}

const ctxText = (pct: number, basis?: 'autocompact' | 'window') =>
  basis === 'autocompact'
    ? `Context ${pct}% of the way to auto-compact: /compact or start a fresh session soon`
    : `Context ${pct}% full: /compact or start a fresh session soon`

async function doRefresh($: EngineInterface) {
  const model = await $.session.model()
  // The breakdown is a local estimate, but it is still work: ask once per model, reuse the rest.
  let u: SessionUsage
  if (cut && cutModel === model) {
    u = await $.session.usage()
  } else {
    u = await $.session.usage({ breakdown: 'summary' })
    cut = pickCut(u.context.breakdown)
    cutModel = model
  }
  const [turns, now, list, prev] = await Promise.all([$.session.turns(), $.clock.now(), $.agent.list(), read($, snapAtom)])
  lastRefresh = now
  if (!last) last = prev?.last ?? null // after a reload the module is fresh; the band still has the last turn
  const agents = agentRows(list, seen, now)
  hasRunning = agents.some(a => a.state === 'running')
  const s = snap(u, model, turns, last, now, agents, cut, mainCtx)
  await update($, snapAtom, () => s)
  $.ui.status(undefined) // clear the plain-text line v0.1 pinned

  // After a reload, thresholds already passed are marked without a toast.
  const quiet = !primed
  primed = true
  const pct = s.ctx?.pct ?? 0
  for (const t of CTX_WARN) {
    if (pct >= t && !warned.has(`ctx${t}`)) {
      warned.add(`ctx${t}`)
      if (!quiet) $.ui.toast(ctxText(pct, s.ctx?.basis))
    }
  }
  if (pct < CTX_WARN[0]) CTX_WARN.forEach(t => warned.delete(`ctx${t}`)) // re-arm after compaction

  for (const r of u.rateLimits) {
    const key = `rl-${r.kind}-${r.resetsAt}`
    if (r.percentUsed >= LIMIT_WARN && !warned.has(key)) {
      warned.add(key)
      if (!quiet) $.ui.toast(`${r.kind.replace('_', '-')} limit ${Math.round(r.percentUsed)}% used`)
    }
  }
}

/** One refresh at a time. A call that lands mid-run sets a flag and the running one goes round again. */
async function refresh($: EngineInterface) {
  if (busy) {
    dirty = true
    return
  }
  busy = true
  try {
    do {
      dirty = false
      await doRefresh($)
    } while (dirty)
  } catch {
    // a failed refresh keeps the band as it was; the next event tries again
  } finally {
    busy = false
  }
}

async function tickCheck($: EngineInterface) {
  if (hasRunning || (await $.clock.now()) - lastRefresh >= STALE_MS) await refresh($)
}

async function setLegend($: EngineInterface, on: boolean) {
  await update($, legendAtom, () => on)
}

async function toggleLegend($: EngineInterface) {
  await update($, legendAtom, v => !v)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // Draw at once with what is known; the refresh fills in the rest.
    const model = await $.session.model()
    const prev = await read($, snapAtom)
    await update($, snapAtom, () => ({ model: shortModel(model), ctx: null, window: PLACEHOLDER_WINDOW, limits: [], usd: null, turns: 0, last: prev?.last ?? null, agents: [] }))
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => void tickCheck($))
    await refresh($)
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await refresh($)
    return r
  })

  // /clear and resume end the session but no session.start follows: keep the tick, reset, and redraw fresh.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    followUp?.cancel()
    legendTimer?.cancel()
    legendHide?.cancel()
    followUp = undefined
    legendTimer = undefined
    legendHide = undefined
    seen.clear()
    warned.clear()
    last = null
    tools = 0
    cut = undefined
    mainCtx = undefined
    hasRunning = false
    primed = false
    await update($, snapAtom, () => null)
    void refresh($)
    return r
  })

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    cut = undefined
    await refresh($)
    return r
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    cut = undefined
    await refresh($)
    return r
  })

  on('classic.PostCompact', async ($, e, next) => {
    const r = await next(e)
    cut = undefined
    mainCtx = undefined
    await refresh($)
    return r
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) void refresh($)
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

  // Each model request: a subagent's input size is its context; the main thread's is kept live for the bar.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r.usage) {
      const input = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      const t = e.agentId ? seen.get(e.agentId) : undefined
      if (t) t.ctx = input
      if (!e.agentId) {
        mainCtx = input
        void refresh($)
      }
    }
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
      followUp?.cancel()
      followUp = $.clock.after(FOLLOW_UP_MS, () => void refresh($))
    } else {
      last = { seconds: Math.round(e.durationMs / 1000), tools }
    }
    await refresh($)
    return r
  })

  // The ⓘ on Client surfaces: open the legend only after a short hover.
  on('ui.message', ($, e, next) => {
    if (e.element === LEGEND_KEY) {
      if (e.data === 'enter') {
        legendHide?.cancel()
        legendHide = undefined
        legendTimer ??= $.clock.after(LEGEND_DELAY_MS, () => void setLegend($, true))
      } else if (e.data === 'leave') {
        legendTimer?.cancel()
        legendTimer = undefined
        legendHide?.cancel()
        legendHide = $.clock.after(LEGEND_HIDE_MS, () => void setLegend($, false))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapAtom)
    if (!s || e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Client = 'Client' in els ? els.Client : null // only terminal and desktop have it
    const narrow = e.props.bodyColumns < 90
    const legend = await read($, legendAtom)
    const pointer = e.surface === 'terminal' || e.surface === 'desktop'
    const meter = bar(s.ctx?.pct ?? 0)
    const lvl = s.ctx ? level(s.ctx.pct) : 'subtle'

    return (
      <Box key="meter" flexDirection="column">
        {/* The legend sits above line 1: the band is pinned to the prompt, so it grows upward and ⓘ stays put. */}
        {legend ? (
          <Box key="legend-card" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            <Text><Text color="claude" bold>{s.model}</Text><Text color="subtle">  model running this session</Text></Text>
            <Text>
              <Text color="success">━━─</Text>
              <Text color="subtle"> context used: last request's tokens / auto-compact point (or model window when auto-compact is off). </Text>
              <Text color="success">green</Text><Text color="subtle"> &lt;60%, </Text>
              <Text color="warning">amber</Text><Text color="subtle"> &lt;80%, </Text>
              <Text color="error">red</Text><Text color="subtle"> → /compact or fresh session</Text>
            </Text>
            <Text><Text color="ide">5h / 7d</Text><Text color="subtle">  share of your plan's 5-hour and weekly rate limit used; ↻ time until it resets</Text></Text>
            <Text><Text color="merged">$</Text><Text color="subtle">  session cost so far, as /cost totals it (a resumed session counts from its first launch)</Text></Text>
            <Text><Text color="suggestion">↵</Text><Text color="subtle">  prompts you've sent this session</Text></Text>
            <Text color="subtle">s · ⚒  how long the last turn took, and how many tool calls it made</Text>
            <Text>
              <Text color="subtle">⑂ subagents: </Text>
              <Text color="suggestion">● running</Text><Text color="subtle">, </Text>
              <Text color="warning">◌ waiting</Text><Text color="subtle">, </Text>
              <Text color="success">✓ done</Text><Text color="subtle">, </Text>
              <Text color="error">✗ failed</Text>
              <Text color="subtle">; type·model, task, ◔ its context (green/amber/red vs its model's window: 200k, or 1M for [1m] models), time running · tool calls. Finished ones stay 2 min.</Text>
            </Text>
          </Box>
        ) : null}
        <Box key="line" flexDirection="row" flexWrap="wrap" gap={2}>
          <Text color="claude" bold>{s.model}</Text>
          {s.ctx ? (
            <Box key="ctx" flexDirection="row" gap={1}>
              <Box flexDirection="row">
                <Text color={lvl}>{meter.on}</Text>
                <Text color="subtle">{meter.off}</Text>
              </Box>
              <Text color={lvl} bold>{s.ctx.pct}%</Text>
              {narrow ? null : <Text color="subtle">{k(s.ctx.tokens)}/{k(s.ctx.window)}</Text>}
            </Box>
          ) : (
            <Box key="ctx" flexDirection="row" gap={1}>
              <Text color="subtle">{bar(0).off}</Text>
              {narrow ? null : <Text color="subtle">–/{k(s.window)}</Text>}
            </Box>
          )}
          {s.limits.map(l => (
            <Box key={l.name} flexDirection="row" gap={1}>
              <Text color="subtle">{l.name}</Text>
              <Text color={level(l.pct)} bold>{l.pct}%</Text>
              {narrow || !l.reset ? null : <Text color="subtle">↻{l.reset}</Text>}
            </Box>
          ))}
          {s.usd !== null ? <Text color="merged">{money(s.usd)}</Text> : null}
          <Text color="suggestion">{s.turns}↵</Text>
          {s.last ? <Text color="subtle">{s.last.seconds}s{narrow ? '' : ` · ${s.last.tools}⚒`}</Text> : null}
          {pointer && Client ? (
            <Client key={LEGEND_KEY} module="./legend-trigger.tsx" />
          ) : (
            <Button key="legend" label="?" onPress={() => void toggleLegend($)} />
          )}
        </Box>
        {s.agents?.length ? (
          <Box key="agents" flexDirection="column">
            {s.agents.map(a => {
              const done = a.state === 'done' || a.state === 'failed'
              return (
                <Box key={a.id} flexDirection="row" gap={1}>
                  <Text color={AGENT_COLOR[a.state]}>{AGENT_ICON[a.state]}</Text>
                  <Text color="ide" dimColor={done}>{a.type}</Text>
                  {a.model ? <Text color="claude" dimColor={done}>{a.model}</Text> : null}
                  <Text wrap="truncate-end" color={a.state === 'running' ? 'text' : 'subtle'} dimColor={done}>{clip(a.description, narrow ? 16 : 32)}</Text>
                  {a.ctx ? <Text color={level((a.ctx / a.window) * 100)}>◔{k(a.ctx)}</Text> : null}
                  <Text color="subtle">{dur(a.seconds)}{narrow || !a.tools ? '' : ` · ${a.tools}⚒`}</Text>
                </Box>
              )
            })}
          </Box>
        ) : null}
      </Box>
    )
  })
}
