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
 * — 293 queries against the Allen API, bundled as one small asset — because
 * doing it at runtime would mean the user waiting through all 293.
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
 * the 293 summary structures and to regions Allen injected: a region absent
 * from the matrix may simply never have been a source. And the matrix is
 * bilateral — hemisphere 3 — so a lateralised projection is pooled with its
 * weaker mirror.
 */

/** Resolve a path inside the bundled connectivity assets. */
export function connectivityUrl(path: string): string {
  return `${import.meta.env.BASE_URL}connectivity/${path}`.replace(/([^:])\/{2,}/g, '$1/')
}

/** `[sourceStructureId, strongestProjectionDensity]`. */
export type SourceEntry = readonly [number, number]

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
      const response = await fetch(connectivityUrl('convergence.json'))
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
export function convergenceStrengths(
  matrix: ConvergenceMatrix,
  metric: ConvergenceMetric,
  threshold = DEFAULT_CONNECTION_THRESHOLD,
): Map<number, number> {
  const out = new Map<number, number>()

  for (const [idText, entry] of Object.entries(matrix.convergence)) {
    const id = Number(idText)
    if (!Number.isFinite(id)) continue

    const kept = entry.sources.filter(([, density]) => density >= threshold)
    if (kept.length === 0) continue

    if (metric === 'count') {
      out.set(id, kept.length)
    } else {
      // Mean over the sources that clear the threshold, not over all 293
      // structures: dividing by the ones that do not project would turn the
      // measure back into a count wearing a different name.
      out.set(id, kept.reduce((sum, [, d]) => sum + d, 0) / kept.length)
    }
  }

  return out
}

/** Hub ranking, for the panel's list. */
export function rankConvergence(
  matrix: ConvergenceMatrix,
  metric: ConvergenceMetric,
  threshold = DEFAULT_CONNECTION_THRESHOLD,
): { id: number; acronym: string; value: number; sourceCount: number }[] {
  const strengths = convergenceStrengths(matrix, metric, threshold)

  return [...strengths.entries()]
    .map(([id, value]) => ({
      id,
      acronym: matrix.convergence[String(id)]?.acronym ?? String(id),
      value,
      sourceCount: (matrix.convergence[String(id)]?.sources ?? []).filter(
        ([, d]) => d >= threshold,
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
  'Anterograde data, so "projects into" is bulk signal detected in the region and counts ' +
    'fibres passing through the same as terminals.',
  'One value per source region, its strongest experiment — counting experiments would ' +
    'rank how often Allen injected somewhere rather than the anatomy.',
  'Limited to the 293 summary structures, and to regions Allen injected.',
  'Bilateral: left and right are pooled, so a lateralised projection is averaged with ' +
    'its weaker mirror.',
]
