// A connector drawn on the surface's own frame clock, as a segmented bar like the footer's gauges:
// while `active` a lit block sweeps along it; at rest it is a faint row of empty segments.
// Only this region redraws; the pane does not.
import type { ClientModule } from 'claude-code'

type Props = {
  active: boolean
  width: number
  color: string
  dim: string
  /** Cells where a branch drops to a card below (or rises from one, with `isMerge`): lit at rest. */
  marks: number[]
  /** Kept for callers: a merge reads the same as a fan-out on a segmented bar. */
  isMerge: boolean
}

type Ref = { phase: number; active: boolean }
type State = { ref: Ref }

const STEP_MS = 70
/** The lit block: a bright core of filled segments between dimmer edges. */
const BLOCK = 7

const Rail: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { phase: 0, active: props.active }
  ref.active = props.active
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(STEP_MS, () => {
      if (ref.active) {
        ref.phase += 1
        surface.setState({ ref })
      }
    })
  }

  const width = Math.max(1, surface.columns || props.width)
  // 0: empty and faint, 1: filled and dim (an edge), 2: filled and bright (the core).
  const level = Array.from({ length: width }, () => 0)
  if (props.active) {
    // The block runs off the right edge and comes back in from the left, with a short gap.
    const span = width + BLOCK + 4
    const head = ref.phase % span
    for (let k = 0; k < BLOCK; k++) {
      const i = head - k
      if (i >= 0 && i < width) level[i] = k === 0 || k === BLOCK - 1 ? 1 : 2
    }
  } else {
    for (const m of props.marks) if (m >= 0 && m < width) level[m] = 1
  }
  // Runs, not cells: consecutive cells of one level share a Text, a handful of nodes per frame.
  const runs: { text: string; level: number }[] = []
  level.forEach(l => {
    const glyph = l === 0 ? '▱' : '▰'
    const last = runs[runs.length - 1]
    if (last && last.level === l) last.text += glyph
    else runs.push({ text: glyph, level: l })
  })
  return (
    <Box>
      {runs.map(r => (
        <Text color={r.level === 0 ? props.dim : props.color} dimColor={r.level === 1} bold={r.level === 2}>
          {r.text}
        </Text>
      ))}
    </Box>
  )
}

export default Rail
