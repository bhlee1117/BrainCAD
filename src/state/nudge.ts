/**
 * Nudging the target from the number pad.
 *
 * At the rig the question is rarely "what is at AP −2.00" but "what happens if
 * I go half a millimetre deeper, or a touch more lateral" — and answering it by
 * clicking into a numeric field, selecting the value and retyping it breaks the
 * loop between moving and looking. Six keys laid out the way the directions
 * actually sit on the pad make the target something you can walk around:
 *
 *       7   8↑D  9↗P          D dorsal      P posterior
 *       4←M  5   6→L          M medial      L lateral
 *       1↙A  2↓V  3           A anterior    V ventral
 *
 * Dorsal/ventral run up and down the pad and anterior/posterior along its
 * diagonal, so the hand learns the mapping from the key positions rather than
 * from a legend.
 *
 * The pure function lives here, apart from the listener, because the one thing
 * that can be subtly wrong — what "medial" means on the left of the brain — is
 * worth testing without a DOM.
 */

import type { Stereotaxic } from '../atlas/coords.ts'

/** A direction the target can be nudged in. */
export type NudgeDirection =
  | 'medial'
  | 'lateral'
  | 'anterior'
  | 'posterior'
  | 'dorsal'
  | 'ventral'

/**
 * Physical keys, by `KeyboardEvent.code`.
 *
 * `code` rather than `key`, because the number pad reports `ArrowLeft` and
 * friends through `key` when Num Lock is off — so a mapping built on `key`
 * works on one machine and silently does nothing on the next. The top-row
 * digits are accepted too, for keyboards that have no pad at all.
 */
export const NUDGE_KEYS: Readonly<Record<string, NudgeDirection>> = {
  Numpad4: 'medial',
  Numpad6: 'lateral',
  Numpad1: 'anterior',
  Numpad9: 'posterior',
  Numpad8: 'dorsal',
  Numpad2: 'ventral',
  Digit4: 'medial',
  Digit6: 'lateral',
  Digit1: 'anterior',
  Digit9: 'posterior',
  Digit8: 'dorsal',
  Digit2: 'ventral',
}

/** The pad legend, for the panel. */
export const NUDGE_LEGEND: readonly { key: string; direction: NudgeDirection; label: string }[] =
  [
    { key: '8', direction: 'dorsal', label: 'Dorsal' },
    { key: '2', direction: 'ventral', label: 'Ventral' },
    { key: '4', direction: 'medial', label: 'Medial' },
    { key: '6', direction: 'lateral', label: 'Lateral' },
    { key: '1', direction: 'anterior', label: 'Anterior' },
    { key: '9', direction: 'posterior', label: 'Posterior' },
  ]

/** Default nudge, in millimetres. Shift multiplies it; see {@link COARSE_FACTOR}. */
export const DEFAULT_STEP_MM = 0.1

/** How much bigger a Shift-held nudge is. */
export const COARSE_FACTOR = 10

/**
 * Apply one nudge.
 *
 * Medial and lateral are relative to the midline, not to the sign of ML: on the
 * animal's left, at ML −1.5, "lateral" is *more* negative. Treating the keys as
 * plain ±ML would make them reverse meaning between hemispheres, which is the
 * sort of thing that is noticed only after a plan has been built on it.
 *
 * Exactly on the midline there is no lateral direction to prefer, so the key
 * moves to the animal's right — matching BrainCAD's +ML convention — rather
 * than doing nothing, which would read as a dead key.
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
    case 'lateral':
      return { ...coord, ml: coord.ml + (coord.ml < 0 ? -stepMm : stepMm) }
    case 'medial': {
      const toward = coord.ml > 0 ? -stepMm : stepMm
      const next = coord.ml + toward
      // Stop at the midline rather than crossing it. Overshooting would hand
      // back a point in the other hemisphere, so holding "medial" would walk
      // the target out through the far side of the brain.
      return { ...coord, ml: Math.sign(coord.ml) !== Math.sign(next) ? 0 : next }
    }
  }
}

/** How a nudge reads in the status line. */
export function describeNudge(direction: NudgeDirection, stepMm: number): string {
  return `${direction} ${stepMm.toFixed(2)} mm`
}
