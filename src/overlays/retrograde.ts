/**
 * Back-tracing: what projects *to* a target.
 *
 * Every other connectivity view in BrainCAD runs forwards — pick a source
 * region, see where its axons go. Planning a recording or a prism usually asks
 * the opposite question: *this* is the coordinate I can reach, so what talks to
 * it? That is the question this module answers.
 *
 * ## It is not retrograde tracing, and must never be shown as if it were
 *
 * The Allen Connectivity Atlas is entirely anterograde: a tracer goes into a
 * source and the pipeline measures where it ends up. There is no retrograde
 * dataset to query. What `mouse_connectivity_target_spatial` does is invert the
 * anterograde corpus — of the ~2500 injections, which ones deposit signal at
 * this voxel? — and report their injection sites. That is a well-founded way to
 * ask "what projects here", but it differs from true retrograde tracing in ways
 * that change how the answer should be read:
 *
 *  - **It is limited by where Allen injected.** A region with no injection in
 *    the corpus cannot appear, however strongly it projects. Absence is
 *    absence of evidence.
 *  - **Signal is bulk projection density, not labelled cell bodies.** Fibres of
 *    passage running through the target count the same as terminals in it.
 *  - **The injection saturates.** An experiment injected at or near the target
 *    reports a density near 1.0, which says the tracer was put there, not that
 *    the region projects there. Those rows are flagged, not hidden — see
 *    {@link RetrogradeSource.targetInsideInjection}.
 *
 * ## The path is Allen's, and it is an interpolation
 *
 * Each row carries a `path`: a polyline from the seed voxel back to the
 * injection site, sampled through the projection volume. It is what makes a
 * *visible* back-trace possible, and it is genuinely useful for seeing which
 * way afferents arrive. It is not a traced axon and not a tractogram — it is a
 * route through a density field, and a single reconstructed neuron (the
 * MouseLight overlay) is the thing to reach for when the individual arbor
 * matters.
 */

import type { Stereotaxic } from '../atlas/coords.ts'
import { stereotaxicToVoxel, voxelToStereotaxic } from '../atlas/coords.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { isInsideVolume } from '../atlas/coords.ts'
import { TransientApiError } from './connectivity.ts'

const API_BASE = 'https://api.brain-map.org'

/** One point on a back-traced route, already in stereotaxic millimetres. */
export interface BacktracePoint {
  readonly coord: Stereotaxic
  /** Projection density sampled at this point, 0-1. */
  readonly density: number
}

/** One experiment whose projection reaches the target. */
export interface RetrogradeSource {
  readonly experimentId: number
  readonly structureId: number
  readonly structureAbbrev: string
  readonly structureName: string
  /** Allen ontology colour, as a CSS hex string. */
  readonly structureColor: string
  readonly transgenicLine: string
  /** Projection density at the target voxel, 0-1. */
  readonly densityAtTarget: number
  readonly injectionVolumeMm3: number | null
  /** Injection centre in stereotaxic millimetres, via the active profile. */
  readonly injectionCentre: Stereotaxic | null
  /** Straight-line distance from the injection centre to the target, mm. */
  readonly injectionDistanceMm: number | null
  /** Sphere-equivalent radius of the reported injection volume, mm. */
  readonly injectionRadiusMm: number | null
  /**
   * Whether the target appears to lie inside this experiment's injection.
   *
   * See {@link targetInsideInjection} for the rule and why the row is flagged
   * rather than dropped.
   */
  readonly targetInsideInjection: boolean
  readonly injectionStructures: readonly string[]
  /** Allen's route from the target back to the injection site. */
  readonly path: readonly BacktracePoint[]
}

/** One row of the retrograde matrix: a source structure, pooled over experiments. */
export interface RetrogradeMatrixRow {
  readonly structureId: number
  readonly abbrev: string
  readonly name: string
  readonly color: string
  /** How many experiments injected here reach the target. */
  readonly experimentCount: number
  /** Strongest density any of them deposits at the target. */
  readonly peakDensity: number
  /** Mean across this structure's experiments. */
  readonly meanDensity: number
  /** How many of those experiments have the target inside the injection. */
  readonly overlappingCount: number
  /** The experiments themselves, strongest first. */
  readonly sources: readonly RetrogradeSource[]
}

