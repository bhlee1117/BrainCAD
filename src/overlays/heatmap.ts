/**
 * Whole-brain heat map of retrograde strength.
 *
 * The matrix in the BACKTRACE panel answers "which structures project here"
 * as a ranked list, which is the right shape for reading one value precisely
 * and the wrong shape for the question this module exists for: *where are the
 * hubs?* A list cannot show that three of the top five sources are neighbours
 * in one lobe, or that the strong inputs arrive from two widely separated
 * places. Anatomy answers that, so the strength is painted onto anatomy.
 *
 * ## It is painted per structure, and the resolution is the ontology's
 *
 * Allen reports a projection density at the target for each *experiment*, and
 * an experiment is labelled by the structure it was injected into. So the
 * finest grain available is a whole structure: every voxel of CA3 takes CA3's
 * value. The heat map is therefore a picture of the ontology coloured by
 * strength, not a voxel-wise measurement — it will show hard edges exactly on
 * structure boundaries, because that is where its information actually changes.
 *
 * ## Matching runs up the tree, not by equality
 *
 * The annotation volume labels voxels with leaf structures — "Field CA3,
 * pyramidal layer" — while an injection is reported against a coarser one,
 * "Field CA3". Matching on equality would leave most of the brain unpainted
 * while the list above it confidently named CA3. So each voxel walks its own
 * root-to-leaf path from the leaf upward and takes the first ancestor that has
 * a value, which is also the rule that makes a coarse source like "Isocortex"
 * paint everything beneath it.
 */

import type { AnnotationVolume } from '../atlas/annotation.ts'
import { UNLABELLED } from '../atlas/annotation.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import type { StructureIndex } from '../atlas/ontology.ts'
import type { RetrogradeMatrixRow } from './retrograde.ts'

/** Strength of each source structure, keyed by Allen structure id. */
export type StrengthByStructure = ReadonlyMap<number, number>

/**
 * What the heat map is measuring.
 *
 * Offered as a choice because "hub" is not one question. The strongest single
 * experiment and the most consistently sampled region are different claims,
 * and a tool that silently picked one would be answering a question the user
 * did not ask.
 */
export type HeatmapMetric =
  /** Mean across this structure's experiments. */
  | 'mean'
  /** Strongest single experiment from this structure. */
  | 'max'

export const HEATMAP_METRIC_LABEL: Record<HeatmapMetric, string> = {
  mean: 'Mean — average across experiments',
  max: 'Max — strongest single experiment',
}

/**
 * Mean by default.
 *
 * Max is one experiment's number, so it rewards a lucky injection: a structure
 * sampled once, right in its centre, outranks one sampled nine times slightly
 * off. Mean asks the steadier question — *when Allen injects here, does the
 * target light up?* — which is closer to what "hub" is meant to mean. Max is
 * still a click away, because a single strong experiment is real evidence and
 * averaging it against eight poorly placed ones hides it.
 */
export const DEFAULT_HEATMAP_METRIC: HeatmapMetric = 'mean'

/** Pull one metric out of the matrix, as a structure-id lookup. */
export function strengthByStructure(
  matrix: readonly RetrogradeMatrixRow[],
  metric: HeatmapMetric,
): Map<number, number> {
  const out = new Map<number, number>()

  for (const row of matrix) {
    if (row.structureId <= 0) continue
    const value = metric === 'max' ? row.peakDensity : row.meanDensity

    // A structure can appear once per abbreviation, but two rows could in
    // principle carry the same id; keep the larger rather than the later.
    out.set(row.structureId, Math.max(out.get(row.structureId) ?? 0, value))
  }

  return out
}

export interface RetrogradeHeatmap {
  /** Voxel centres in CCF micrometres, ready for `positionsToWorld`. */
  readonly positionsUm: Float32Array
  /** Strength at each point, on the metric's own scale. */
  readonly strengths: Float32Array
  readonly pointCount: number
  /** Largest strength present, for normalising the colour ramp. */
  readonly maxStrength: number
  /** Structure ids that actually matched a voxel. */
  readonly paintedStructureIds: readonly number[]
  /** Source structures with a value that matched no voxel in the volume. */
  readonly unpaintedStructureIds: readonly number[]
  /** Voxel stride used, in voxels. */
  readonly stride: number
}

export interface HeatmapOptions {
  /**
   * Sample every nth voxel along each axis.
   *
   * At 50 um a stride of 2 is a 100 um lattice, which matches the resolution
   * the connectivity data is published at — sampling finer than the data would
   * cost eight times the points to draw the same information.
   */
  stride?: number
  /** Hard cap on points, raising the stride until the cloud fits under it. */
  maxPoints?: number
}

export const DEFAULT_HEATMAP_OPTIONS: Required<HeatmapOptions> = {
  stride: 2,
  // A quarter of a million points is one draw call and renders comfortably;
  // beyond it the gain is invisible because the points overlap anyway.
  maxPoints: 250_000,
}

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
 * Walk the annotation volume and emit every voxel belonging to a source.
 *
 * Runs on the already-loaded annotation volume with no network access, so it
 * costs a few hundred milliseconds of arithmetic and nothing else.
 */
