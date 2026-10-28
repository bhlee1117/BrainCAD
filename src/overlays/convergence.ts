/**
 * The whole-brain convergence map: which regions are hubs, target or no target.
 *
 * The back-trace answers "what projects to *this point*", and the answer moves
 * when the target moves — that is what it is for. This asks a question that
 * does not move: *across the whole connectome, which regions is everything
 * aimed at?* A hub is a property of the brain, not of anybody's plan, so the
 * target is drawn on this map as a reference mark and changes nothing about
 * the colours.
 *
 * The matrix is built at build time by `scripts/fetch-connectivity-matrix.mjs`
 * — 586 queries against the Allen API, bundled as one small asset — because
 * doing it at runtime would mean the user waiting through all of them. Its
 * corpus is the explicit product list in `scripts/corpus.mjs`, 2,810
 * experiments, shared with the voxel map so the two grains of the map describe
 * the same animals.
 *
 * ## It counts sources, not experiments
 *
 * The stored matrix keeps one density per *source structure*: that source's
 * strongest experiment into the target. Counting experiments instead would
 * rank the Allen Institute's sampling effort — a region injected nine times
 * would beat one injected twice regardless of the anatomy — which is the same
 * trap the retrograde matrix avoids by ranking on peak rather than count.
 *
 * ## What it cannot tell you
 *
 * Still anterograde data, so "projects into" means bulk signal detected in the
 * target and counts fibres of passage the same as terminals. Still limited to
 * the 293 summary structures and to regions Allen injected: 213 of the 293
 * appear as a source at all, and a region absent from the matrix may simply
 * never have been one.
 */

import {
  arrayAxisFor,
  indexIncreasesPositively,
  type VolumeSpace,
} from '../atlas/space.ts'

/** Resolve a path inside the bundled connectivity assets. */
export function connectivityUrl(path: string): string {
  return `${import.meta.env.BASE_URL}connectivity/${path}`.replace(/([^:])\/{2,}/g, '$1/')
}

/**
 * `[sourceStructureId, ipsilateralDensity, contralateralDensity]`.
 *
 * Both sides, from the same experiment. An earlier build stored one pooled
 * number per source, which painted every structure identically on both halves
 * and made the map symmetric by construction rather than by anatomy — a single
 * CA3 experiment puts 0.089 into one CA1 and 0.216 into the other.
 */
export type SourceEntry = readonly [number, number, number]

export interface ConvergenceEntry {
  readonly acronym: string
  /** Every structure projecting in, strongest first. */
  readonly sources: readonly SourceEntry[]
}

export interface ConvergenceMatrix {
  readonly generatedAt: string
  readonly source: string
  readonly structureSet: string
  /** Densities below this were dropped before the file was written. */
  readonly fetchFloor: number
  /** Allen product ids the corpus was drawn from — the same set the voxel map uses. */
  readonly products: readonly number[]
  readonly experiments: number
  readonly corpus: string
  readonly note: string
  readonly convergence: Readonly<Record<string, ConvergenceEntry>>
}

/**
 * What the hub map measures.
 *
 * Two readings of the same row, and a region can be a hub under one and
 * unremarkable under the other: `count` finds the region *many* places aim at,
 * `mean` finds the one the places that do aim at it aim at *hard*. A thalamic
 * relay and a small nucleus with one massive input are both hubs, in different
 * senses, and no single number says both.
 */
export type ConvergenceMetric = 'count' | 'mean'

/**
 * Which half of the brain a value describes.
 *
 * Every experiment is read relative to its own injection, so the stored map
 * has no left and right of its own — only an injected side and the other one.
 * `ipsiOnLeft` below decides which way round it is drawn.
 */
export type Side = 'ipsi' | 'contra'

/**
 * The screen's one laterality convention: **the right hemisphere is the
 * injection side**.
 *
 * Every experiment in the hub map was mirrored onto one hemisphere when the
 * asset was built, so the map has an injected half and an other half and no
 * left or right of its own; pinning that half to one side is a choice, and the
 * choice is the right, for two reasons that agree. Allen injects the right
 * hemisphere in 75% of the corpus, so it is where the needles mostly were
 * without any mirroring at all. And the corpus-wide injection sites drawn on
 * the second brain are mirrored onto the right, so every grey dot on screen is
 * there — a convention that disagreed with the one unmirrored layer in the
 * view would be the same mistake twice.
 *
 * An earlier build let the sections swap their halves and name them `ipsi` and
 * `contra`, which put a second, moving frame on screen beside the fixed one
 * the routes are drawn in. Ipsilateral and contralateral are a property of the
 * 3D view alone, read off where the target sits relative to this one
 * convention: a target in the right hemisphere is on the same side as the
 * injections and sees its ipsilateral input, a target on the left sees its
 * contralateral input.
 */
