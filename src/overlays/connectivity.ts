/**
 * Allen Mouse Connectivity Atlas client.
 *
 * Fetches anterograde tracing experiments and their projection-density volumes
 * straight from the Allen API. Both endpoints send
 * `Access-Control-Allow-Origin: *` over HTTPS, so this needs no proxy and
 * BrainCAD stays a static site.
 *
 * The projection volumes are a gift for this application: NRRD, gzip, and in
 * the *same* CCF space as the annotation volume at exactly half its linear
 * resolution — 132 x 80 x 114 at 100 µm against 264 x 160 x 228 at 50 µm. The
 * existing reader, coordinate profile and world transform all apply unchanged,
 * so there is no registration step at all.
 *
 * What this data *is* matters as much as how it loads. A projection density
 * volume is a measurement from one injection into one animal. It is not a
 * prediction for the animal on the rig, and the overlay metadata exists so it
 * can never be presented as one.
 */

const API_BASE = 'https://api.brain-map.org'

/** One anterograde tracing experiment. */
export interface ConnectivityExperiment {
  readonly id: number
  /** Primary injection structure name, e.g. "Primary visual area". */
  readonly structureName: string
  readonly structureAbbrev: string
  /** Cre line, or empty for wild-type. */
  readonly transgenicLine: string
  readonly gender: string
  readonly strain: string
  /** Injection volume in mm³, when reported. */
  readonly injectionVolumeMm3: number | null
  /** Injection site in CCF micrometres, as the API reports it. */
  readonly injectionCoordinatesUm: readonly [number, number, number] | null
  /**
   * Every structure the injection actually touched, primary first.
   *
   * Injections are rarely confined to one region — a VISp injection was
   * verified spreading into VISl, VISpl, VISli and VISpor — and a projection
   * read as coming purely from the named structure would be over-attributed.
   */
  readonly injectionStructures: readonly string[]
}

interface RawExperiment {
  id: number
  'structure-name'?: string
  'structure-abbrev'?: string
  'transgenic-line'?: string
  gender?: string
  strain?: string
  'injection-volume'?: number
  'injection-coordinates'?: number[]
  'injection-structures'?: { abbreviation?: string; name?: string }[]
}

/** Raised when the Allen service fails in a way that is worth retrying. */
export class TransientApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientApiError'
  }
}

/**
 * Whether an API failure looks transient.
 *
 * The connectivity service intermittently answers a perfectly valid query with
 * `success: false` and "Informatics service request failed" — the same
 * structure id succeeds on the very next request. Treating that as a permanent
 * rejection told users their region had no data when it simply had not been
 * asked twice.
 */
function isTransient(message: string): boolean {
  return /informatics service request failed|timeout|temporarily/i.test(message)
}

/** Backoff between retries. Overridable so tests need not sleep through it. */
export const RETRY_DELAYS_MS = [400, 1200, 2500]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Search experiments by injection structure id.
 *
 * `primaryStructureOnly` restricts results to experiments whose *primary*
 * injection site is this structure. Without it the API also returns
 * experiments that merely spilled into it, which is rarely what someone
 * planning from a source region means.
 *
 * Retries transient service failures before giving up, since they are common
 * and indistinguishable to the user from "this region has no data".
 */
export async function searchExperiments(
  structureId: number,
  options: {
    primaryStructureOnly?: boolean
    limit?: number
    retryDelaysMs?: readonly number[]
  } = {},
): Promise<ConnectivityExperiment[]> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await searchExperimentsOnce(structureId, options)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (!(error instanceof TransientApiError)) throw error
      const delay = delays[attempt]
      if (delay === undefined) break
      await sleep(delay)
    }
  }

  throw lastError ?? new Error('Allen API request failed.')
}

async function searchExperimentsOnce(
  structureId: number,
  options: { primaryStructureOnly?: boolean; limit?: number } = {},
): Promise<ConnectivityExperiment[]> {
  const { primaryStructureOnly = true, limit = 25 } = options

  // The service endpoint ignores num_rows — it was verified returning all 283
  // VISp experiments for a requested 5, and rejects the rma::options form
  // outright. So the limit is applied client-side, and the payload is small
  // enough (a few hundred short records) that fetching it all is fine.
  const criteria =
    `service::mouse_connectivity_injection_structure` +
    `[injection_structures$eq${structureId}]` +
    `[primary_structure_only$eq${primaryStructureOnly}]`

  const url = `${API_BASE}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Allen API returned HTTP ${response.status}`)
  }

  const payload = (await response.json()) as {
    success?: boolean
    num_rows?: number
    msg?: unknown
  }

  if (!payload.success) {
    const detail = typeof payload.msg === 'string' ? payload.msg : 'no detail given'
    if (isTransient(detail)) {
      throw new TransientApiError(`Allen connectivity service is busy: ${detail}`)
    }
    throw new Error(`Allen API rejected the query: ${detail}`)
  }

  // A structure with no tracing experiments answers success:true with
  // `msg: {}` — an empty OBJECT, not an empty array. Requiring an array here
  // reported "no data for this region" as a query failure, which is the
  // opposite of what it means and sends the user looking for a bug.
  if (!Array.isArray(payload.msg)) return []

  return (payload.msg as RawExperiment[])
    .filter((row) => typeof row?.id === 'number')
    .slice(0, limit)
    .map(normaliseExperiment)
}

