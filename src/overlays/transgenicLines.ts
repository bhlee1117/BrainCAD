/**
 * Transgenic driver line descriptions.
 *
 * A Cre line name alone — `Slc17a7-IRES2-Cre`, `Gpr26-Cre_KO250` — says nothing
 * about which cells were labelled unless you already know the line. That makes
 * an experiment list unreadable to anyone outside the handful of labs using
 * those drivers, which is most people looking at a projection overlay.
 *
 * The descriptions come from the Allen API rather than being written here.
 * Summarising what a driver labels is a scientific claim, and the atlas that
 * produced the tracing data is the right source for it.
 *
 * All 265 driver lines fetch in a single ~120 KB request, so the whole table is
 * loaded once and cached for the session rather than queried per experiment.
 */

const API_BASE = 'https://api.brain-map.org'

export interface TransgenicLine {
  readonly id: number
  readonly name: string
  /** Allen's own summary of where Cre expression is enriched. */
  readonly description: string | null
  /** Stock number at the distributing repository, when the line is available. */
  readonly stockNumber: string | null
  /** Which repository distributes it — JAX, MMRRC, and others all appear. */
  readonly sourceName: string | null
  /** Link to the originating repository's page for the line. */
  readonly url: string | null
  readonly originatingLab: string | null
}

interface RawLine {
  id: number
  name?: string
  description?: string | null
  stock_number?: string | null
  transgenic_line_source_name?: string | null
  url_prefix?: string | null
  url_suffix?: string | null
  originating_lab?: string | null
}

export type LineIndex = ReadonlyMap<string, TransgenicLine>

let cached: Promise<LineIndex> | null = null

/**
 * Load the driver-line table, once per session.
 *
 * Failure is not fatal: without it the list still shows line names, just
 * without the plain-language descriptions. So this resolves to an empty index
 * rather than throwing, and the caller degrades quietly.
 */
export function clearTransgenicLineCache(): void {
  cached = null
}

export function loadTransgenicLines(): Promise<LineIndex> {
  cached ??= fetchLines().catch(() => {
    // Allow a later retry rather than caching the failure for the session.
    cached = null
    return new Map<string, TransgenicLine>()
  })
  return cached
}

async function fetchLines(): Promise<LineIndex> {
  const criteria =
    `model::TransgenicLine,` +
    `rma::criteria,[transgenic_line_type_code$eq'D'],` +
    `rma::options[num_rows$eq'all']`

  const response = await fetch(
    `${API_BASE}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`,
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const payload = (await response.json()) as { success?: boolean; msg?: unknown }
  if (!payload.success || !Array.isArray(payload.msg)) {
    throw new Error('Transgenic line query failed')
  }

  const index = new Map<string, TransgenicLine>()
  for (const raw of payload.msg as RawLine[]) {
    if (!raw?.name) continue
    index.set(raw.name, {
      id: raw.id,
      name: raw.name,
      description: raw.description?.trim() || null,
      stockNumber: raw.stock_number?.trim() || null,
      sourceName: raw.transgenic_line_source_name?.trim() || null,
      url:
        raw.url_prefix && raw.stock_number
          ? `${raw.url_prefix}${raw.stock_number}${raw.url_suffix ?? ''}`
          : null,
      originatingLab: raw.originating_lab?.trim() || null,
    })
  }
  return index
}

/** Gene identity, for lines with no curated cell class. */
export interface GeneIdentity {
  readonly symbol: string
  readonly name: string
  /** Familiar alias — Kv3.2 for Kcnc2, Vglut1 for Slc17a7. */
  readonly alias: string | null
}

const geneCache = new Map<string, Promise<GeneIdentity | null>>()

/**
 * Look up a mouse gene by symbol.
 *
 * Fetched lazily per expanded row rather than in bulk: the gene table is large,
 * and only the handful of drivers a user actually inspects are needed. Results
 * are cached, and a failure resolves to null so the row degrades instead of
 * erroring.
 */
export function loadGene(symbol: string): Promise<GeneIdentity | null> {
  const existing = geneCache.get(symbol)
  if (existing) return existing

  const request = fetchGene(symbol).catch(() => null)
  geneCache.set(symbol, request)
  return request
}

async function fetchGene(symbol: string): Promise<GeneIdentity | null> {
  const criteria =
    `model::Gene,rma::criteria,[acronym$eq'${symbol}'][organism_id$eq2]`
  const response = await fetch(
    `${API_BASE}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`,
  )
  if (!response.ok) return null

  const payload = (await response.json()) as { success?: boolean; msg?: unknown }
  if (!payload.success || !Array.isArray(payload.msg) || payload.msg.length === 0) {
    return null
  }

  const row = payload.msg[0] as { acronym?: string; name?: string; alias_tags?: string }

  // Aliases arrive space-separated and mix clone ids with the familiar protein
  // name: Kcnc2 lists "AW047325 B230117I07 KShIIIA Kv3.2". The wanted one is
  // Kv3.2, so accessions and clone ids are dropped and the remainder is ranked
  // — a name that reads as Xx-style (Kv3.2, Vglut1, Parv) beats an all-caps
  // designation like KShIIIA, which is technically an alias but not what
  // anyone calls it.
  const candidates = (row.alias_tags ?? '')
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 1 && tag.length <= 10)
    .filter((tag) => !/^(AI|AW|BC|BB|MGC|RIKEN)\d/i.test(tag))
    .filter((tag) => !/^[A-Z]\d{6,}/.test(tag))
    .filter((tag) => !/^[A-Z0-9]{9,}$/.test(tag))

  const alias =
    candidates.find((tag) => /^[A-Z][a-z]/.test(tag)) ?? candidates[0] ?? null

  return {
    symbol: row.acronym ?? symbol,
    name: row.name ?? symbol,
    alias,
  }
}

/**
 * A short phrase naming the labelled population, for a dense list row.
 *
 * Allen's descriptions are full sentences about where expression is enriched.
 * The first clause carries the useful part, so it is trimmed to that — the full
 * text stays available on the expanded row rather than being discarded.
 */
export function shortPopulation(line: TransgenicLine | undefined): string | null {
  if (!line?.description) return null

  const text = line.description
    .replace(/^Cre expression is\s+/i, '')
    .replace(/^Cre is\s+/i, '')
    .replace(/^Expression is\s+/i, '')

  const firstSentence = text.split(/\.\s/)[0] ?? text
  const trimmed = firstSentence.replace(/\.$/, '').trim()
  if (trimmed.length === 0) return null

  return trimmed.length > 90 ? `${trimmed.slice(0, 88).trimEnd()}…` : trimmed
}

/**
 * How an experiment's driver should be labelled.
 *
 * Wild-type is stated explicitly rather than left blank: an empty field reads
 * as missing data, when it actually means every cell type at the site was
 * labelled — which is a meaningful difference for interpreting a projection.
 */
export function describeDriver(
  transgenicLine: string,
  lines: LineIndex,
): { label: string; population: string | null; line: TransgenicLine | null } {
  if (!transgenicLine) {
    return {
      label: 'wild-type',
      population: 'All cell types at the injection site',
      line: null,
    }
  }

  const line = lines.get(transgenicLine) ?? null
  return {
    label: transgenicLine,
    population: shortPopulation(line ?? undefined),
    line,
  }
}
