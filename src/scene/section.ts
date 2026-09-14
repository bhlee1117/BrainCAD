/**
 * Section planes: cutting the scene open along ML, DV or AP.
 *
 * A 3D view of a plan is mostly occlusion. The brain surface hides the target,
 * the objective hides the headbar, and turning down opacity trades one
 * unreadable image for another. Cutting the scene with a plane and discarding
 * one side is how a drawing shows what is inside a solid, and it is what makes
 * a capture of an implant *in* tissue legible at all.
 *
 * Two things about this are worth being explicit about, because both could
 * otherwise be misread as results rather than as drawing:
 *
 *  - **It is display only.** Clipping happens in the fragment shader. Nothing
 *    is removed from any geometry, so collision, clearance and measurement are
 *    computed against the whole solid exactly as before. A cut that appears to
 *    separate two parts has not separated them.
 *  - **Cut solids read as hollow.** three.js clipping does not cap the opening,
 *    so a sectioned barrel shows its inside wall rather than a filled
 *    cross-section. That is a rendering artefact, not a wall thickness.
 */

import { Plane, Vector3 } from 'three'

/** The three stereotaxic axes a section can run along. */
export type SectionAxis = 'ml' | 'dv' | 'ap'

export const SECTION_AXES: readonly SectionAxis[] = ['ml', 'dv', 'ap']

/** World direction of each axis. See `world.ts`: +X right, +Y dorsal, +Z anterior. */
const AXIS_NORMAL: Record<SectionAxis, Vector3> = {
  ml: new Vector3(1, 0, 0),
  dv: new Vector3(0, 1, 0),
  ap: new Vector3(0, 0, 1),
}

/** How each axis reads to a user, and which way its two sides point. */
export const AXIS_LABEL: Record<SectionAxis, { axis: string; positive: string; negative: string }> =
  {
    ml: { axis: 'ML', positive: 'right', negative: 'left' },
    dv: { axis: 'DV', positive: 'dorsal', negative: 'ventral' },
    ap: { axis: 'AP', positive: 'anterior', negative: 'posterior' },
  }

/** Which half-space the section discards. */
export type SectionSide = 'positive' | 'negative'

/**
 * Half-range of the position sliders, in millimetres.
 *
 * The mouse brain spans roughly ±6 mm ML and 13 mm AP, so ±16 mm reaches well
 * past the anatomy in every direction and into the space hardware occupies —
 * a section through an objective barrel is a legitimate thing to want. The
 * numeric field beside the slider is not clamped, for the cases it is not.
 */
export const SECTION_RANGE_MM = 16

export interface SectionPlaneState {
  enabled: boolean
  /** Position of the plane along its axis, in stereotaxic millimetres. */
  positionMm: number
  /** The side that is hidden. */
  remove: SectionSide
}

export type SectionState = Record<SectionAxis, SectionPlaneState>

export const DEFAULT_SECTION: SectionState = {
  // Midsagittal, hiding the animal's right, is the one cut that is useful
  // before any adjustment — it opens the brain along the plane atlas figures
  // are drawn in. It ships disabled; only the position is pre-chosen.
  ml: { enabled: false, positionMm: 0, remove: 'positive' },
  dv: { enabled: false, positionMm: 0, remove: 'positive' },
  ap: { enabled: false, positionMm: 0, remove: 'positive' },
}

/**
 * The clipping planes for a section state.
 *
 * A three.js `Plane` keeps the half-space where `normal · p + constant > 0`,
 * so removing the positive side means pointing the normal the other way. Both
 * cases are written out rather than folded into a sign, because getting this
 * backwards silently hides the half the user wanted to see, and a reader
 * should be able to check it without deriving it.
 */
export function sectionPlanes(state: SectionState): Plane[] {
  const planes: Plane[] = []

  for (const axis of SECTION_AXES) {
    const plane = state[axis]
    if (!plane.enabled) continue

    const normal = AXIS_NORMAL[axis]
    if (plane.remove === 'positive') {
      // Keep p·n < position.
      planes.push(new Plane(normal.clone().negate(), plane.positionMm))
    } else {
      // Keep p·n > position.
      planes.push(new Plane(normal.clone(), -plane.positionMm))
    }
  }

  return planes
}

/** Whether any section is currently cutting. */
export function isSectioning(state: SectionState): boolean {
  return SECTION_AXES.some((axis) => state[axis].enabled)
}

/** One-line summary of the active cuts, for the planning sheet and captures. */
export function describeSection(state: SectionState): string | null {
  const active = SECTION_AXES.filter((axis) => state[axis].enabled)
  if (active.length === 0) return null

  return active
    .map((axis) => {
      const plane = state[axis]
      const label = AXIS_LABEL[axis]
      const side = plane.remove === 'positive' ? label.positive : label.negative
      return `${label.axis} ${plane.positionMm.toFixed(2)} mm, ${side} removed`
    })
    .join('; ')
}
