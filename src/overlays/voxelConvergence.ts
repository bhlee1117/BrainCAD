/**
 * The convergence map at voxel grain, under the parcellation.
 *
 * `convergence.ts` answers "which regions are convergence points" at the grain
 * Allen's unionize tables are published at: one number per structure. That
 * grain is also its ceiling — a dense input zone in one corner of a region, a
 * cluster straddling an annotation boundary, a gradient across a nucleus, all
 * averaged away before BrainCAD ever saw the number.
 *
 * This is the same question asked of the raw 100 µm projection volumes, so it
 * owes nothing to the parcellation and can disagree with it. Built by
 * `scripts/fetch-voxel-convergence.mjs` over all 2,826 experiments of the
 * corpus in `scripts/corpus.mjs` — the same set the structure matrix uses —
 * and bundled as a 4.6 MB blob (2 MB over the wire).
 *
 * Three things about it are not true of the structure map and change how it
 * should be read:
 *
 *  - **The left half is the injected hemisphere.** Every experiment is
 *    mirrored so its injection lies on one side, which leaves the blob with an
 *    injected half and an other half and no left or right of its own. Raw, the
 *    brightness on whichever side the needle went in is a fact about the
 *    method; mirrored, the two halves are the ipsilateral and contralateral
 *    parts of one answer, and `INJECTED_SIDE_IS_RIGHT` puts the injected one on
 *    the right so the sections, the traced routes and the grey injection dots
 *    all agree.
 *  - **White matter lights up, correctly.** A tract carries the axons of many
 *    sources, so it genuinely has high convergence by this measure — it is
 *    just convergence of *passage* rather than of termination. The structure
 *    map hid this inside one "fiber tracts" block.
 *  - **The distribution is nothing like the structure map's.** Counts run to
 *    1,988 with a median of 57, so a scale set by the maximum puts almost
 *    every voxel at the bottom of the ramp. The range is taken from a
 *    percentile instead.
 */

import { connectivityUrl, type ConvergenceMetric } from './convergence.ts'

export interface VoxelConvergenceHeader {
  readonly generatedAt: string
  readonly experiments: number
  /** Allen product ids the corpus was drawn from. */
  readonly products: readonly number[]
  /** What that set is and what it leaves out. */
  readonly corpus: string
  readonly sizes: readonly [number, number, number]
  readonly resolutionUm: number
  readonly densityThreshold: number
  readonly injectionFloor: number
  readonly maxCount: number
  readonly mirroredExperiments: number
  readonly hemisphere: string
  readonly data: string
  readonly voxels: number
  readonly source: string
}

export interface VoxelConvergence {
  readonly header: VoxelConvergenceHeader
  /** Experiments reaching each voxel. */
  readonly count: Uint16Array
  /** Mean projection density among those, scaled to the uint16 range. */
  readonly meanScaled: Uint16Array
}

/** Undo the uint16 packing the build step applies to the mean. */
export const MEAN_SCALE = 65535

/**
 * Where the colour ramp tops out, as a percentile of non-empty voxels.
 *
 * The 99th, not the maximum: the brightest voxels are four times the 99th
 * percentile — 1,988 against 495 — and sit in a handful of dense tracts, so
 * scaling to them renders the rest of the brain as one dark mass. Clipping
 * loses the ranking *within*
 * that top percent and keeps it everywhere else, which is the better trade for
 * a map read by eye.
 */
export const RANGE_PERCENTILE = 0.99

let pending: Promise<VoxelConvergence> | null = null

