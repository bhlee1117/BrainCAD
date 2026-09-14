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

export type OverlayKind = 'projection-points' | 'neuron-arbor'

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

/** Where the tracer went in, and what it hit. */
export interface InjectionSite {
  /** Centre in stereotaxic millimetres, via the active coordinate profile. */
  readonly centre: { ap: number; ml: number; dv: number } | null
  /** Reported injection volume, mm³. */
  readonly volumeMm3: number | null
  /** Every structure the injection touched, primary first. */
  readonly structures: readonly string[]
  /** Cloud of injection-site voxels, drawn distinctly from projections. */
  readonly cloud: ProjectionPointCloud | null
  readonly worldPositions: Float32Array | null
}

export interface ProjectionOverlay {
  readonly id: string
  // A literal, not `OverlayKind`: this is the discriminant that lets every
  // consumer narrow the union, and a widened type here silently disables that.
  readonly kind: 'projection-points'
  name: string
  visible: boolean
  color: string
  /** Point size in world millimetres. */
  pointSizeMm: number
  opacity: number
  /** The threshold used to build the current cloud. */
  threshold: number
  readonly experimentId: number
  /** Where the virus was injected — never the same question as where it went. */
  readonly injection: InjectionSite
  /** Whether injection-site voxels are excluded from the projection cloud. */
  excludeInjection: boolean
  /** Whether the injection site is drawn. */
  showInjection: boolean
  /** Drawn reflected onto the other hemisphere. See {@link MIRROR_CAVEAT}. */
  mirrored: boolean
  readonly provenance: OverlayProvenance
  /** Derived render data; not serialised. */
  readonly cloud: ProjectionPointCloud
  /** World-space positions, ready for a BufferGeometry. */
  readonly worldPositions: Float32Array
  readonly colors: Float32Array
}

/**
 * A single reconstructed neuron, drawn as line segments.
 *
 * Deliberately a sibling of `ProjectionOverlay` rather than a variant of it.
 * The two answer the same question at different resolutions — where do axons
 * from here go — but one is a population average over a bulk injection and the
 * other is one cell, and a shape that let them be handled interchangeably would
 * invite exactly the conflation the provenance fields exist to prevent.
 */
export interface NeuronOverlay {
  readonly id: string
  readonly kind: 'neuron-arbor'
  name: string
  visible: boolean
  color: string
  opacity: number
  /** MouseLight's published identifier, e.g. "AL0017". */
  readonly idString: string
  readonly somaAcronym: string | null
  /** Whether the dendritic arbor is drawn alongside the axon. */
  showDendrite: boolean
  showAxon: boolean
  /** Drawn reflected onto the other hemisphere. See {@link MIRROR_CAVEAT}. */
  mirrored: boolean
  readonly totalNodes: number
  readonly provenance: OverlayProvenance
  /** World-space segment endpoints, ready for a LineSegments geometry. */
  readonly axonWorld: Float32Array | null
  readonly dendriteWorld: Float32Array | null
  /** Soma position in world millimetres. */
  readonly somaWorld: readonly [number, number, number] | null
}

/** Anything the overlay list can hold. */
export type Overlay = ProjectionOverlay | NeuronOverlay

/** Fields every overlay carries and the UI may patch. */
export type OverlayPatch = Partial<{
  name: string
  visible: boolean
  color: string
  opacity: number
  pointSizeMm: number
  threshold: number
  excludeInjection: boolean
  showInjection: boolean
  showDendrite: boolean
  showAxon: boolean
  mirrored: boolean
}>

/**
 * What a mirrored overlay is, and is not.
 *
 * Allen injects one hemisphere and a MouseLight cell lives in one, so the data
 * frequently sits on the opposite side from the preparation being planned.
 * Reflecting it is the obvious thing to want and is genuinely useful — but the
 * reflected copy is not a measurement of that hemisphere. It is the same
 * measurement assuming the brain is symmetric, which it is at the resolution of
 * an averaged atlas and is not in detail: lateralised projections exist, and
 * CCFv3 itself is a symmetrised template, so the atlas cannot contradict the
 * assumption even where the animal would.
 */
export const MIRROR_CAVEAT =
  'Mirrored: this is the same measurement reflected across the midline, not ' +
  'data from this hemisphere. It assumes bilateral symmetry, which holds ' +
  'approximately and not for lateralised projections.'

/**
 * Axon and dendrite read as different things at a glance.
 *
 * Warm for the axon because it is the part that travels and the part a
 * trajectory can run into; cool and dimmer for the dendrite, which stays local.
 */
export const NEURON_AXON_COLOR = '#ffb347'
export const NEURON_DENDRITE_COLOR = '#5ec8f0'

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
  'Projection density includes the injection site, where it saturates; the site is ' +
    'excluded from the projection cloud and drawn separately.',
  'Projection density is signal detected by the Allen pipeline, not a synapse count.',
  'Absence of points means below the displayed threshold, not absence of projection.',
  'Registered to CCFv3, so it inherits the same averaged-brain caveats as the atlas.',
]

/** Geometry and material handles, tracked so they can be disposed. */
export interface OverlayRenderHandles {
  geometry: BufferGeometry | null
  points: Points | null
}