interface RawPathPoint {
  coord?: number[]
  density?: number
  intensity?: number
}

interface RawRow {
  id?: number
  'structure-id'?: number
  'structure-abbrev'?: string
  'structure-name'?: string
  'structure-color'?: string
  'transgenic-line'?: string
  'injection-volume'?: number
  'injection-coordinates'?: number[]
  'injection-structures'?: { abbreviation?: string }[]
  density?: number
  projection?: number
  path?: RawPathPoint[]
}

/**
 * The seed point the Allen service wants, as `"a,b,c"` in CCF micrometres.
 *
 * The API's triple is in the same axis order as the volume, which is the fact
 * `OverlaysPanel` already verified in the other direction when it places an
 * injection marker from `injection-coordinates`. So this is that conversion
 * run backwards, through the same profile — which is what keeps a target
 * nudged in the UI and the voxel the service searches the same point.
 *
 * Returns null when the target is outside the volume: the service answers a
 * nonsense seed with a plausible-looking list rather than an error, so the
 * check has to happen here.
 */
export function seedPointParam(
  profile: CoordinateProfile,
  coord: Stereotaxic,
): string | null {
  const voxel = stereotaxicToVoxel(profile, coord)
  if (!isInsideVolume(profile.space, voxel)) return null

  const um = [voxel.i0, voxel.i1, voxel.i2].map((i) =>
    Math.round(i * profile.space.resolutionUm),
  )
  return um.join(',')
}

/**
 * Sphere-equivalent radius of an injection, in millimetres.
 *
 * Allen reports a volume, not an extent. A sphere is a poor model of a real
 * injection — they run long along the pipette track — but it is the only shape
 * the payload supports, and it is used only to decide whether a row deserves a
 * flag, never to compute a distance that is shown as a measurement.
 */
export function injectionRadiusMm(volumeMm3: number): number {
  return Math.cbrt((3 * volumeMm3) / (4 * Math.PI))
}

/**
 * How far outside the sphere-equivalent radius still counts as "inside".
 *
 * Two, because an injection is elongated along the pipette track rather than
 * spherical, so its long axis reaches roughly twice as far as the equivalent
 * sphere. Calibrated against the dorsal-CA1 probe in
 * `real-retrograde.test.ts`, where the three CA1 injections that saturate the
 * target voxel sit 0.37-0.82 mm out with equivalent radii of 0.25-0.32 mm, and
 * distant genuine sources (NDB at 5.5 mm, ENTl further) are nowhere near.
 */
export const INJECTION_OVERLAP_FACTOR = 2

/**
 * Whether the target lies within an experiment's injection.
 *
 * Flagged rather than filtered, and the flag travels into the UI as a visible
 * tag. Dropping these rows silently would be worse than useless for exactly
 * the regions people plan in: a dorsal-CA1 target loses CA3 — the single most
 * important input to CA1 — because a CA3 injection large enough to label
 * Schaffer collaterals also spills across the boundary. The user can see the
 * overlap and judge it; the software cannot.
 */
export function targetInsideInjection(
  distanceMm: number | null,
  radiusMm: number | null,
): boolean {
  if (distanceMm === null || radiusMm === null) return false
  return distanceMm <= radiusMm * INJECTION_OVERLAP_FACTOR
}

function distanceMm(a: Stereotaxic, b: Stereotaxic): number {
  return Math.hypot(a.ap - b.ap, a.ml - b.ml, a.dv - b.dv)
}

