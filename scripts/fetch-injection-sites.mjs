/**
 * Build the list of every injection site in the corpus.
 *
 * The second brain paints which regions project into the target. That picture
 * has a blind spot it cannot show on its own: a region drawn dark may be dark
 * because nothing projects from it, or because nobody ever put a needle there.
 * Those are completely different claims and the colours look identical.
 *
 * So the sampling is drawn beside the answer. Every experiment in the corpus
 * contributes one dot at its reported injection centre, and a dark region with
 * no dots in it is a gap in the Allen dataset rather than a finding.
 *
 * ## One query, and why this one
 *
 * `service::mouse_connectivity_injection_structure` matches hierarchically, so
 * asking it for the root structure returns every experiment it knows about in
 * a single call — 2,994 rows in about four seconds — each carrying the
 * `injection-coordinates` triple that `model::SectionDataSet` does not expose.
 *
 * Filtered to the same product list the rest of BrainCAD uses, that leaves
 * 2,915 sites. The service also returns the retina cohort (product 31), which
 * is dropped here for the same reason it is dropped everywhere else. The 140
 * corpus experiments it does not return are exactly the 140 with no grid data
 * at all, so nothing usable is lost.
 *
 *   node scripts/fetch-injection-sites.mjs
 *
 * Writes public/connectivity/injections.json (~55 KB). Re-run when the corpus
 * in `corpus.mjs` changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CORPUS_NOTE, PRODUCTS, PRODUCT_FILTER } from './corpus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'public', 'connectivity')
const OUT_FILE = join(OUT_DIR, 'injections.json')

const API = 'https://api.brain-map.org/api/v2/data/query.json?criteria='

/** Whole-brain root in the Allen ontology; the service matches its descendants. */
const ROOT_STRUCTURE_ID = 997

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function query(criteria, { retries = 4 } = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(API + encodeURIComponent(criteria))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (!payload.success) throw new Error(String(payload.msg).slice(0, 160))
      // The service answers an intermittent failure with a string in `msg`
      // rather than an error status, which would otherwise be read as zero
      // rows and written out as an empty asset.
      if (!Array.isArray(payload.msg)) throw new Error(String(payload.msg).slice(0, 160))
      return payload.msg
    } catch (error) {
      lastError = error
      await sleep(500 * (attempt + 1) ** 2)
    }
  }
  throw lastError
}

async function main() {
  process.stdout.write('Listing the corpus… ')
  const corpus = new Set(
    (
      await query(
        `model::SectionDataSet,rma::criteria,[failed$eqfalse],${PRODUCT_FILTER},` +
          `rma::options[num_rows$eq'all'][only$eq'id']`,
      )
    ).map((row) => row.id),
  )
  console.log(`${corpus.size} experiments`)

  process.stdout.write('Fetching injection coordinates… ')
  const rows = await query(
    `service::mouse_connectivity_injection_structure` +
      `[injection_structures$eq${ROOT_STRUCTURE_ID}][primary_structure_only$eqfalse]`,
  )
  console.log(`${rows.length} rows`)

  // Flat triples rather than objects: it is a third of the bytes and the
  // browser reads it straight into the loop that places the dots.
  const coordinatesUm = []
  let outsideCorpus = 0
  let withoutCoordinates = 0

  for (const row of rows) {
    if (!corpus.has(row.id)) {
      outsideCorpus += 1
      continue
    }
    const centre = row['injection-coordinates']
    if (!Array.isArray(centre) || centre.length !== 3) {
      withoutCoordinates += 1
      continue
    }
    coordinatesUm.push(Math.round(centre[0]), Math.round(centre[1]), Math.round(centre[2]))
  }

  const count = coordinatesUm.length / 3
  const right = coordinatesUm.filter((_, i) => i % 3 === 2).filter((z) => z > 5700).length

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(
    OUT_FILE,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      products: PRODUCTS,
      corpus: CORPUS_NOTE,
      count,
      injectedRight: right,
      layout: 'flat [x, y, z] triples in CCF micrometres, first axis anterior-posterior',
      source:
        'Allen Mouse Brain Connectivity Atlas, injection centroids from ' +
        'service::mouse_connectivity_injection_structure. Oh et al. (2014), ' +
        'Nature 508:207-214.',
      note:
        'One dot per experiment, drawn so a region with no colour and no dots can be ' +
        'read as unsampled rather than as not projecting.',
      coordinatesUm,
    }),
  )

  console.log(
    `Wrote ${OUT_FILE}\n` +
      `  ${count} injection sites, ${right} injected on the right ` +
      `(${((100 * right) / count).toFixed(0)}%)\n` +
      `  ${outsideCorpus} rows outside the product list, ` +
      `${withoutCoordinates} without coordinates`,
  )
}

main().catch((error) => {
  console.error('\nFailed:', error)
  process.exitCode = 1
})