export function loadVoxelConvergence(): Promise<VoxelConvergence> {
  if (!pending) {
    pending = (async () => {
      const header = (await fetchJson()) as VoxelConvergenceHeader

      // Stamped, because the blob's *meaning* has changed between builds while
      // its name did not. Normalising the mirroring onto the other hemisphere
      // leaves a byte-for-byte different file at the same path, and a browser
      // holding the old one renders it under the new labels: the map comes out
      // bright on the half the sections call contralateral, which looks exactly
      // like the left and right having been swapped in code.
      const response = await fetch(
        `${connectivityUrl(header.data)}?v=${encodeURIComponent(header.generatedAt)}`,
      )
      if (!response.ok) {
        throw new Error(`Voxel convergence data missing (HTTP ${response.status}).`)
      }
      const blob = await response.arrayBuffer()

      const expected = header.voxels * 2 * 2
      if (blob.byteLength !== expected) {
        // A truncated blob would decode into a plausible-looking map of the
        // wrong thing, so it is rejected rather than read optimistically.
        throw new Error(
          `Voxel convergence blob is ${blob.byteLength} bytes, expected ${expected}.`,
        )
      }

      return {
        header,
        count: new Uint16Array(blob, 0, header.voxels),
        meanScaled: new Uint16Array(blob, header.voxels * 2, header.voxels),
      }
    })()
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}

async function fetchJson(): Promise<unknown> {
  // Revalidated rather than taken from cache: it is 458 bytes, and it is what
  // carries the stamp that busts the blob beside it. A cached header would
  // keep handing out the old blob's URL and defeat the stamp entirely.
  const response = await fetch(connectivityUrl('voxel-convergence.json'), {
    cache: 'no-cache',
  })
  if (!response.ok) {
    throw new Error(
      `Voxel convergence map not available (HTTP ${response.status}). ` +
        `Build it with \`npm run voxel:fetch\`.`,
    )
  }
  return response.json()
}

/** Forget the cached map. For tests. */
export function clearVoxelConvergenceCache(): void {
  pending = null
}

/** The plane of values a metric selects. */
export function valuesFor(
  voxels: VoxelConvergence,
  metric: ConvergenceMetric,
): Uint16Array {
  return metric === 'count' ? voxels.count : voxels.meanScaled
}

/** Convert a stored value back to the units the caption shows. */
export function decode(metric: ConvergenceMetric, raw: number): number {
  return metric === 'count' ? raw : raw / MEAN_SCALE
}

export interface VoxelRange {
  /** Lowest non-empty value. */
  readonly min: number
  /** Value the ramp tops out at, in stored units. */
  readonly max: number
}

/**
 * The range the ramp spans, from the data rather than from its extremes.
 *
 * Computed on a stride rather than on all 1.2 million voxels: the percentile
 * of a tenth of a heavily-skewed distribution is the same percentile to well
 * within a colour step, and this runs whenever the metric changes.
 */
export function voxelRange(values: Uint16Array, percentile = RANGE_PERCENTILE): VoxelRange {
  const sample: number[] = []
  for (let i = 0; i < values.length; i += 11) {
    const v = values[i]!
    if (v > 0) sample.push(v)
  }
  if (sample.length === 0) return { min: 0, max: 1 }

  sample.sort((a, b) => a - b)
  const max = sample[Math.min(sample.length - 1, Math.floor(sample.length * percentile))]!
  return { min: sample[0]!, max: Math.max(max, sample[0]! + 1) }
}

/**
 * Index into the 100 µm grid for an annotation voxel.
 *
 * The projection grids are exactly half the annotation's linear resolution
 * over the same extent — 132×80×114 against 264×160×228 — so the mapping is a
 * halving with no interpolation and no registration step. That correspondence
 * is the reason this feature is cheap at all, and it is asserted in the tests
 * rather than assumed.
 */
export function voxelIndexFor(
  voxels: VoxelConvergence,
  annotationVoxel: { i0: number; i1: number; i2: number },
): number {
  const [n0, n1, n2] = voxels.header.sizes
  const i0 = annotationVoxel.i0 >> 1
  const i1 = annotationVoxel.i1 >> 1
  const i2 = annotationVoxel.i2 >> 1
  if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= n0 || i1 >= n1 || i2 >= n2) return -1
  return i0 + n0 * (i1 + n1 * i2)
}

/** Caveats carried wherever the voxel map is shown. */
export const VOXEL_CAVEATS: readonly string[] = [
  'The right half is the injected hemisphere.',
  'White matter is genuinely bright: a tract carries axons from many sources. That is ' +
    'convergence of passage, not of termination.',
  'The scale tops out at the 99th percentile; a few tract voxels run four times higher.',
  'A hot spot one or two voxels across is at the scale of the registration error ' +
    'between animals, not safely below it.',
  'Injection sites are masked out, so this is not a picture of where tracer was put.',
]