export function buildRetrogradeHeatmap(
  volume: AnnotationVolume,
  index: StructureIndex,
  strengths: StrengthByStructure,
  options: HeatmapOptions = {},
): RetrogradeHeatmap {
  const { stride: requestedStride, maxPoints } = {
    ...DEFAULT_HEATMAP_OPTIONS,
    ...options,
  }

  const space = volume.space
  const [n0, n1, n2] = space.shape
  const half = space.resolutionUm / 2

  // Structure ids resolve to the same answer for every voxel carrying them, so
  // the ancestor walk is done once per distinct label rather than 9.6 million
  // times. On a real volume this is a few hundred lookups instead of millions.
  const resolved = new Map<number, number | null>()
  const painted = new Set<number>()

  const positions: number[] = []
  const values: number[] = []
  let maxStrength = 0
  let stride = Math.max(1, Math.round(requestedStride))

  // Raising the stride is how the cap is honoured: dropping points at random
  // would thin a dense hub and a faint one by the same fraction, which looks
  // like a measurement and is not.
  for (;;) {
    positions.length = 0
    values.length = 0
    painted.clear()
    maxStrength = 0

    for (let i0 = 0; i0 < n0; i0 += stride) {
      for (let i1 = 0; i1 < n1; i1 += stride) {
        for (let i2 = 0; i2 < n2; i2 += stride) {
          const label = volume.labelAtVoxel(i0, i1, i2)
          if (label === UNLABELLED) continue

          let strength = resolved.get(label)
          if (strength === undefined) {
            strength = strengthForStructure(index, strengths, label)
            resolved.set(label, strength)
          }
          if (strength === null || strength <= 0) continue

          painted.add(label)
          // Voxel centre, not its corner: a corner is half a voxel off the
          // tissue it stands for, the same reason the projection clouds do it.
          positions.push(
            i0 * space.resolutionUm + half,
            i1 * space.resolutionUm + half,
            i2 * space.resolutionUm + half,
          )
          values.push(strength)
          if (strength > maxStrength) maxStrength = strength
        }
      }
    }

    if (values.length <= maxPoints || stride >= 8) break
    stride += 1
  }

  // Which sources were named but never drawn — a structure the volume does not
  // carry at this resolution, or an id the ontology does not know.
  const paintedStructureIds = new Set<number>()
  for (const label of painted) {
    const structure = index.byId.get(label)
    const chain = structure ? structure.path : [label]
    for (let i = chain.length - 1; i >= 0; i--) {
      if (strengths.has(chain[i]!)) {
        paintedStructureIds.add(chain[i]!)
        break
      }
    }
  }

  const unpainted: number[] = []
  for (const id of strengths.keys()) {
    if (!paintedStructureIds.has(id)) unpainted.push(id)
  }

  return {
    positionsUm: Float32Array.from(positions),
    strengths: Float32Array.from(values),
    pointCount: values.length,
    maxStrength,
    paintedStructureIds: [...paintedStructureIds],
    unpaintedStructureIds: unpainted,
    stride,
  }
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
 * Per-point colours for a heat map.
 *
 * Normalised against the strongest value present rather than against 1.0: a
 * target whose best input is 0.08 would otherwise render entirely at the dark
 * end, hiding the very contrast the map exists to show. The scale is therefore
 * relative, and the panel states the value the top of the ramp stands for.
 *
 * The square root is the same correction the projection clouds use. Densities
 * are heavily skewed — one saturated source and a long tail of faint ones — so
 * a linear ramp paints almost the whole brain at the bottom stop.
 */
export function heatmapColors(heatmap: RetrogradeHeatmap): Float32Array {
  const colors = new Float32Array(heatmap.pointCount * 3)
  const peak = heatmap.maxStrength > 0 ? heatmap.maxStrength : 1

  for (let i = 0; i < heatmap.pointCount; i++) {
    const [r, g, b] = heatColor(Math.sqrt(heatmap.strengths[i]! / peak))
    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b
  }

  return colors
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
  regions: 'Regions — paint where the sources are',
  routes: 'Routes — draw the traced paths in',
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

/**
 * Rank the painted structures, strongest first — the hub list.
 *
 * Reads the same strength map the colours come from, so the list beside the
 * map and the map itself can never disagree about which region is hottest.
 */
export function rankHubs(
  index: StructureIndex,
  strengths: StrengthByStructure,
  heatmap: RetrogradeHeatmap,
): { id: number; acronym: string; name: string; strength: number }[] {
  return heatmap.paintedStructureIds
    .map((id) => {
      const structure = index.byId.get(id)
      return {
        id,
        acronym: structure?.acronym ?? String(id),
        name: structure?.name ?? 'Unknown structure',
        strength: strengths.get(id) ?? 0,
      }
    })
    .sort((a, b) => b.strength - a.strength)
}
