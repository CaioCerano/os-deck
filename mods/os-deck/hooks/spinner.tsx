// A working indicator like the transcript's own: a braille dot grid turning, and a glint that runs
// along the label. Drawn on the surface's frame clock, so only this region redraws.
import type { ClientModule } from 'claude-code'

type Props = { label: string; color: string; dim: string }
type Ref = { tick: number }
type State = { ref: Ref }

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const STEP_MS = 90
/** How many characters the glint covers. */
const GLINT = 3

const Spinner: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { tick: 0 }
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(STEP_MS, () => {
      ref.tick += 1
      surface.setState({ ref })
    })
  }
  const frame = FRAMES[ref.tick % FRAMES.length] ?? FRAMES[0]
  const chars = [...props.label]
  // The glint crosses the label, then rests a few beats past its end before it starts again.
  const at = ref.tick % (chars.length + GLINT + 6)
  const before = chars.slice(0, Math.max(0, at - GLINT + 1)).join('')
  const glint = chars.slice(Math.max(0, at - GLINT + 1), at + 1).join('')
  const after = chars.slice(at + 1).join('')
  return (
    <Text wrap="truncate">
      <Text color={props.color}>{`${frame} `}</Text>
      <Text color={props.color}>{before}</Text>
      <Text color={props.color} bold>
        {glint}
      </Text>
      <Text color={props.color}>{after}</Text>
    </Text>
  )
}

export default Spinner