export const INJECTED_SIDE_IS_RIGHT = true

/** Whether the injected — ipsilateral — half is drawn on the animal's left. */
export const IPSI_ON_LEFT = !INJECTED_SIDE_IS_RIGHT

/**
 * The side a voxel falls on.
 *
 * The midline is the ML axis's own midpoint rather than a constant, because
 * the two bundled coordinate profiles do not put it in quite the same place.
 */
export function voxelSide(
  space: VolumeSpace,
  voxel: { i0: number; i1: number; i2: number },
  ipsiOnLeft = IPSI_ON_LEFT,
): Side {
  const mlAxis = arrayAxisFor(space, 'ML')
  const index = [voxel.i0, voxel.i1, voxel.i2][mlAxis]!
  const midpoint = space.shape[mlAxis]! / 2
  const left = indexIncreasesPositively(space.axes[mlAxis]!)
    ? index < midpoint
    : index >= midpoint
  return left === ipsiOnLeft ? 'ipsi' : 'contra'
}

/**
 * The same voxel in the other hemisphere.
 *
 * How the voxel grain follows the target: the stored blob holds one
 * orientation, and a target in the left hemisphere reads it through this
 * reflection rather than through a second copy of the data.
 *
 * Reflecting the annotation voxel and then halving gives the same grid voxel
 * as halving and then reflecting — `(N-1-i) >> 1` equals `N/2-1-(i >> 1)` for
 * every i — so this composes with `voxelIndexFor` without a special case.
 */
export function reflectVoxel(
  space: VolumeSpace,
  voxel: { i0: number; i1: number; i2: number },
): { i0: number; i1: number; i2: number } {
  const mlAxis = arrayAxisFor(space, 'ML')
  const indices = [voxel.i0, voxel.i1, voxel.i2]
  indices[mlAxis] = space.shape[mlAxis]! - 1 - indices[mlAxis]!
  return { i0: indices[0]!, i1: indices[1]!, i2: indices[2]! }
}

export const CONVERGENCE_METRIC_LABEL: Record<ConvergenceMetric, string> = {
  count: 'Count — how many regions project in',
  mean: 'Mean — average strength of those projections',
}

/**
 * Minimum density for a source to count as projecting in.
 *
 * Above the file's own fetch floor, deliberately. The floor exists to keep the
 * asset small; this is the claim about what counts as a connection, and it is
 * applied here so it can be seen and changed without re-fetching 293 queries.
 */
export const DEFAULT_CONNECTION_THRESHOLD = 0.01

let pending: Promise<ConvergenceMatrix> | null = null

