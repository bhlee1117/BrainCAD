/**
 * Painting a per-structure strength onto anatomy.
 *
 * A ranked list answers "which structures are strong" precisely and cannot
 * answer *where are the hubs?* — it cannot show that three of the top five are
 * neighbours in one lobe, or that the strong ones sit in two widely separated
 * places. Anatomy answers that, so the strength is painted onto anatomy.
 *
 * The strengths themselves come from elsewhere: the convergence matrix for the
 * hub map, and in principle any structure-keyed measure. This module only
 * knows how to turn one into a cloud of coloured voxels.
 *
 * ## The grain is the ontology's, not the volume's
 *
 * Whatever the measure, it is reported per structure, so every voxel of CA3
 * takes CA3's value. The map is a picture of the ontology coloured by
 * strength, not a voxel-wise measurement — it shows hard edges exactly on
 * structure boundaries, because that is where its information changes.
 *
 * ## Matching runs up the tree, not by equality
 *
 * The annotation volume labels voxels with leaf structures — "Field CA3,
 * pyramidal layer" — while the measures are reported against coarser ones,
 * "Field CA3". Matching on equality left most of the brain unpainted while the
 * list beside it confidently named CA3. So each voxel walks its own
 * root-to-leaf path from the leaf upward and takes the first ancestor that has
 * a value, which is also the rule that makes a coarse source like "Isocortex"
 * paint everything beneath it.
 */

import type { AnnotationVolume } from '../atlas/annotation.ts'
import { UNLABELLED } from '../atlas/annotation.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import {
  voxelSide,
  type Side,
  type SidedStrengths,
} from './convergence.ts'
import type { StructureIndex } from '../atlas/ontology.ts'

/** Strength of each source structure, keyed by Allen structure id. */
export type StrengthByStructure = ReadonlyMap<number, number>

export interface RetrogradeHeatmap {
  /** Voxel centres in CCF micrometres, ready for `positionsToWorld`. */
  readonly positionsUm: Float32Array
  /** Strength at each point, on the metric's own scale. */
  readonly strengths: Float32Array
  readonly pointCount: number
  /** Largest strength present, for normalising the colour ramp. */
  readonly maxStrength: number
  /** Smallest strength present; the ramp is stretched between the two. */
  readonly minStrength: number
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
  sided: SidedStrengths,
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
  // Cached per side, because the answer now depends on which half the voxel is
  // in as well as on its label.
  const resolved: Record<Side, Map<number, number | null>> = {
    ipsi: new Map(),
    contra: new Map(),
  }
  const painted = new Set<number>()

  const positions: number[] = []
  const values: number[] = []
  let maxStrength = 0
  let minStrength = Infinity
  let stride = Math.max(1, Math.round(requestedStride))

