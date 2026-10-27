/**
 * Build the structure-to-structure convergence matrix.
 *
 * The BACKTRACE tab answers "what projects to *this point*", which changes
 * every time the target moves. The hub map asks a different question that does
 * not: *across the whole brain, which regions are convergence points?* That is
 * a property of the connectome, not of anybody's plan, so it is computed once
 * here and bundled — 293 queries at build time instead of 293 queries the user
 * waits through.
 *
 * For every summary structure the script asks the Allen API which experiments
 * deposit projection signal in it, attributes each experiment to the structure
 * it was injected into, and keeps one number per source: that source's best
 * experiment. One number per source, not per experiment, because otherwise a
 * region Allen happened to inject nine times would outrank one injected twice,
 * and the map would show the Allen Institute's sampling effort rather than
 * anatomy.
 *
 * The corpus is the explicit product list in `corpus.mjs`, shared with the
 * voxel map so the two grains of the same map describe the same animals.
 *
 * ## Ipsilateral and contralateral are kept apart
 *
 * Allen reports each structure's incoming density per hemisphere (1 left,
 * 2 right, 3 both). An earlier version asked for 3 — one pooled number per
 * structure — which painted every region identically on both sides and made
 * the map symmetric by construction rather than by anatomy. It is not a small
 * difference: a single CA3 experiment deposits 0.089 in one CA1 and 0.216 in
 * the other.
 *
 * So both hemispheres are fetched, and each experiment's own injection side
 * decides which is ipsilateral. Allen injects the right hemisphere in the large
 * majority of cases, so without that step "left" would mostly mean
 * "contralateral" and occasionally not — the script prints the exact share it
 * measured, and writes it into the asset.
 *
 * Self-projection is excluded, and so is anything on the same root-to-leaf
 * path. An injection into CA3 "projecting into" CA3 is the injection site at
 * saturation, and left in it dominates every structure's own average.
 *
 *   node scripts/fetch-connectivity-matrix.mjs
 *
 * Writes public/connectivity/convergence.json. Re-run only when the Allen
 * release changes; the output is committed like the atlas meshes are.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CORPUS_CRITERIA,
  CORPUS_NOTE,
  PRODUCTS,
  fetchInjectionHemispheres,
  summaryAncestor,
} from './corpus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'public', 'connectivity')
const OUT_FILE = join(OUT_DIR, 'convergence.json')
const STRUCTURES_FILE = join(ROOT, 'public', 'atlas', 'structures.json')

const API = 'https://api.brain-map.org/api/v2/data/query.json?criteria='

/**
 * Densities below this are dropped at fetch time.
 *
 * Not a judgement about what counts as a connection — the UI applies its own
 * threshold over what is stored. This only keeps the payload from carrying
 * every experiment's noise floor for every structure, which is most of it:
 * CA1's incoming rows fall from ~2300 to ~1000 at this cut.
 */
const FETCH_FLOOR = 0.002

/** Densities are stored to this many decimals; beyond it is noise anyway. */
const PRECISION = 5

/** Allen's 293-region summary set — the level connectivity is reported at. */
const SUMMARY_SET = 'Mouse Connectivity - Summary'

/** Be a good citizen: the service is shared and intermittently flaky. */
const PAUSE_MS = 120
const RETRIES = 4

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function query(criteria, { retries = RETRIES } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(API + encodeURIComponent(criteria))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload.success) throw new Error(String(payload.msg).slice(0, 160))
      return Array.isArray(payload.msg) ? payload.msg : []
    } catch (error) {
      lastError = error
      // The same intermittent "Informatics service request failed" the app
      // retries at runtime; here there is no user waiting, so back off harder.
      await sleep(500 * (attempt + 1) ** 2)
    }
  }
  throw lastError
}

/**
 * Every experiment in the corpus, mapped to its source structure and side.
 *
 * Three queries: the corpus listing, and the two that say which hemisphere
 * each needle went into. The previous version spent 293 — one
 * `service::mouse_connectivity_injection_structure` call per summary structure
 * — which was a quarter of an hour and, worse, left the corpus defined by
 * whatever that undocumented service happened to return. It returns products
 * 5, 35, 36, 44 and 45 but not 6 or 42, so the matrix and the voxel map were
 * built from overlapping but different sets of animals while both captions
 * said "the Allen connectome".
 *
 * Experiments whose primary injection structure is missing, or falls outside
 * the summary set entirely, are dropped: there is no source to attribute them
 * to, and guessing one would put another region's experiments on a hub.
 */
async function fetchCorpus(summaryIds, pathById) {
  process.stdout.write('Listing the corpus… ')
  const rows = await query(CORPUS_CRITERIA)
  console.log(`${rows.length} experiments across products ${PRODUCTS.join(', ')}`)

  process.stdout.write('Reading injection hemispheres… ')
  const hemispheres = await fetchInjectionHemispheres(query)
  console.log(`${hemispheres.size} with injection signal`)

  const source = new Map()
  let unsourced = 0
  let unsided = 0

  for (const row of rows) {
    if (typeof row?.id !== 'number') continue

    const primary = row.specimen?.stereotaxic_injections?.[0]?.primary_injection_structure
    const structure =
      typeof primary?.id === 'number'
        ? summaryAncestor(pathById, summaryIds, primary.id)
        : null
    if (structure === null) {
      unsourced += 1
      continue
    }

    // No injection unionize row means no grid data at all for that experiment,
    // so it cannot contribute a projection row either.
    const hemisphere = hemispheres.get(row.id)
    if (hemisphere === undefined) {
      unsided += 1
      continue
    }

    source.set(row.id, { structure, hemisphere })
  }

  console.log(
    `  ${unsourced} dropped without a summary-set source, ` +
      `${unsided} without injection data`,
  )
  return source
}