/** Total experiments the API reported, before the client-side limit. */
export async function countExperiments(structureId: number): Promise<number> {
  const criteria =
    `service::mouse_connectivity_injection_structure` +
    `[injection_structures$eq${structureId}][primary_structure_only$eqtrue]`
  const response = await fetch(
    `${API_BASE}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`,
  )
  if (!response.ok) return 0
  const payload = (await response.json()) as { msg?: unknown[] }
  return Array.isArray(payload.msg) ? payload.msg.length : 0
}

function normaliseExperiment(row: RawExperiment): ConnectivityExperiment {
  const coords = row['injection-coordinates']
  return {
    id: row.id,
    structureName: row['structure-name'] ?? 'Unknown structure',
    structureAbbrev: row['structure-abbrev'] ?? '—',
    transgenicLine: row['transgenic-line'] ?? '',
    gender: row.gender ?? '',
    strain: row.strain ?? '',
    injectionVolumeMm3:
      typeof row['injection-volume'] === 'number' ? row['injection-volume'] : null,
    injectionCoordinatesUm:
      Array.isArray(coords) && coords.length === 3
        ? [coords[0]!, coords[1]!, coords[2]!]
        : null,
    injectionStructures: (row['injection-structures'] ?? [])
      .map((s) => s?.abbreviation)
      .filter((a): a is string => typeof a === 'string' && a.length > 0),
  }
}

/** Grid resolutions the connectivity API publishes, in micrometres. */
export type GridResolutionUm = 10 | 25 | 50 | 100

/**
 * URL of a projection-density volume.
 *
 * 100 µm is the default because it is 277 KB and decodes to a 1.2 M-voxel
 * float array — enough to place a point cloud convincingly while staying
 * something a browser can fetch without ceremony. 25 µm is ~64x larger.
 */
export function projectionVolumeUrl(
  experimentId: number,
  resolutionUm: GridResolutionUm = 100,
): string {
  return `${API_BASE}/grid_data/download_file/${experimentId}?image=projection_density&resolution=${resolutionUm}`
}

/**
 * URL of the injection-site volume for an experiment.
 *
 * `injection_fraction` gives the fraction of each voxel occupied by the
 * injection, which is what distinguishes the site itself from the axons
 * leaving it. At 100 µm it is under 10 KB, so loading it alongside the
 * projection volume costs nothing.
 *
 * This matters more than its size suggests. `projection_density` *includes*
 * the injection site, and measured on a real experiment the site averages 0.997
 * while genuine projections average 0.010 — a hundredfold difference. Rendered
 * without separation, the brightest feature of a projection overlay is the
 * injection, which is the one place the tracer did not travel to.
 */
export function injectionVolumeUrl(
  experimentId: number,
  resolutionUm: GridResolutionUm = 100,
): string {
  return `${API_BASE}/grid_data/download_file/${experimentId}?image=injection_fraction&resolution=${resolutionUm}`
}

/** A short human description, for the overlay list and the planning sheet. */
export function describeExperiment(experiment: ConnectivityExperiment): string {
  const line = experiment.transgenicLine || 'wild-type'
  const volume =
    experiment.injectionVolumeMm3 !== null
      ? `, ${experiment.injectionVolumeMm3.toFixed(2)} mm³`
      : ''
  return `${experiment.structureAbbrev} · ${line}${volume}`
}

/** Citation line recorded with every loaded overlay. */
export function experimentCitation(experiment: ConnectivityExperiment): string {
  return (
    `Allen Mouse Brain Connectivity Atlas, experiment ${experiment.id} ` +
    `(${experiment.structureName}${experiment.transgenicLine ? `, ${experiment.transgenicLine}` : ''}). ` +
    `Oh et al. (2014), Nature 508:207-214.`
  )
}

/** Link to the experiment's page, so a plan can be traced to its source. */
export function experimentUrl(experimentId: number): string {
  return `https://connectivity.brain-map.org/projection/experiment/${experimentId}`
}
