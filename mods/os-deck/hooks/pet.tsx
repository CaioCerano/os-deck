// The pet, animated on the surface's frame clock so only its region redraws. The hooks module
// hands it what the session is doing and when; between redraws it moves its own clock on, so a
// finished turn settles to idle and a quiet one dozes off without the pane being drawn again.
import type { ClientModule } from 'claude-code'

import { PET_HOLD_MS, PET_ROWS, friendsAt, isSweating, petCells, petFrame, petFrameIndex, petStateOf } from './pet-art'
import type { PetColors, PetInput, PetState } from './pet-art'

type Props = { part: 'pet' | 'caption'; input: PetInput; colors: PetColors; captionColor: string }
type Ref = { part: Props['part']; input: PetInput; lastNow: number; ticks: number; key: string }
type Shown = { state: PetState | null; since: number; caption: string }
type State = { ref: Ref }

const STEP_MS = 80

// The state each part shows, kept by the module rather than the instance: a redraw of the pane can
// mount the region afresh, and the pet must not lose its place in the animation when it does.
const SHOWN: Record<Props['part'], Shown> = {
  pet: { state: null, since: 0, caption: '' },
  caption: { state: null, since: 0, caption: '' },
}

/** The clock the pet runs on: the hooks module's last reading, plus the ticks since. */
const at = (ref: Ref) => ref.input.now + ref.ticks * STEP_MS

// The states quick tool calls flip between: one of these waits its turn, any other cuts in.
const WORK = new Set<PetState>(['thinking', 'reading', 'editing', 'running', 'agents'])

/**
 * Moves the shown state on to what the session is doing now. Between two kinds of work the one
 * shown keeps its minimum time; an ask, a failure, a finish or rest cut in at once. A new state
 * starts from its first frame.
 */
const settle = (ref: Ref) => {
  const now = at(ref)
  const shown = SHOWN[ref.part]
  const next = petStateOf({ ...ref.input, now })
  // A clock well behind the one the state began on is a new session's or a test's: start over. A
  // few ms behind is only this estimate trailing the last, and must not restart the animation.
  if (now < shown.since - 2000) shown.state = null
  if (shown.state === next.state) shown.caption = next.caption
  else if (shown.state === null || !WORK.has(shown.state) || !WORK.has(next.state) || now - shown.since >= PET_HOLD_MS) {
    shown.state = next.state
    shown.since = now
    shown.caption = next.caption
  }
  const state = shown.state ?? next.state
  // The friends shown change the drawing too: one finishing, or its moment after ending running out.
  const friends = friendsAt({ ...ref.input, now })
    .map(f => `${f.color}${f.status[0]}`)
    .join('')
  return ref.part === 'caption' ? `${state}:${shown.caption}` : `${state}:${petFrameIndex(state, now - shown.since)}:${friends}`
}

const Pet: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { part: props.part, input: props.input, lastNow: -1, ticks: 0, key: '' }
  // The tick reads the props through ref: the ones of this draw, not those it was started with.
  ref.part = props.part
  ref.input = props.input
  if (props.input.now !== ref.lastNow) {
    // A fresh reading from the hooks module: the local clock starts again from it.
    ref.lastNow = props.input.now
    ref.ticks = 0
  }
  ref.key = settle(ref)
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(STEP_MS, () => {
      ref.ticks += 1
      // Redraw only when the picture (or the caption) changes, not every tick.
      const key = settle(ref)
      if (key !== ref.key) {
        ref.key = key
        surface.setState({ ref })
      }
    })
  }
  const shown = SHOWN[props.part]
  const state = shown.state ?? 'idle'
  if (props.part === 'caption')
    return (
      <Text color={props.captionColor} wrap="truncate">
        {shown.caption}
      </Text>
    )
  const now = at(ref)
  const rows = petCells(petFrame(state, now - shown.since, friendsAt({ ...props.input, now }), isSweating(props.input)), props.colors)
  return (
    <Box flexDirection="column" height={PET_ROWS}>
      {rows.map(runs => (
        <Text>
          {runs.map(r => (
            <Text color={r.fg ?? undefined} backgroundColor={r.bg ?? undefined} bold={r.bold}>
              {r.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export default Pet