/** Fetch and cache the bundled matrix. */
export function loadConvergenceMatrix(): Promise<ConvergenceMatrix> {
  if (!pending) {
    pending = (async () => {
      // Revalidated for the same reason the voxel header is: the file is
      // rebuilt whenever the corpus or the hemisphere split changes, and a
      // browser holding the previous one shows a different answer under
      // identical labels.
      const response = await fetch(connectivityUrl('convergence.json'), {
        cache: 'no-cache',
      })
      if (!response.ok) {
        throw new Error(
          `Convergence matrix not available (HTTP ${response.status}). ` +
            `Build it with \`npm run connectivity:fetch\`.`,
        )
      }
      return (await response.json()) as ConvergenceMatrix
    })()
    // A failed fetch must not be cached, or one bad moment disables the hub
    // map for the rest of the session.
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}

/** Forget the cached matrix. For tests. */
export function clearConvergenceCache(): void {
  pending = null
}

/**
 * Strength per structure, on the chosen metric.
 *
 * Returns the same shape the retrograde heat map takes, so the second brain
 * paints a convergence map and a back-trace with one piece of code.
 */
/**
 * The same coordinate in the other hemisphere.
 *
 * A reflection of the ML component only, so the depth and the AP level — the
 * things that decide which structure the target is in — are untouched and the
 * two answers are comparable.
 *
 * Named for what it does and no more. An earlier version called the two
 * directions ipsi and contra, on the reasoning that Allen injects the right
 * hemisphere so a target there is reached from its own side. That holds for
 * the hub map's corpus, 81% right, and not for the wider one the back-trace
 * searches: of 116 experiments reaching an MOs target at ML −0.90, 75 were
 * injected on the left. Whether a *source* is ipsilateral is a fact about
 * that source, and `sourceSide` reads it off directly.
 */
export function flipHemisphere<T extends { ml: number }>(coord: T): T {
  // Normalised, because negating zero gives -0: harmless in arithmetic and
  // surprising everywhere it is compared or printed.
  return { ...coord, ml: coord.ml === 0 ? 0 : -coord.ml }
}

/** How a side reads on screen. */
export const SIDE_LABEL: Record<Side, string> = {
  ipsi: 'ipsi',
  contra: 'contra',
}

export interface SidedStrengths {
  readonly ipsi: ReadonlyMap<number, number>
  readonly contra: ReadonlyMap<number, number>
}

export function convergenceStrengths(
  matrix: ConvergenceMatrix,
  metric: ConvergenceMetric,
  threshold = DEFAULT_CONNECTION_THRESHOLD,
): SidedStrengths {
  const ipsi = new Map<number, number>()
  const contra = new Map<number, number>()

  for (const [idText, entry] of Object.entries(matrix.convergence)) {
    const id = Number(idText)
    if (!Number.isFinite(id)) continue

    for (const [side, column, out] of [
      ['ipsi', 1, ipsi],
      ['contra', 2, contra],
    ] as const) {
      void side
      const kept = entry.sources
        .map((source) => source[column] ?? 0)
        .filter((density) => density >= threshold)
      if (kept.length === 0) continue

      const value =
        metric === 'count'
          ? kept.length
          : // Mean over the sources that clear the threshold, not over all 293
            // structures: dividing by the ones that do not project would turn
            // the measure back into a count wearing a different name.
            kept.reduce((sum, d) => sum + d, 0) / kept.length

      out.set(id, Math.max(out.get(id) ?? 0, value))
    }
  }

  return { ipsi, contra }
}

/**
 * Hub ranking, for the panel's list.
 *
 * Ranked on the ipsilateral side, and the contralateral value is carried
 * alongside rather than averaged in. The ratio between them is a real property
 * of a region — a structure fed almost equally from both sides is a different
 * kind of hub from one fed overwhelmingly from its own — and an average
 * destroys exactly that.
 */
export function rankConvergence(
  matrix: ConvergenceMatrix,
  metric: ConvergenceMetric,
  threshold = DEFAULT_CONNECTION_THRESHOLD,
): {
  id: number
  acronym: string
  value: number
  contra: number
  sourceCount: number
}[] {
  const { ipsi, contra } = convergenceStrengths(matrix, metric, threshold)

  return [...ipsi.entries()]
    .map(([id, value]) => ({
      id,
      acronym: matrix.convergence[String(id)]?.acronym ?? String(id),
      value,
      contra: contra.get(id) ?? 0,
      sourceCount: (matrix.convergence[String(id)]?.sources ?? []).filter(
        (source) => (source[1] ?? 0) >= threshold,
      ).length,
    }))
    .sort((a, b) => b.value - a.value)
}

/** How a metric's value reads in the caption and the list. */
export function formatConvergence(metric: ConvergenceMetric, value: number): string {
  return metric === 'count' ? `${Math.round(value)}` : value.toFixed(3)
}

/** Caveats carried wherever the hub map is shown. */
export const CONVERGENCE_CAVEATS: readonly string[] = [
  'A map of the whole connectome, not of your target: moving the target does not ' +
    'change it. The target is only a reference mark.',
  'The right half is the injected hemisphere.',
  'Anterograde data, so fibres passing through a region count the same as terminals.',
  'One value per source region, its strongest experiment — counting experiments would ' +
    'rank how often Allen injected somewhere instead of the anatomy.',
  'Only the 293 summary regions, and only the 213 Allen injected.',
  'Normal adult mice (Allen products 5, 6, 35, 36, 42, 44, 45). Disease, ageing and ' +
    'retina studies are left out.',
]
