/**
 * Accumulate a voxel-level convergence map from the Allen projection grids.
 *
 * The structure-level matrix (`fetch-connectivity-matrix.mjs`) answers "which
 * regions are convergence points" at the grain the Allen unionize tables are
 * published at: one number per structure. That grain is also its ceiling. A
 * dense input zone in one corner of a region, a cluster straddling an
 * annotation boundary, a gradient across a nucleus — none of it can appear,
 * because the number was averaged over the whole structure before BrainCAD
 * ever saw it.
 *
 * This script goes underneath that. Every experiment's `projection_density`
 * volume is published per voxel at 100 µm, so accumulating them directly gives
 * a convergence map that owes nothing to the parcellation and can therefore
 * disagree with it.
 *
 * ## Worth stating plainly: the pixels get *bigger*
 *
 * The sections are drawn on the 50 µm annotation grid today. The projection
 * grids are 100 µm, so a voxel map renders at half that linear resolution. It
 * is coarser to look at and finer in the only sense that matters here: each
 * pixel is a measurement at that place rather than an average over the whole
 * region containing it.
 *
 * ## Every injection is put on the right
 *
 * Allen injects one hemisphere, overwhelmingly the right. Accumulated raw, the
 * map comes out brighter on whichever side each needle went in, which is a
 * fact about the method rather than about the brain. So each experiment whose
 * injection centroid falls left of the midline is mirrored before it is added.
 *
 * The result is that **right is ipsilateral to the injection and left is
 * contralateral**, for every experiment, which is the comparison worth making
 * and is not available from the raw volumes at all.
 *
 * Right rather than left, and the reason is a collision the first version
 * created. The maps read "left is ipsilateral" while the panel's own ipsi
 * button sent the target to the *right* — because Allen injects there, so that
 * is where a target is reached from its own side. Both statements were true
 * and they put opposite words on the same pixel. Normalising onto the right
 * makes the aggregate agree with the raw anatomy and with the button.
 *
 * The hemisphere is read from the experiment's own `injection_fraction`
 * centroid rather than from the reported injection coordinate: it is the same
 * volume already being downloaded for the mask, it needs no extra query, and
 * it is the actual tracer rather than a summary of it.
 *
 * ## What is excluded, and why
 *
 * Injection voxels. `projection_density` includes the injection site, where it
 * saturates near 1.0 against a projection's typical 0.01 — so without masking,
 * the map's brightest features would be the ~2300 places tracer was put, which
 * is the one thing it is not trying to show. Each experiment's own
 * `injection_fraction` volume, 7 KB, is downloaded alongside for the mask.
 *
 *   node scripts/fetch-voxel-convergence.mjs --sample 300
 *   node scripts/fetch-voxel-convergence.mjs            # all experiments
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT_DIR = join(ROOT, 'public', 'connectivity')

const API = 'https://api.brain-map.org'

/** Density at or above this counts as "this experiment reaches this voxel". */
const DENSITY_THRESHOLD = 0.01

/** Any injection signal at all disqualifies the voxel for that experiment. */
const INJECTION_FLOOR = 0.001

/** How many downloads are in flight at once. Polite, and already fast. */
const CONCURRENCY = 6

const args = process.argv.slice(2)
const sampleArg = args.indexOf('--sample')
const SAMPLE = sampleArg >= 0 ? Number(args[sampleArg + 1]) : 0
const outArg = args.indexOf('--out')
const OUT_FILE = outArg >= 0 ? args[outArg + 1] : join(OUT_DIR, 'voxel-convergence.json')

/**
 * Minimal NRRD reader for the Allen grid files.
 *
 * They are a fixed shape — ASCII header, blank line, gzipped little-endian
 * raw — so this does not try to be a general parser. The app's own
 * `src/atlas/nrrd.ts` is the complete one; duplicating a dozen lines here
 * avoids making the build step depend on a TypeScript loader.
 */
function readNrrd(buffer) {
  const bytes = new Uint8Array(buffer)

  // The header ends at the first blank line.
  let end = -1
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      end = i + 2
      break
    }
  }
  if (end < 0) throw new Error('No NRRD header terminator')

  const header = Object.create(null)
  for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split('\n')) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line.trim())
    if (match) header[match[1].trim().toLowerCase()] = match[2].trim()
  }

  const sizes = (header.sizes ?? '').split(/\s+/).map(Number)
  const encoding = (header.encoding ?? 'raw').toLowerCase()
  const payload = bytes.subarray(end)
  const raw = encoding === 'gzip' || encoding === 'gz' ? gunzipSync(payload) : payload

  const type = (header.type ?? 'float').toLowerCase()
  if (!/^(float|float32)$/.test(type)) {
    throw new Error(`Unexpected grid type ${type}`)
  }

  const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  return { sizes, data }
}

