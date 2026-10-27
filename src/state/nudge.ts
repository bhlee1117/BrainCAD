/**
 * Nudging the target from the keyboard.
 *
 * At the rig the question is rarely "what is at AP -2.00" but "what happens if
 * I go half a millimetre deeper, or a touch more lateral" -- and answering it
 * by clicking into a numeric field, selecting the value and retyping it breaks
 * the loop between moving and looking.
 *
 *       Q   W   E          W forward (anterior)   S back (posterior)
 *        A  S  D           A left                 D right
 *                          E up (dorsal)          Q down (ventral)
 *
 * WASD because the hand already knows it: W is away from you and A is to the
 * left of D, which is what the brain does on screen. Q and E are the pair
 * either side of W, and take the axis WASD cannot reach -- the same convention
 * a 3D editor's fly mode uses.
 *
 * Left and right are the animal's, so they are a plain sign on ML. An earlier
 * version made this pair medial/lateral, measured from the midline; that is a
 * more anatomical reading but it is not what A and D mean to a hand, and a key
 * that reverses its direction halfway across the brain is worse than one that
 * does not.
 *
 * The pure function lives here, apart from the listener, so the mapping can be
 * tested without a DOM -- and because these are letter keys now, the rule that
 * they are ignored while the caret is in a field stopped being a nicety.
 */

import type { Stereotaxic } from '../atlas/coords.ts'

/** A direction the target can be nudged in. */
export type NudgeDirection =
  | 'left'
  | 'right'
  | 'anterior'
  | 'posterior'
  | 'dorsal'
  | 'ventral'

/**
 * Physical keys, by `KeyboardEvent.code`.
 *
 * `code` rather than `key`, so the mapping follows the key's position rather
 * than the letter printed on it: on an AZERTY or Dvorak keyboard `KeyW` is
 * still the key above `KeyS`, which is the whole point of choosing WASD.
 */
export const NUDGE_KEYS: Readonly<Record<string, NudgeDirection>> = {
  KeyW: 'anterior',
  KeyS: 'posterior',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'dorsal',
  KeyQ: 'ventral',
}

/** The legend, in the order the keys sit under the hand. */
export const NUDGE_LEGEND: readonly {
  key: string
  direction: NudgeDirection
  label: string
}[] = [
  { key: 'W', direction: 'anterior', label: 'Anterior' },
  { key: 'S', direction: 'posterior', label: 'Posterior' },
  { key: 'A', direction: 'left', label: 'Left' },
  { key: 'D', direction: 'right', label: 'Right' },
  { key: 'E', direction: 'dorsal', label: 'Dorsal' },
  { key: 'Q', direction: 'ventral', label: 'Ventral' },
]

/** Default nudge, in millimetres. Shift multiplies it; see {@link COARSE_FACTOR}. */
export const DEFAULT_STEP_MM = 0.1

/** How much bigger a Shift-held nudge is. */
export const COARSE_FACTOR = 10

/**
 * Apply one nudge.
 *
 * Left and right are the animal's own, so they are a sign on ML: +ML is the
 * animal's right everywhere in BrainCAD, and these keys do not change meaning
 * when the target crosses the midline.
 */
export function nudgeCoord(
  coord: Stereotaxic,
  direction: NudgeDirection,
  stepMm: number,
): Stereotaxic {
  switch (direction) {
    case 'anterior':
      return { ...coord, ap: coord.ap + stepMm }
    case 'posterior':
      return { ...coord, ap: coord.ap - stepMm }
    case 'dorsal':
      return { ...coord, dv: coord.dv + stepMm }
    case 'ventral':
      return { ...coord, dv: coord.dv - stepMm }
    case 'right':
      return { ...coord, ml: coord.ml + stepMm }
    case 'left':
      return { ...coord, ml: coord.ml - stepMm }
  }
}

/** How a nudge reads in the status line. */
export function describeNudge(direction: NudgeDirection, stepMm: number): string {
  return `${direction} ${stepMm.toFixed(2)} mm`
}
