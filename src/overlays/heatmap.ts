/**
 * What the second brain draws, and the ramp both maps share.
 *
 * Three things live here, and the split matters:
 *
 *  - `strengthForStructure` resolves a structure-keyed measure for a voxel by
 *    walking up the ontology. The annotation labels voxels with leaves —
 *    "Field CA3, pyramidal layer" — while the measures are reported against
 *    coarser ones, "Field CA3", so matching on equality left most of the brain
 *    unpainted while the list beside it confidently named CA3. The section
 *    hub map is painted through this.
 *  - `buildInjectionBlobs` is the second brain's own answer, and deliberately
 *    *not* structure-keyed. See its own note.
 *  - `heatColor` is the shared ramp, monotonic in luminance so the ordering
 *    survives greyscale and a colour-blind reader.
 *
 * An earlier version also painted a per-structure cloud onto the 3D brain,
 * which is what `strengthForStructure` was written for. It went when the
 * second brain stopped answering the connectome-wide question — the sections
 * do that, and better — and started answering this target's. A cloud that
 * floods whole parcels is the right picture for a measure published per
 * parcel; it is the wrong one for a set of injections that have coordinates.
 */

import type { Stereotaxic } from '../atlas/coords.ts'
import type { StructureIndex } from '../atlas/ontology.ts'
import type { RetrogradeSource } from './retrograde.ts'

/** Strength of each source structure, keyed by Allen structure id. */
export type StrengthByStructure = ReadonlyMap<number, number>

/**
 * The first ancestor of a structure that carries a strength, or null.
 *
 * `path` is the root-to-node id chain, so it is walked backwards: the most
 * specific match wins, which matters when both a region and its parent appear
 * as sources.
 */
export function strengthForStructure(
  index: StructureIndex,
  strengths: StrengthByStructure,
  structureId: number,
): number | null {
  const direct = strengths.get(structureId)
  if (direct !== undefined) return direct

  const structure = index.byId.get(structureId)
  if (!structure) return null

  for (let i = structure.path.length - 1; i >= 0; i--) {
    const value = strengths.get(structure.path[i]!)
    if (value !== undefined) return value
  }
  return null
}


/**
 * Stops of the heat ramp, dark to bright.
 *
 * Luminance rises monotonically from end to end, so the ordering survives
 * being printed in greyscale and stays readable to a colour-blind reader —
 * neither is true of the rainbow ramp this kind of figure usually gets. Over
 * the viewport's near-black ground the dark end also recedes on its own,
 * which is what lets a weak region be present without competing with a hub.
 */
const RAMP: readonly (readonly [number, number, number])[] = [
  [0.09, 0.05, 0.22], // deep indigo
  [0.47, 0.11, 0.42], // magenta
  [0.79, 0.27, 0.27], // red
  [0.96, 0.57, 0.12], // orange
  [0.99, 0.87, 0.35], // yellow
  [1.0, 1.0, 0.92], // near white
]

/** Sample the ramp at `t` in 0..1. */
export function heatColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t))
  const scaled = clamped * (RAMP.length - 1)
  const low = Math.min(RAMP.length - 1, Math.floor(scaled))
  const high = Math.min(RAMP.length - 1, low + 1)
  const f = scaled - low

  const a = RAMP[low]!
  const b = RAMP[high]!
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/**
 * What the second brain draws.
 *
 * Two readings of the same answer, and they are not interchangeable:
 * `regions` paints *where the inputs live*, `routes` draws *how they arrive*.
 * A hub can be obvious in one and invisible in the other — a compact nucleus
 * with one strong projection is a bright blob and a single thin line, while a
 * corridor every afferent funnels through is nothing at all in `regions` and
 * the brightest thing on screen in `routes`.
 */
export type HeatmapMode = 'regions' | 'routes'

export const HEATMAP_MODE_LABEL: Record<HeatmapMode, string> = {
  regions: 'Injections — one blob per experiment, sized by its reported volume',
  routes: 'Routes — draw the traced paths in',
}

/**
 * One injection, as a sphere at the place the tracer actually went.
 *
 * What the second brain draws instead of flooding a parcel. The region-painted
 * version took each experiment's primary injection structure and gave every
 * voxel of it the same value, so a CA3 injection coloured the whole of CA3 —
 * the millimetre beside the pipette and the far end of the field alike — and
 * every edge on screen fell on an annotation boundary. The picture looked like
 * a map of the parcellation because that is what it was.
 *
 * This is the finer, and more honest, claim the data already supports:
 * `injection-coordinates` is where the needle went and `injection-volume` is
 * how much tracer came out, both reported per experiment.
 *
 * It is still a model. Allen gives a volume, not an extent, so the radius is
 * sphere-equivalent, and a real injection runs long along the pipette track
 * rather than round. Overlapping spheres are the real signal in a cluster: six
 * CA3 injections into the same field show as six overlapping blobs, which is
 * what six experiments look like.
 */