async function fetchGrid(experimentId, image) {
  const url = `${API}/grid_data/download_file/${experimentId}?image=${image}&resolution=100`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${image} ${experimentId}`)
  return readNrrd(await response.arrayBuffer())
}

/**
 * Whether an experiment's injection sits in the right hemisphere.
 *
 * Axis 2 of the grid is ML and starts at the animal's left, so the midline is
 * its centre. The centroid is weighted by injection fraction, which is what
 * makes a needle that clipped the midline fall on the side most of the tracer
 * actually went.
 */
function injectionIsRight(injection, [n0, n1, n2]) {
  let weight = 0
  let moment = 0

  for (let k = 0; k < n2; k++) {
    let plane = 0
    const base = n0 * n1 * k
    for (let v = base; v < base + n0 * n1; v++) {
      const f = injection[v]
      if (f > 0) plane += f
    }
    weight += plane
    moment += plane * k
  }

  // No detected injection: nothing to mirror, and nothing is lost by leaving
  // it where it is — such an experiment contributes almost no signal anyway.
  if (weight <= 0) return false
  return moment / weight > (n2 - 1) / 2
}

async function query(criteria) {
  const url = `${API}/api/v2/data/query.json?criteria=${encodeURIComponent(criteria)}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  if (!payload.success) throw new Error(String(payload.msg).slice(0, 160))
  return Array.isArray(payload.msg) ? payload.msg : []
}

/**
 * Sample experiments evenly across source structures.
 *
 * Taking the first N ids would sample Allen's own ordering, which is roughly
 * chronological and therefore grouped by whichever region a cohort targeted.
 * A trial run drawn that way would answer "are there hot spots in the regions
 * Allen happened to inject first", which is not the question.
 */
function stratify(experiments, limit) {
  if (!limit || limit >= experiments.length) return experiments

  const bySource = new Map()
  for (const e of experiments) {
    const bucket = bySource.get(e.source)
    if (bucket) bucket.push(e)
    else bySource.set(e.source, [e])
  }

  const out = []
  const buckets = [...bySource.values()]
  for (let round = 0; out.length < limit; round++) {
    let placed = false
    for (const bucket of buckets) {
      if (round >= bucket.length) continue
      out.push(bucket[round])
      placed = true
      if (out.length >= limit) break
    }
    if (!placed) break
  }
  return out
}