async function main() {
  const structures = JSON.parse(readFileSync(STRUCTURES_FILE, 'utf8'))
  const pathById = new Map(structures.map((s) => [s.id, s.path ?? [s.id]]))

  /** Whether two structures are the same region or one contains the other. */
  const sameLineage = (a, b) => {
    if (a === b) return true
    const pa = pathById.get(a) ?? [a]
    const pb = pathById.get(b) ?? [b]
    return pa.includes(b) || pb.includes(a)
  }

  process.stdout.write(`Fetching the ${SUMMARY_SET} structure set… `)
  const summary = await query(
    `model::Structure,rma::criteria,[graph_id$eq1],` +
      `structure_sets[name$eq'${SUMMARY_SET}'],rma::options[num_rows$eq'all']`,
  )
  console.log(`${summary.length} structures`)

  const summaryIds = new Set(summary.map((s) => s.id))
  const sourceOfExperiment = await fetchCorpus(summaryIds, pathById)
  const right = [...sourceOfExperiment.values()].filter((e) => e.hemisphere === 2).length
  console.log(
    `  ${sourceOfExperiment.size} experiments from ` +
      `${new Set([...sourceOfExperiment.values()].map((e) => e.structure)).size} ` +
      `source structures; ${right} injected on the right ` +
      `(${((100 * right) / sourceOfExperiment.size).toFixed(0)}%)`,
  )

  console.log('Fetching incoming projections…')
  const convergence = {}
  let done = 0
  let unattributed = 0

  for (const structure of summary) {
    // Slim: the density and the experiment, joined locally. Asking the API to
    // join through to the injection structure instead turned a one-second
    // query into half a minute, which over 293 structures is the difference
    // between a coffee and an afternoon.
    const perHemisphere = await Promise.all(
      [1, 2].map((hemisphere) =>
        query(
          `model::ProjectionStructureUnionize,rma::criteria,` +
            `[is_injection$eqfalse][structure_id$eq${structure.id}]` +
            `[hemisphere_id$eq${hemisphere}][projection_density$gt${FETCH_FLOOR}],` +
            `rma::options[num_rows$eq'all']` +
            `[only$eq'projection_density,section_data_set_id']`,
        ),
      ),
    )

    // One pair per source: its strongest experiment into this target, kept as
    // the ipsilateral and contralateral halves of that same experiment rather
    // than as two independent maxima — otherwise a structure's ipsi and contra
    // numbers could come from different animals and their ratio would mean
    // nothing.
    const bySource = new Map()
    for (let h = 0; h < 2; h++) {
      const hemisphere = h + 1
      for (const row of perHemisphere[h]) {
        const experiment = sourceOfExperiment.get(row.section_data_set_id)
        if (experiment === undefined) {
          unattributed += 1
          continue
        }
        if (sameLineage(experiment.structure, structure.id)) continue
        const density = row.projection_density
        if (typeof density !== 'number' || !Number.isFinite(density)) continue

        const side = hemisphere === experiment.hemisphere ? 'ipsi' : 'contra'
        const current = bySource.get(experiment.structure) ?? { ipsi: 0, contra: 0, rank: 0 }
        if (density > current[side]) current[side] = density
        current.rank = Math.max(current.rank, current.ipsi)
        bySource.set(experiment.structure, current)
      }
    }

    convergence[structure.id] = {
      acronym: structure.acronym,
      sources: [...bySource.entries()]
        .sort((a, b) => b[1].ipsi - a[1].ipsi)
        .map(([id, v]) => [
          id,
          Number(v.ipsi.toFixed(PRECISION)),
          Number(v.contra.toFixed(PRECISION)),
        ]),
    }

    done += 1
    process.stdout.write(
      `\r  [${done}/${summary.length}] ${structure.acronym.padEnd(10)} ` +
        `${bySource.size} sources   `,
    )
    await sleep(PAUSE_MS)
  }

  console.log()

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    OUT_FILE,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source:
        'Allen Mouse Brain Connectivity Atlas, ProjectionStructureUnionize ' +
        '(is_injection=false, hemisphere=both). Oh et al. (2014), Nature 508:207-214.',
      structureSet: SUMMARY_SET,
      fetchFloor: FETCH_FLOOR,
      products: PRODUCTS,
      experiments: sourceOfExperiment.size,
      corpus: CORPUS_NOTE,
      layout: '[sourceStructureId, ipsilateralDensity, contralateralDensity]',
      hemisphere:
        "Ipsilateral and contralateral are relative to each experiment's own injection, " +
        `which Allen places in the right hemisphere for ${right} of ` +
        `${sourceOfExperiment.size} experiments here ` +
        `(${((100 * right) / sourceOfExperiment.size).toFixed(0)}%).`,
      note:
        'Per target structure, the strongest projection density reaching it from each ' +
        'other structure, split by side. One value per source, not per experiment, so ' +
        'the map shows anatomy rather than how often Allen injected a region. ' +
        'Self-projection and same-lineage pairs are excluded.',
      convergence,
    }),
  )

  console.log(`  ${unattributed} rows skipped: outside the corpus above`)

  const counts = Object.values(convergence).map((c) => c.sources.length)
  console.log(
    `Wrote ${OUT_FILE}\n` +
      `  ${counts.length} structures, ` +
      `${counts.reduce((a, b) => a + b, 0)} source-target pairs, ` +
      `median ${counts.sort((a, b) => a - b)[counts.length >> 1]} sources each`,
  )
}

main().catch((error) => {
  console.error('\nFailed:', error)
  process.exitCode = 1
})