export interface InjectionBlob {
  readonly experimentId: number
  readonly structureAbbrev: string
  readonly centre: Stereotaxic
  /** Sphere-equivalent radius in millimetres, floored so a tiny one still shows. */
  readonly radiusMm: number
  /** That experiment's projection density at the target. */
  readonly strength: number
  /**
   * `strength` on the ramp's 0..1, against the strongest blob present.
   *
   * From zero rather than stretched between the weakest and the strongest,
   * which is the opposite of what the structure maps do and is right for the
   * opposite reason. A count of 60 out of 110 is not "55% of a hub" — counts
   * have no meaningful zero, so they are stretched. A projection density does:
   * zero is no projection, so the weakest source here lands near the bottom of
   * the ramp and looks as weak as it is.
   */
  readonly normalised: number
}

export interface InjectionBlobs {
  readonly blobs: readonly InjectionBlob[]
  readonly minStrength: number
  readonly maxStrength: number
  readonly structureCount: number
}

/**
 * Smallest radius a blob is drawn at, in millimetres.
 *
 * Allen reports volumes down to 0.0024 mm³, a 0.08 mm sphere — a couple of
 * pixels at any useful zoom, and invisible next to a 0.5 mm one. The floor
 * makes a weak experiment findable without making it look large; it is the
 * colour, not the size, that carries the strength.
 */
export const MIN_BLOB_RADIUS_MM = 0.12

export function buildInjectionBlobs(
  sources: readonly RetrogradeSource[],
): InjectionBlobs {
  const unscaled: Omit<InjectionBlob, 'normalised'>[] = []
  const structures = new Set<string>()
  let minStrength = Number.POSITIVE_INFINITY
  let maxStrength = 0

  for (const source of sources) {
    // No reported centre means there is nowhere to put it, and the centre of
    // the named structure would be a guess dressed as a measurement.
    if (!source.injectionCentre) continue

    const strength = source.densityAtTarget
    if (!Number.isFinite(strength) || strength <= 0) continue

    unscaled.push({
      experimentId: source.experimentId,
      structureAbbrev: source.structureAbbrev,
      centre: source.injectionCentre,
      radiusMm: Math.max(source.injectionRadiusMm ?? 0, MIN_BLOB_RADIUS_MM),
      strength,
    })
    structures.add(source.structureAbbrev)
    if (strength < minStrength) minStrength = strength
    if (strength > maxStrength) maxStrength = strength
  }

  // Second pass, because the peak is only known once every source is in.
  const peak = maxStrength > 0 ? maxStrength : 1
  const blobs = unscaled.map((blob) => ({ ...blob, normalised: blob.strength / peak }))

  return {
    blobs,
    minStrength: blobs.length > 0 ? minStrength : 0,
    maxStrength,
    structureCount: structures.size,
  }
}

export interface RouteHeat {
  /** Segment endpoint pairs in stereotaxic millimetres, as a flat triple list. */
  readonly points: Float32Array
  readonly colors: Float32Array
  readonly segmentCount: number
  readonly maxStrength: number
}

/**
 * Back-traced routes, coloured on the heat ramp by how strong their source is.
 *
 * Coloured by the experiment's density *at the target*, deliberately, and not
 * by the per-point density Allen attaches to the path. That field is almost
 * entirely zero — on a real response a ten-point route carries one non-zero
 * value, next to the injection — so shading by it produces a picture of where
 * Allen's sampler happened to find signal rather than of anything anatomical.
 * The route's meaning is "this is how that source reaches here", and the
 * source's strength is the number that belongs on it.
 */
export function buildRouteHeat(
  sources: readonly { densityAtTarget: number; path: readonly { coord: Stereotaxic }[] }[],
): RouteHeat {
  let segmentCount = 0
  let maxStrength = 0
  for (const source of sources) {
    if (source.path.length > 1) segmentCount += source.path.length - 1
    if (source.densityAtTarget > maxStrength) maxStrength = source.densityAtTarget
  }

  const points = new Float32Array(segmentCount * 6)
  const colors = new Float32Array(segmentCount * 6)
  const peak = maxStrength > 0 ? maxStrength : 1

  let at = 0
  for (const source of sources) {
    if (source.path.length < 2) continue
    const [r, g, b] = heatColor(Math.sqrt(source.densityAtTarget / peak))

    for (let i = 0; i < source.path.length - 1; i++) {
      const a = source.path[i]!.coord
      const c = source.path[i + 1]!.coord
      points[at] = a.ml
      points[at + 1] = a.dv
      points[at + 2] = a.ap
      points[at + 3] = c.ml
      points[at + 4] = c.dv
      points[at + 5] = c.ap

      for (let k = 0; k < 6; k += 3) {
        colors[at + k] = r
        colors[at + k + 1] = g
        colors[at + k + 2] = b
      }
      at += 6
    }
  }

  return { points, colors, segmentCount, maxStrength }
}