/** Convert a raw API row into the shape the rest of BrainCAD speaks. */
function normaliseRow(
  profile: CoordinateProfile,
  target: Stereotaxic,
  row: RawRow,
): RetrogradeSource | null {
  if (typeof row.id !== 'number') return null

  const toStereotaxic = (um: readonly number[]): Stereotaxic =>
    voxelToStereotaxic(profile, {
      i0: um[0]! / profile.space.resolutionUm,
      i1: um[1]! / profile.space.resolutionUm,
      i2: um[2]! / profile.space.resolutionUm,
    })

  const rawCentre = row['injection-coordinates']
  const injectionCentre =
    Array.isArray(rawCentre) && rawCentre.length === 3 ? toStereotaxic(rawCentre) : null

  const volume = typeof row['injection-volume'] === 'number' ? row['injection-volume'] : null
  const radius = volume !== null && volume > 0 ? injectionRadiusMm(volume) : null
  const distance = injectionCentre ? distanceMm(injectionCentre, target) : null

  const path: BacktracePoint[] = (row.path ?? [])
    .filter((p): p is Required<Pick<RawPathPoint, 'coord'>> & RawPathPoint =>
      Array.isArray(p?.coord) && p.coord.length === 3,
    )
    .map((p) => ({
      coord: toStereotaxic(p.coord),
      density: typeof p.density === 'number' ? p.density : 0,
    }))

  return {
    experimentId: row.id,
    structureId: typeof row['structure-id'] === 'number' ? row['structure-id'] : 0,
    structureAbbrev: row['structure-abbrev'] ?? '—',
    structureName: row['structure-name'] ?? 'Unknown structure',
    // The API gives bare hex with no leading hash.
    structureColor: `#${(row['structure-color'] ?? '888888').replace(/^#/, '')}`,
    transgenicLine: row['transgenic-line'] ?? '',
    densityAtTarget:
      typeof row.density === 'number'
        ? row.density
        : typeof row.projection === 'number'
          ? row.projection
          : 0,
    injectionVolumeMm3: volume,
    injectionCentre,
    injectionDistanceMm: distance,
    injectionRadiusMm: radius,
    targetInsideInjection: targetInsideInjection(distance, radius),
    injectionStructures: (row['injection-structures'] ?? [])
      .map((s) => s?.abbreviation)
      .filter((a): a is string => typeof a === 'string' && a.length > 0),
    path,
  }
}

/** Parse a whole service response. Exported so a fixture can drive it. */
export function parseRetrogradeResponse(
  profile: CoordinateProfile,
  target: Stereotaxic,
  payload: { success?: boolean; msg?: unknown },
  limit = DEFAULT_SOURCE_LIMIT,
): RetrogradeSource[] {
  if (!payload.success) {
    const detail = typeof payload.msg === 'string' ? payload.msg : 'no detail given'
    // Same intermittent failure the forward client documents, under a second
    // wording ("failed on parsing response") this service adds of its own.
    if (/informatics service request failed|timeout|temporarily/i.test(detail)) {
      throw new TransientApiError(`Allen spatial search is busy: ${detail}`)
    }
    throw new Error(`Allen API rejected the query: ${detail}`)
  }

  // A seed in white matter or outside any projection answers success with a
  // non-array `msg`, exactly as the forward service does for a structure with
  // no experiments. That is an empty result, not a failure.
  if (!Array.isArray(payload.msg)) return []

  return (payload.msg as RawRow[])
    .map((row) => normaliseRow(profile, target, row))
    .filter((row): row is RetrogradeSource => row !== null)
    // The service returns rows in no useful order — the second row of a real
    // response carried a tenth the density of the fourth — so ranking has to
    // happen here before anything is truncated.
    .sort((a, b) => b.densityAtTarget - a.densityAtTarget)
    .slice(0, limit)
}

/**
 * How many experiments to keep, after ranking.
 *
 * Generous, because the whole response is already downloaded — the limit only
 * bounds what is parsed and drawn. It has to stay well above the panel's
 * "show top N structures" control, or the far end of that slider would show a
 * truncated list that looks like the complete answer. A real seed returns
 * between 70 and 340 rows.
 */
export const DEFAULT_SOURCE_LIMIT = 400

/** Backoff between retries, matching the forward connectivity client. */
export const RETRY_DELAYS_MS = [400, 1200, 2500]