  // Raising the stride is how the cap is honoured: dropping points at random
  // would thin a dense hub and a faint one by the same fraction, which looks
  // like a measurement and is not.
  for (;;) {
    positions.length = 0
    values.length = 0
    painted.clear()
    maxStrength = 0
    minStrength = Infinity

    for (let i0 = 0; i0 < n0; i0 += stride) {
      for (let i1 = 0; i1 < n1; i1 += stride) {
        for (let i2 = 0; i2 < n2; i2 += stride) {
          const label = volume.labelAtVoxel(i0, i1, i2)
          if (label === UNLABELLED) continue

          // No orientation argument: there is one convention now, and an
          // option here defaulting the other way is exactly how this cloud
          // came to paint its ipsilateral half on the right while the sections
          // beside it painted theirs on the left.
          const side = voxelSide(space, { i0, i1, i2 })
          const cache = resolved[side]
          let strength = cache.get(label)
          if (strength === undefined) {
            strength = strengthForStructure(index, sided[side], label)
            cache.set(label, strength)
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
          if (strength < minStrength) minStrength = strength
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
      if (sided.ipsi.has(chain[i]!) || sided.contra.has(chain[i]!)) {
        paintedStructureIds.add(chain[i]!)
        break
      }
    }
  }

  const unpainted: number[] = []
  for (const id of sided.ipsi.keys()) {
    if (!paintedStructureIds.has(id)) unpainted.push(id)
  }

  return {
    positionsUm: Float32Array.from(positions),
    strengths: Float32Array.from(values),
    pointCount: values.length,
    maxStrength,
    minStrength: Number.isFinite(minStrength) ? minStrength : 0,
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
 * Stretched between the lowest and highest value actually present, not from
 * zero. The first version normalised against the peak alone and lifted the low
 * end with a square root — the right correction for projection densities,
 * which are heavily skewed — and it was wrong for the measure this view ended
 * up carrying. Source counts run 1 to 115 and most regions sit between 60 and
 * 110, so nearly the whole brain landed at the top of the ramp and the hubs
 * had nothing to stand out from.
 *
 * Stretching costs something real and the caption pays it back: the scale is
 * relative, so two different measures produce two maps that look equally
 * bright. Both ends of the range are stated beside the map for that reason.
 */
export function heatmapColors(heatmap: RetrogradeHeatmap): Float32Array {
  const colors = new Float32Array(heatmap.pointCount * 3)
  const span = heatmap.maxStrength - heatmap.minStrength
  // One distinct value everywhere means there is nothing to rank, so it all
  // takes the top of the ramp rather than dividing by zero.
  const scale = span > 0 ? 1 / span : 0

  for (let i = 0; i < heatmap.pointCount; i++) {
    const t = span > 0 ? (heatmap.strengths[i]! - heatmap.minStrength) * scale : 1
    const [r, g, b] = heatColor(t)
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
  regions: 'Regions — paint the sources by their strength at the target',
  routes: 'Routes — draw the traced paths in',
}

/**
 * Source strength at the target, per structure, all on the injected side.
 *
 * What the second brain paints. Unlike the convergence matrix beside it this
 * *does* move with the target — that is the point of it: the question is "how
 * hard does each region drive this coordinate", and the answer is a different
 * picture half a millimetre away.
 *
 * One value per structure, its strongest experiment, for the same reason the
 * hub map keeps one: a region Allen injected nine times would otherwise read
 * as nine times the source.
 *
 * ## Every experiment is read as a right-hemisphere injection
 *
 * A left-hemisphere injection is mirrored rather than painted where it was,
 * so the whole answer lands in the injected half and nothing is drawn on the
 * other. Painting each source where its own needle went looked more faithful
 * and made the view unreadable: the same anatomical source moved from one half
 * to the other depending on which animals happened to reach the target, so two
 * mirror-image targets drew mirror-image pictures of agreeing data. At CA1
 * ML ±1.5 the two share 18 of 22 source structures in the same rank order, and
 * the strongest experiment for VISp is left-injected for one and right-injected
 * for the other — enough to put the same region on opposite sides of the screen.
 *
 * Mirroring costs nothing real. Which hemisphere Allen injected is a fact about
 * the method, not about the mouse, and 75% of the corpus is on the right
 * already. What it is *not* is a claim about laterality: whether a source is
 * ipsilateral or contralateral to the target is read from the unmirrored
 * coordinates by `sourceSide`, and the side filter applies before this.
 */
export function backtraceStrengths(
  sources: readonly {
    structureId: number
    densityAtTarget: number
    injectionCentre: { ml: number } | null
  }[],
): SidedStrengths {
  const injected = new Map<number, number>()

  for (const source of sources) {
    // Still required, even though the side no longer decides anything: a row
    // with no reported centre is one whose injection was never located.
    if (!source.injectionCentre) continue
    const current = injected.get(source.structureId) ?? 0
    if (source.densityAtTarget > current) {
      injected.set(source.structureId, source.densityAtTarget)
    }
  }

  // `ipsi` *is* the injected half — that is what the name means here and what
  // `voxelSide` resolves it to, whichever way round the screen draws it — so
  // putting everything there is the mirroring, and the other half stays empty.
  return { ipsi: injected, contra: new Map() }
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
