import type { On } from 'claude-code'
import { expect, mock, test, type Mounted } from 'claude-code/testing'

// The engine answers every call the band makes; the test clock moves only when a test advances it.
function setup(on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 84000, window: 200000, percent: 42 }, rateLimits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: '2099-01-01T00:00:00Z' }], cost: { usd: 1.5 } } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', description: 'Scan transcripts', status: 'running' }, { id: 'a2', type: 'Plan', description: 'Design', status: 'completed' }] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', () => ({ value: undefined }))
  return mock.clock(on, { now: 0 })
}

const band = { plugin: 'context-meter', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('band draws coloured meter and subagents on every surface', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...band, surface } as never)
    expect((await ui.find({ type: 'Text', text: /opus-5-5/ }))?.text).toContain('opus-5-5')
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /85%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Scan transcripts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeTruthy()
    // the ⓘ is a Client where the surface has one; the ? Button everywhere else
    const legendTrigger = surface === 'terminal' || surface === 'desktop' ? { type: 'Client', key: 'legend-trigger' } : { type: 'Button', key: 'legend' }
    expect(await ui.find(legendTrigger as never)).toBeTruthy()
    await ui.unmount()
  }
})

test('legend opens after a 700ms hover on ⓘ and closes when the pointer leaves', async ($, on) => {
  const clock = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = (await $.ui.mount({ ...band, surface: 'terminal' } as never)) as Mounted<'terminal'>
  const legend = () => ui.find({ type: 'Text', text: /context used/ })
  expect(await legend()).toBeFalsy()
  await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'legend-trigger' })
  await clock.advance(300)
  expect(await legend()).toBeFalsy() // a pass over ⓘ is not a hover
  await clock.advance(400)
  expect(await legend()).toBeTruthy()
  await ui.pointer({ type: 'leave', x: 0, y: 0, in: 'legend-trigger' })
  expect(await legend()).toBeFalsy()
  await ui.unmount()
})

test('mobile ? button toggles the legend', async ($, on) => {
  setup(on)
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...band, surface: 'mobile' } as never)
  const legend = () => ui.find({ type: 'Text', text: /context used/ })
  expect(await legend()).toBeFalsy()
  await ui.press({ key: 'legend' })
  expect(await legend()).toBeTruthy()
  await ui.press({ key: 'legend' })
  expect(await legend()).toBeFalsy()
  await ui.unmount()
})
