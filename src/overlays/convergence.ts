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
  type AnatomicalAxis,
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
 * Every experiment is read relative to its own injection, and the maps are
 * drawn with the injected side on the right — the same convention the voxel
 * map and the target buttons use, so nothing on screen contradicts anything
 * else about which half is which.
 */
export type Side = 'ipsi' | 'contra'

/**
 * The side a voxel falls on.
 *
 * Right is ipsilateral, and the choice is not arbitrary even though the
 * mirroring could have gone either way. Allen injects the right hemisphere, so
 * a target there is reached from its own side — which is what makes the ipsi
 * button send the target right. An earlier build normalised onto the left and
 * then had the maps and that button putting opposite words on the same pixel.
 *
 * The midline is the ML axis's own midpoint rather than a constant, because
 * the two bundled coordinate profiles do not put it in quite the same place.
 */
export function voxelSide(
  space: VolumeSpace,
  voxel: { i0: number; i1: number; i2: number },
): Side {
  const mlAxis = arrayAxisFor(space, 'ML')
  const index = [voxel.i0, voxel.i1, voxel.i2][mlAxis]!
  const midpoint = space.shape[mlAxis]! / 2
  const left = indexIncreasesPositively(space.axes[mlAxis]!)
    ? index < midpoint
    : index >= midpoint
  return left ? 'contra' : 'ipsi'
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
export interface SectionSides {
  /** Hemisphere on the left of the image, or null if the section is one side. */
  readonly left: Side | null
  readonly right: Side | null
  /** Set instead when the whole section lies in one hemisphere. */
  readonly whole: Side | null
}

/**
 * Which hemisphere each half of a section shows.
 *
 * The caption can say "left is ipsilateral" and still leave a reader counting
 * across the image to work out which half they are looking at — and a sagittal
 * section has no halves at all: it is one hemisphere, and which one depends on
 * where the slice was taken.
 *
 * Read off the *display* convention rather than the volume's storage order.
 * `extractSlice` always puts +ML to the right whatever the array does, so the
 * animal's right — ipsilateral, by the mirroring the data was built with — is
 * always the right of the image.
 */
export function sectionSides(
  axis: AnatomicalAxis,
  coord: { ml: number },
): SectionSides {
  if (axis === 'ML') {
    // Sagittal: one hemisphere, named by where the slice sits. Exactly on the
    // midline it is neither, and saying so is better than rounding to one.
    const whole: Side | null = coord.ml > 0 ? 'ipsi' : coord.ml < 0 ? 'contra' : null
    return { left: null, right: null, whole }
  }

  return { left: 'contra', right: 'ipsi', whole: null }
}

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
  'A property of the Allen connectome, not of your target — moving the target does not ' +
    'change this map. The target is drawn only as a reference mark.',
  'Right is ipsilateral to the injection and left is contralateral: every experiment is ' +
    'read relative to its own injection, which Allen places on the right for 81% of ' +
    'the 2,810 experiments here.',
  'Anterograde data, so "projects into" is bulk signal detected in the region and counts ' +
    'fibres passing through the same as terminals.',
  'One value per source region, its strongest experiment — counting experiments would ' +
    'rank how often Allen injected somewhere rather than the anatomy.',
  'Limited to the 293 summary structures, and to the 213 of them Allen injected.',
  'Allen products 5, 6, 35, 36, 42, 44 and 45 — the anterograde survey of the normal ' +
    'adult mouse. The Alzheimer, aged-cohort and retina studies are left out.',
]
