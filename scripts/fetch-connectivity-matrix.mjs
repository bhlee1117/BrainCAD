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
 * Every experiment in the corpus, mapped to the structure it was injected into.
 *
 * Built by asking the same service the app's forward search uses, once per
 * summary structure, rather than by listing SectionDataSets. That is slower by
 * 293 cheap queries and it is the right trade: it makes the hub map's corpus
 * *the same corpus* the OVERLAYS tab and the back-trace already work from.
 *
 * It matters more than it sounds. The raw unionize table also carries rows
 * from the Alzheimer, aged-cohort, retina and target-defined studies — for
 * CA1, two thirds of all rows — and pooling those into "the mouse connectome"
 * would silently mix separate experiments with different animals and aims.
 */
async function fetchCorpus(structures) {
  const source = new Map()
  let done = 0

  for (const structure of structures) {
    const rows = await query(
      `service::mouse_connectivity_injection_structure` +
        `[injection_structures$eq${structure.id}][primary_structure_only$eqtrue]`,
    )
    for (const row of rows) {
      if (typeof row?.id === 'number') source.set(row.id, structure.id)
    }
    done += 1
    process.stdout.write(
      `\r  [${done}/${structures.length}] ${structure.acronym.padEnd(10)} ` +
        `${source.size} experiments   `,
    )
    await sleep(PAUSE_MS)
  }

  console.log()
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

  console.log('Mapping experiments to their injection structure…')
  const sourceOfExperiment = await fetchCorpus(summary)
  console.log(
    `  ${sourceOfExperiment.size} experiments from ` +
      `${new Set(sourceOfExperiment.values()).size} source structures`,
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
    const rows = await query(
      `model::ProjectionStructureUnionize,rma::criteria,` +
        `[is_injection$eqfalse][structure_id$eq${structure.id}]` +
        `[hemisphere_id$eq3][projection_density$gt${FETCH_FLOOR}],` +
        `rma::options[num_rows$eq'all'][only$eq'projection_density,section_data_set_id']`,
    )

    // One number per source: its strongest experiment into this target.
    const bySource = new Map()
    for (const row of rows) {
      const source = sourceOfExperiment.get(row.section_data_set_id)
      if (source === undefined) {
        unattributed += 1
        continue
      }
      if (sameLineage(source, structure.id)) continue
      const density = row.projection_density
      if (typeof density !== 'number' || !Number.isFinite(density)) continue
      if (!(bySource.get(source) >= density)) bySource.set(source, density)
    }

    convergence[structure.id] = {
      acronym: structure.acronym,
      sources: [...bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, density]) => [id, Number(density.toFixed(PRECISION))]),
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
      corpus:
        'Experiments reachable through service::mouse_connectivity_injection_structure ' +
        'with primary_structure_only — the same corpus the rest of BrainCAD works from. ' +
        'Rows from the Alzheimer, aged-cohort, retina and target-defined studies are ' +
        'left out rather than pooled into one connectome.',
      note:
        'Per target structure, the strongest projection density reaching it from each ' +
        'other structure. One value per source, not per experiment, so the map shows ' +
        'anatomy rather than how often Allen injected a region. Self-projection and ' +
        'same-lineage pairs are excluded.',
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