/**
 * Raw responses, keyed by seed point.
 *
 * This search is expensive at the far end — measured between 5 and 15 seconds
 * for a hippocampal seed — and the whole point of the number-pad nudge is to
 * walk a target around and watch the answer change. Walking back over a
 * coordinate is the common case, so the response is kept.
 *
 * The *raw* payload, not the parsed sources: parsing measures each injection's
 * distance from the target, and two targets a few micrometres apart share a
 * seed voxel while deserving their own distances.
 */
const responseCache = new Map<string, unknown>()

/** How many responses to keep. Each is a few hundred kilobytes of JSON. */
const CACHE_LIMIT = 24

function cacheResponse(seed: string, payload: unknown): void {
  // Oldest out first. A Map iterates in insertion order, so the first key is
  // the least recently fetched.
  if (responseCache.size >= CACHE_LIMIT) {
    const oldest = responseCache.keys().next().value
    if (oldest !== undefined) responseCache.delete(oldest)
  }
  responseCache.set(seed, payload)
}

/** Whether a seed's answer is already in hand. Drives the panel's hint. */
export function isSeedCached(seed: string): boolean {
  return responseCache.has(seed)
}

/** Forget every cached response. Exported for tests. */
export function clearRetrogradeCache(): void {
  responseCache.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetrogradeQueryOptions {
  /** Maximum experiments to keep, after ranking by density. */
  limit?: number
  retryDelaysMs?: readonly number[]
  signal?: AbortSignal
}

/**
 * Find every experiment whose projection reaches this target.
 *
 * Throws a plain `Error` with the target coordinate named when the point is
 * outside the volume, rather than asking the service: a seed outside the brain
 * comes back as a confident-looking list of the nearest thing it could find.
 */
export async function searchRetrograde(
  profile: CoordinateProfile,
  target: Stereotaxic,
  options: RetrogradeQueryOptions = {},
): Promise<RetrogradeSource[]> {
  const seed = seedPointParam(profile, target)
  if (!seed) {
    throw new Error(
      `AP ${target.ap.toFixed(2)}, ML ${target.ml.toFixed(2)}, DV ${target.dv.toFixed(2)} ` +
        `is outside the atlas volume, so there is nothing to trace back from.`,
    )
  }

  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await searchRetrogradeOnce(profile, target, seed, options)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (!(error instanceof TransientApiError)) throw error
      const delay = delays[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
  }

  throw lastError ?? new Error('Allen spatial search failed.')
}

async function searchRetrogradeOnce(
  profile: CoordinateProfile,
  target: Stereotaxic,
  seed: string,
  options: RetrogradeQueryOptions,
): Promise<RetrogradeSource[]> {
  const limit = options.limit ?? DEFAULT_SOURCE_LIMIT

  const cached = responseCache.get(seed)
  if (cached !== undefined) {
    return parseRetrogradeResponse(
      profile,
      target,
      cached as { success?: boolean; msg?: unknown },
      limit,
    )
  }

  const criteria = `service::mouse_connectivity_target_spatial[seed_point$eq${seed}]`
  const url = `${API_BASE}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`

  let response: Response
  try {
    response = await fetch(url, options.signal ? { signal: options.signal } : undefined)
  } catch (error) {
    // An abort is the caller's own doing and must propagate untouched, or a
    // superseded query would retry three times after being cancelled.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    // Everything else reaching here is a bare `TypeError: Failed to fetch`,
    // which says nothing a user can act on. The search is slow enough that the
    // connection genuinely does drop sometimes, so it is worth another go.
    throw new TransientApiError(
      `Could not reach the Allen spatial search (${
        error instanceof Error ? error.message : String(error)
      }). It is a slow query and the connection may have dropped.`,
    )
  }

  if (!response.ok) throw new Error(`Allen API returned HTTP ${response.status}`)

  const payload = (await response.json()) as { success?: boolean; msg?: unknown }
  const sources = parseRetrogradeResponse(profile, target, payload, limit)
  // Cached only after parsing, so a transient failure is never stored as the
  // answer for this seed.
  cacheResponse(seed, payload)
  return sources
}

/**
 * Pool experiments by their injection structure — the retrograde matrix.
 *
 * Ranked by peak rather than by mean or by count. A structure with one strong
 * experiment and nine weak ones is a real input seen once well; ranking by mean
 * would bury it under a structure sampled consistently but faintly, and ranking
 * by count would rank the Allen Institute's sampling effort rather than the
 * anatomy.
 */
export function retrogradeMatrix(
  sources: readonly RetrogradeSource[],
): RetrogradeMatrixRow[] {
  const byStructure = new Map<string, RetrogradeSource[]>()

  for (const source of sources) {
    const key = source.structureAbbrev
    const bucket = byStructure.get(key)
    if (bucket) bucket.push(source)
    else byStructure.set(key, [source])
  }

  const rows: RetrogradeMatrixRow[] = []
  for (const group of byStructure.values()) {
    const ranked = [...group].sort((a, b) => b.densityAtTarget - a.densityAtTarget)
    const first = ranked[0]!
    const total = ranked.reduce((sum, s) => sum + s.densityAtTarget, 0)

    rows.push({
      structureId: first.structureId,
      abbrev: first.structureAbbrev,
      name: first.structureName,
      color: first.structureColor,
      experimentCount: ranked.length,
      peakDensity: first.densityAtTarget,
      meanDensity: total / ranked.length,
      overlappingCount: ranked.filter((s) => s.targetInsideInjection).length,
      sources: ranked,
    })
  }

  return rows.sort((a, b) => b.peakDensity - a.peakDensity)
}

/** Link to an experiment's page, so a plan can be traced to its source. */
export function experimentUrl(experimentId: number): string {
  return `https://connectivity.brain-map.org/projection/experiment/${experimentId}`
}

/** Citation recorded with a back-trace, for the planning sheet. */
export const RETROGRADE_CITATION =
  'Allen Mouse Brain Connectivity Atlas, spatial target search ' +
  '(mouse_connectivity_target_spatial). Oh et al. (2014), Nature 508:207-214.'

/**
 * What a reader must know before acting on a back-trace.
 *
 * Each line corrects a different plausible misreading, and the one most likely
 * to mislead is first: this looks like retrograde tracing and is not.
 */
export const RETROGRADE_CAVEATS: readonly string[] = [
  'This is anterograde data read backwards, not retrograde tracing. It finds ' +
    'injections whose projections reach the target, and reports where they were injected.',
  'Limited to regions the Allen Institute injected. A region absent from this list ' +
    'may simply never have been injected.',
  'Signal is bulk projection density, so fibres passing through the target count the ' +
    'same as terminals in it.',
  'An experiment injected at the target saturates near 1.0; those rows are tagged ' +
    '"at target" and say the tracer was put there, not that the region projects there.',
  'Paths are Allen routes through a density volume, interpolated — not traced axons.',
  'Every experiment is one injection in one animal, registered to the averaged CCFv3.',
]

/**
 * Which sources the view is currently showing.
 *
 * One function, called by both the 3D routes and the panel's table, so the
 * picture and the list can never disagree about which experiments are in play.
 */
export function visibleSources(
  sources: readonly RetrogradeSource[],
  options: {
    includeOverlapping: boolean
    topStructures: number
    focusAbbrev: string | null
  },
): RetrogradeSource[] {
  const kept = sources.filter(
    (s) => options.includeOverlapping || !s.targetInsideInjection,
  )

  if (options.focusAbbrev) {
    return kept.filter((s) => s.structureAbbrev === options.focusAbbrev)
  }

  // Ranked by structure, not by experiment: taking the top N *experiments*
  // would show eight CA3 injections and nothing else, when the question is
  // which regions project here.
  const order: string[] = []
  for (const source of kept) {
    if (!order.includes(source.structureAbbrev)) order.push(source.structureAbbrev)
  }
  const allowed = new Set(order.slice(0, options.topStructures))
  return kept.filter((s) => allowed.has(s.structureAbbrev))
}
