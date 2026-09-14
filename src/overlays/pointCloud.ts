/**
 * Turning a projection-density volume into a point cloud.
 *
 * A 100 µm connectivity grid is 132 x 80 x 114 = 1.2 M voxels, but the great
 * majority are empty or near-empty: a tracing experiment labels a few percent
 * of the brain. Thresholding and emitting one point per surviving voxel gives a
 * cloud of thousands rather than millions, which draws in a single draw call
 * and reads well over a translucent brain.
 *
 * Two properties matter for honesty rather than looks:
 *
 *  - The threshold is explicit and reported. A point cloud with no stated
 *    threshold invites the reader to treat sparse edges as absence of
 *    projection, when they may simply be below a cut the author chose.
 *  - Points are emitted at voxel *centres* in the volume's own space, then
 *    mapped through the same atlas-to-world transform as everything else, so
 *    an overlay cannot drift relative to the anatomy it sits on.
 */

import { Color, Vector3 } from 'three'

import type { VolumeSpace } from '../atlas/space.ts'
import { flatIndex } from '../atlas/space.ts'

export interface PointCloudOptions {
  /** Voxels with density at or below this are dropped. */
  threshold: number
  /**
   * Hard cap on emitted points.
   *
   * When a threshold survives more voxels than this, the densest are kept —
   * never a random or spatial subsample, which would thin real structure
   * unevenly and could erase a thin tract entirely.
   */
  maxPoints: number
}

export const DEFAULT_POINT_CLOUD_OPTIONS: PointCloudOptions = {
  threshold: 0.05,
  maxPoints: 150_000,
}

export interface ProjectionPointCloud {
  /** xyz triples in CCF micrometres, at voxel centres. */
  readonly positionsUm: Float32Array
  /** Per-point density, parallel to `positionsUm`. */
  readonly densities: Float32Array
  readonly pointCount: number
  /** Highest density anywhere in the source volume. */
  readonly maxDensity: number
  /** Threshold actually applied. */
  readonly threshold: number
  /** How many voxels passed the threshold before any cap was applied. */
  readonly voxelsAboveThreshold: number
  /** True when `maxPoints` forced the densest voxels to be kept. */
  readonly capped: boolean
}

/**
 * Build a point cloud from a density volume.
 *
 * @param data Density per voxel, in the volume's own storage order.
 * @param space The volume's geometry — resolution and axis mapping.
 */
export function buildProjectionPointCloud(
  data: Float32Array | Uint16Array | Uint8Array,
  space: VolumeSpace,
  options: PointCloudOptions = DEFAULT_POINT_CLOUD_OPTIONS,
): ProjectionPointCloud {
  const threshold = Math.max(0, options.threshold)
  const maxPoints = Math.max(1, Math.floor(options.maxPoints))

  const [n0, n1, n2] = space.shape
  const resolution = space.resolutionUm

  // First pass: count survivors and find the peak, so the second pass can
  // allocate exactly and the UI can report a meaningful maximum.
  let above = 0
  let maxDensity = 0
  for (let i = 0; i < data.length; i++) {
    const value = data[i]!
    if (value > maxDensity) maxDensity = value
    if (value > threshold) above++
  }

  if (above === 0) {
    return {
      positionsUm: new Float32Array(0),
      densities: new Float32Array(0),
      pointCount: 0,
      maxDensity,
      threshold,
      voxelsAboveThreshold: 0,
      capped: false,
    }
  }

  // When capping, raise the effective threshold until the survivor count fits.
  // Keeping the densest voxels preserves the core of every projection; a random
  // subsample would thin a faint tract into nothing while barely touching a
  // dense one.
  let effectiveThreshold = threshold
  let capped = false
  if (above > maxPoints) {
    capped = true
    effectiveThreshold = findThresholdFor(data, maxPoints, threshold, maxDensity)
  }

  const positions: number[] = []
  const densities: number[] = []

  for (let i2 = 0; i2 < n2; i2++) {
    for (let i1 = 0; i1 < n1; i1++) {
      for (let i0 = 0; i0 < n0; i0++) {
        const index = flatIndex(space, i0, i1, i2)
        if (index < 0) continue
        const value = data[index]!
        if (value <= effectiveThreshold) continue

        // Voxel centre, not corner: a point at the corner sits half a voxel off
        // the tissue it represents, which at 100 µm is 50 µm of drift.
        positions.push(
          (i0 + 0.5) * resolution,
          (i1 + 0.5) * resolution,
          (i2 + 0.5) * resolution,
        )
        densities.push(value)

        if (densities.length >= maxPoints) break
      }
      if (densities.length >= maxPoints) break
    }
    if (densities.length >= maxPoints) break
  }

  return {
    positionsUm: new Float32Array(positions),
    densities: new Float32Array(densities),
    pointCount: densities.length,
    maxDensity,
    threshold,
    voxelsAboveThreshold: above,
    capped,
  }
}

