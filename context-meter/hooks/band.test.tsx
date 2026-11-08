import { expect, test } from 'claude-code/testing'

test('band draws coloured meter with hover help on every surface', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: '2099-01-01T00:00:00Z' }], cost: { usd: 1.5 } } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Scan transcripts', status: 'running' }, { id: 'a2', type: 'Plan', description: 'Design', status: 'completed' }] }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-meter', component: 'AbovePrompt', surface, props: { hasSurvey: false } } as never)
    expect((await ui.find({ type: 'Text', text: /opus-5-5/ }))?.text).toContain('opus-5-5')
    expect((await ui.find({ type: 'Text', text: /42%/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /weekly rate limit/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Scan transcripts/ }))).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /✓/ }))).toBeTruthy()
    await ui.unmount()
  }
})
