import { expect, test } from 'claude-code/testing'
import { agentRows, bar, dur, level, limitOf, shortModel, snap, until } from './format'

const NOW = Date.parse('2026-11-08T12:00:00Z')

test('formats the pieces', async () => {
  expect(bar(42)).toBe('▰▰▰▰▱▱▱▱▱▱')
  expect(bar(150)).toBe('▰▰▰▰▰▰▰▰▰▰')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus-5-5')
  expect(until('2026-11-08T14:10:00Z', NOW)).toBe('2h10')
  expect(until('2026-11-08T11:00:00Z', NOW)).toBe('')
  expect([level(10), level(60), level(80)]).toEqual(['success', 'warning', 'error'])
})

test('snapshots usage', async () => {
  const s = snap(
    {
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 31.4, resetsAt: '2026-11-08T12:45:00Z' }],
      cost: { usd: 3.414 },
    },
    'claude-opus-5-5', 18, { seconds: 47, tools: 12 }, NOW,
  )
  expect(s.ctx).toEqual({ pct: 42, tokens: 84_000, window: 200_000 })
  expect(s.limits).toEqual([{ name: '5h', pct: 31, reset: '45m' }])
  expect(snap({ context: { window: 1e6 }, rateLimits: [] }, 'sonnet', 1, null, NOW).ctx).toBe(null)
})

test('agent rows: tracked model/time/tools, finished ones expire', async () => {
  expect([dur(5), dur(80), dur(3700)]).toEqual(['5s', '1m20', '1h01'])
  const seen = new Map([
    ['a1', { model: 'claude-haiku-5-5', startedAt: NOW - 80_000, tools: 14, ctx: 0 }],
    ['a2', { model: 'opus', startedAt: NOW - 600_000, endedAt: NOW - 300_000, tools: 3 }],
  ])
  const rows = agentRows([
    { id: 'a1', type: 'Explore', description: 'Scan', status: 'running' },
    { id: 'a2', type: 'Plan', description: 'Old', status: 'completed' },
    { id: 'a3', type: 'general-purpose', description: 'Untracked', status: 'killed' },
  ], seen, NOW)
  expect(rows).toEqual([
    { id: 'a1', type: 'Explore', description: 'Scan', model: 'haiku-5-5', seconds: 80, tools: 14, ctx: 0, state: 'running' },
    { id: 'a3', type: 'general-purpose', description: 'Untracked', model: '', seconds: 0, tools: 0, ctx: 0, state: 'failed' },
  ])
})

test('bar measures against the auto-compact point, whatever it is set to', async () => {
  const at = (threshold?: number, raw?: number) => ({
    context: { tokens: 150_000, window: 1_000_000, percent: 15, breakdown: threshold || raw ? { autoCompactThreshold: threshold, rawMaxTokens: raw ?? 1_000_000 } as never : undefined },
    rateLimits: [],
  })
  expect(limitOf(at(300_000))).toBe(300_000)
  expect(snap(at(300_000), 'opus', 1, null, NOW).ctx).toEqual({ pct: 50, tokens: 150_000, window: 300_000 })
  expect(snap(at(200_000), 'opus', 1, null, NOW).ctx?.pct).toBe(75) // changed via /autocompact
  expect(snap(at(undefined, 400_000), 'opus', 1, null, NOW).ctx?.pct).toBe(38) // auto-compact off: compaction window
  expect(snap(at(), 'opus', 1, null, NOW).ctx?.pct).toBe(15) // no breakdown: model window
})