/**
 * Binary-search a density cut that leaves at most `budget` voxels.
 *
 * Sorting 1.2 M floats to take a quantile would be far more expensive than
 * twenty counting passes over the array, and the result only needs to be close
 * enough to land inside the budget.
 */
function findThresholdFor(
  data: Float32Array | Uint16Array | Uint8Array,
  budget: number,
  low: number,
  high: number,
): number {
  let lo = low
  let hi = high

  for (let iteration = 0; iteration < 20; iteration++) {
    const mid = (lo + hi) / 2
    let count = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i]! > mid) {
        count++
        if (count > budget) break
      }
    }
    if (count > budget) lo = mid
    else hi = mid
  }

  return hi
}

/**
 * Per-point colours on a density ramp.
 *
 * A single hue varying in lightness and saturation, not a rainbow: the reader
 * should be able to rank two points by eye, and a rainbow ramp makes that
 * impossible while implying categories that do not exist.
 */
export function densityColors(
  cloud: ProjectionPointCloud,
  baseColor: string,
): Float32Array {
  const colors = new Float32Array(cloud.pointCount * 3)
  const base = new Color(baseColor)
  const faint = base.clone().multiplyScalar(0.35)

  // Normalise against the peak actually present so a weak experiment still
  // shows structure rather than rendering uniformly dim.
  const peak = cloud.maxDensity > 0 ? cloud.maxDensity : 1

  const mixed = new Color()
  for (let i = 0; i < cloud.pointCount; i++) {
    // Square root lifts the low end: projection densities are heavily skewed,
    // and a linear ramp renders almost everything at the faint extreme.
    const t = Math.min(1, Math.sqrt(cloud.densities[i]! / peak))
    mixed.copy(faint).lerp(base, t)
    colors[i * 3] = mixed.r
    colors[i * 3 + 1] = mixed.g
    colors[i * 3 + 2] = mixed.b
  }

  return colors
}

/**
 * Convert CCF-micrometre point positions into world millimetres.
 *
 * Applies the same atlas-to-world matrix the anatomy uses, so the overlay is
 * registered to the brain by construction rather than by a parallel
 * calculation that could drift.
 */
export function positionsToWorld(
  positionsUm: Float32Array,
  atlasToWorld: { elements: ArrayLike<number> },
): Float32Array {
  const out = new Float32Array(positionsUm.length)
  const point = new Vector3()
  const e = atlasToWorld.elements

  for (let i = 0; i < positionsUm.length; i += 3) {
    // CCF millimetres; the mesh loader applies the same /1000.
    point.set(
      positionsUm[i]! / 1000,
      positionsUm[i + 1]! / 1000,
      positionsUm[i + 2]! / 1000,
    )

    out[i] = e[0]! * point.x + e[4]! * point.y + e[8]! * point.z + e[12]!
    out[i + 1] = e[1]! * point.x + e[5]! * point.y + e[9]! * point.z + e[13]!
    out[i + 2] = e[2]! * point.x + e[6]! * point.y + e[10]! * point.z + e[14]!
  }

  return out
}
