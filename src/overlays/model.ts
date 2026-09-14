/**
 * The overlay model.
 *
 * Blueprint §13 is emphatic that an overlay must carry its own provenance, and
 * this is where that is enforced. Every overlay records what it is, where it
 * came from, what coordinate space it was registered in, at what resolution,
 * and — the field that matters most — whether it is a *measurement*, an
 * *import*, or a *qualitative* sketch.
 *
 * The reason is specific to this data. A connectivity projection volume is a
 * real measurement, but a measurement of one injection into one animal. Shown
 * over a target on a planning screen it looks exactly like a prediction for the
 * animal on the rig. It is not, and the interface has to keep saying so.
 */

import type { BufferGeometry, Points } from 'three'

import type { ProjectionPointCloud } from './pointCloud.ts'

export type OverlayKind = 'projection-points'

/** How much the overlay should be trusted, and as what. */
export type OverlayEvidence =
  /** Measured from a real experiment. */
  | 'measured'
  /** Supplied by the user from their own data. */
  | 'imported'
  /** Drawn or inferred; illustrative only. */
  | 'qualitative'

export interface OverlayProvenance {
  readonly evidence: OverlayEvidence
  /** Human-readable citation, shown in the UI and the planning sheet. */
  readonly citation: string
  /** Link back to the source record. */
  readonly url: string | null
  /** Coordinate space the data was registered in. */
  readonly registeredTo: string
  /** Native resolution of the source data, in micrometres. */
  readonly resolutionUm: number
  /** Things the reader must know before acting on it. */
  readonly caveats: readonly string[]
}

export interface ProjectionOverlay {
  readonly id: string
  readonly kind: OverlayKind
  name: string
  visible: boolean
  color: string
  /** Point size in world millimetres. */
  pointSizeMm: number
  opacity: number
  /** The threshold used to build the current cloud. */
  threshold: number
  readonly experimentId: number
  readonly provenance: OverlayProvenance
  /** Derived render data; not serialised. */
  readonly cloud: ProjectionPointCloud
  /** World-space positions, ready for a BufferGeometry. */
  readonly worldPositions: Float32Array
  readonly colors: Float32Array
}

/** Default colour ramp endpoints, chosen to read over grey anatomy. */
export const OVERLAY_COLORS = [
  '#ff6b4a',
  '#4da3ff',
  '#c792ea',
  '#7ee0b8',
  '#ffd166',
] as const

export function overlayColorFor(index: number): string {
  return OVERLAY_COLORS[index % OVERLAY_COLORS.length]!
}

/**
 * Caveats attached to every connectivity overlay.
 *
 * Written out rather than summarised because each one corrects a different
 * plausible misreading, and a reader who skips the list is exactly the reader
 * who needed it.
 */
export const CONNECTIVITY_CAVEATS: readonly string[] = [
  'Measured from a single injection in a single animal — not a prediction for your animal.',
  'Projection density is signal detected by the Allen pipeline, not a synapse count.',
  'Absence of points means below the displayed threshold, not absence of projection.',
  'Registered to CCFv3, so it inherits the same averaged-brain caveats as the atlas.',
]

/** Geometry and material handles, tracked so they can be disposed. */
export interface OverlayRenderHandles {
  geometry: BufferGeometry | null
  points: Points | null
}
