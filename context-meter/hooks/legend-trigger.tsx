import type { ClientModule } from 'claude-code'

// The ⓘ at the end of the band's first line. It only reports the pointer entering or leaving; register.tsx waits before it opens the legend.
const LegendTrigger: ClientModule = (_props, surface) => {
  const { Text } = surface.elements
  surface.onPointer(ev => {
    if (ev.type === 'enter') surface.post('enter')
    else if (ev.type === 'leave') surface.post('leave')
  })
  return <Text color="subtle">ⓘ</Text>
}

export default LegendTrigger