async function main() {
  process.stdout.write('Listing experiments… ')
  const rows = await query(
    'model::SectionDataSet,rma::criteria,[failed$eqfalse],products[id$eq5],' +
      'rma::include,specimen(stereotaxic_injections(primary_injection_structure)),' +
      "rma::options[num_rows$eq'all']",
  )

  const all = []
  for (const row of rows) {
    const injections = row?.specimen?.stereotaxic_injections
    const primary = injections?.[0]?.primary_injection_structure
    if (typeof row.id === 'number' && typeof primary?.id === 'number') {
      all.push({ id: row.id, source: primary.id, acronym: primary.acronym })
    }
  }
  console.log(`${all.length} usable`)

  const chosen = stratify(all, SAMPLE)
  console.log(
    `Accumulating ${chosen.length} experiments ` +
      `from ${new Set(chosen.map((e) => e.source)).size} source structures`,
  )

  let count = null
  let sum = null
  let voxels = 0
  let sizes = null
  let done = 0
  let failed = 0
  let mirrored = 0

  const queue = [...chosen]
  async function worker() {
    for (;;) {
      const experiment = queue.shift()
      if (!experiment) return

      try {
        const [projection, injection] = await Promise.all([
          fetchGrid(experiment.id, 'projection_density'),
          fetchGrid(experiment.id, 'injection_fraction'),
        ])

        if (!count) {
          sizes = projection.sizes
          voxels = projection.data.length
          count = new Uint16Array(voxels)
          sum = new Float32Array(voxels)
        }
        if (projection.data.length !== voxels) {
          throw new Error(`Grid size mismatch for ${experiment.id}`)
        }

        const [n0, n1, n2] = sizes
        const mirror = !injectionIsRight(injection.data, sizes)
        if (mirror) mirrored += 1

        // Read mirrored, write straight: equivalent to flipping the input, and
        // the mirrored row offset is computed once per row rather than from a
        // divide per voxel — this inner loop runs 2.8 billion times.
        for (let k = 0; k < n2; k++) {
          const ks = mirror ? n2 - 1 - k : k
          for (let j = 0; j < n1; j++) {
            const dst = n0 * (j + n1 * k)
            const src = n0 * (j + n1 * ks)
            for (let i = 0; i < n0; i++) {
              const density = projection.data[src + i]
              // Allen marks voxels outside the imaged volume with -1.
              if (!(density >= DENSITY_THRESHOLD)) continue
              if (injection.data[src + i] > INJECTION_FLOOR) continue
              count[dst + i] += 1
              sum[dst + i] += density
            }
          }
        }
      } catch (error) {
        failed += 1
        if (failed < 5) console.warn(`\n  skipped ${experiment.id}: ${error.message}`)
      }

      done += 1
      if (done % 10 === 0 || done === chosen.length) {
        process.stdout.write(
          `\r  [${done}/${chosen.length}] ${mirrored} mirrored, ${failed} skipped   `,
        )
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  console.log()

  if (!count) throw new Error('No grids were read')

  // Mean over the experiments that actually reached each voxel, matching the
  // structure-level map's rule: dividing by every experiment instead would
  // turn the mean back into a count wearing a different name.
  const mean = new Float32Array(voxels)
  let reached = 0
  let maxCount = 0
  for (let i = 0; i < voxels; i++) {
    if (count[i] === 0) continue
    mean[i] = sum[i] / count[i]
    reached += 1
    if (count[i] > maxCount) maxCount = count[i]
  }

  // Two uint16 planes in one blob, with a small JSON header beside it. Base64
  // in JSON was what the trial wrote and would be 9.6 MB here: a third larger
  // than the bytes it carries, and it has to be decoded in the browser before
  // anything can be drawn. A typed array read straight out of an ArrayBuffer
  // costs nothing.
  //
  // The mean is a projection density, so it lives in 0..1 and is stored scaled
  // to the full uint16 range — a resolution of 1.5e-5, far finer than the
  // measurement, and half the bytes of a float.
  const meanScaled = new Uint16Array(voxels)
  for (let i = 0; i < voxels; i++) {
    meanScaled[i] = Math.round(Math.min(1, mean[i]) * 65535)
  }

  const blob = Buffer.concat([
    Buffer.from(count.buffer, count.byteOffset, count.byteLength),
    Buffer.from(meanScaled.buffer, meanScaled.byteOffset, meanScaled.byteLength),
  ])

  const binFile = OUT_FILE.replace(/\.json$/, '.bin')
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(binFile, blob)
  writeFileSync(
    OUT_FILE,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      experiments: chosen.length - failed,
      sampled: SAMPLE || null,
      sizes,
      resolutionUm: 100,
      densityThreshold: DENSITY_THRESHOLD,
      injectionFloor: INJECTION_FLOOR,
      maxCount,
      mirroredExperiments: mirrored,
      hemisphere:
        'Every experiment is mirrored so its injection lies in the right hemisphere. ' +
        'Right is therefore ipsilateral to the injection and left is contralateral.',
      // How to read the blob: two uint16 planes, counts then scaled means,
      // each `voxels` long, first axis fastest like every other volume here.
      data: binFile.split('/').pop(),
      layout: 'uint16 count[voxels], uint16 mean[voxels] scaled by 65535',
      voxels,
      source:
        'Allen Mouse Brain Connectivity Atlas projection_density grids at 100 um, ' +
        'injection voxels masked per experiment, injections mirrored onto the right. ' +
        'Oh et al. (2014), Nature 508:207-214.',
    }),
  )

  console.log(
    `Wrote ${OUT_FILE} + ${binFile} (${(blob.length / 1024 / 1024).toFixed(1)} MB)\n` +
      `  ${sizes.join(' x ')} at 100 um, ${reached.toLocaleString()} of ` +
      `${voxels.toLocaleString()} voxels reached, max count ${maxCount}\n` +
      `  ${mirrored} of ${chosen.length - failed} experiments mirrored onto the right`,
  )
}

main().catch((error) => {
  console.error('\nFailed:', error)
  process.exitCode = 1
})
