#!/usr/bin/env node
/**
 * Fetch MouseLight single-neuron reconstructions into `public/mouselight/`.
 *
 * This exists because of a specific limitation rather than by preference.
 * MouseLight's search endpoint sends `Access-Control-Allow-Origin: *` and can be
 * called straight from the browser, but the endpoint that actually serves node
 * coordinates — `/tracings/graphql` — sends no CORS headers at all. The browser
 * blocks it, in dev and on a static deploy alike, so BrainCAD cannot fetch
 * arbors at runtime no matter where it is hosted.
 *
 * (NeuroMorpho mirrors 1,112 of these neurons and is CORS-open, but its CNG
 * conversion re-centres and rotates each cell — the same neuron's extents come
 * back as 5029x3141x4193 um against MouseLight's 3076x3672x5531 — so the atlas
 * registration is gone, which is the one thing BrainCAD needs.)
 *
 * So the data is fetched at build time and served same-origin, exactly as the
 * atlas meshes are. Geometry is written one file per neuron and fetched lazily,
 * so the page cost is a single neuron, not the whole set.
 *
 * Usage:
 *   node scripts/fetch-mouselight.mjs                 # the curated default set
 *   node scripts/fetch-mouselight.mjs VISp CP SNr     # by structure acronym
 *   node scripts/fetch-mouselight.mjs --all           # every neuron (~110 MB)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GRAPHQL = 'https://ml-neuronbrowser.janelia.org/graphql'
const TRACINGS = 'https://ml-neuronbrowser.janelia.org/tracings/graphql'
const CCF_VERSION = 'CCFV30'

const OUT_DIR = join(process.cwd(), 'public', 'mouselight')
const ATLAS_STRUCTURES = join(process.cwd(), 'public', 'atlas', 'structures.json')

/**
 * Default coverage: regions a stereotaxic plan actually tends to target.
 *
 * Deliberately a short list. Every neuron is ~33 KB in the repo, and a set
 * nobody uses is weight on every clone; extend it by naming structures on the
 * command line rather than by fetching everything speculatively.
 */
const DEFAULT_STRUCTURES = [
  'VISp', // primary visual
  'SSp', // primary somatosensory
  'MOp', // primary motor
  'CP', // caudoputamen
  'CA1',
  'DG',
  'LGd', // dorsal lateral geniculate
  'SNr', // substantia nigra pars reticulata
]

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.errors?.length) throw new Error(payload.errors[0].message)
  return payload
}

/** Allen structure id → MouseLight area uuid, joined on `structureIdPath`. */
async function brainAreaIndex() {
  const payload = await postJson(GRAPHQL, {
    query: '{ brainAreas { id acronym structureIdPath } }',
  })
  const byAllenId = new Map()
  const byAcronym = new Map()
  for (const area of payload.data.brainAreas) {
    const segments = (area.structureIdPath ?? '').split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (last !== undefined) byAllenId.set(Number.parseInt(last, 10), area)
    byAcronym.set(area.acronym, area)
  }
  return { byAllenId, byAcronym }
}

async function somaStructureId() {
  const payload = await postJson(GRAPHQL, {
    query: '{ structureIdentifiers { id name value } }',
  })
  return payload.data.structureIdentifiers.find((s) => s.value === 1).id
}

const SEARCH = `query($c: SearchContext){
  searchNeurons(context: $c){
    neurons {
      idString
      brainArea { acronym name structureIdPath }
      tracings { id nodeCount tracingStructure { name } }
    }
  }
}`

async function searchNeurons(areaIds, somaId) {
  const payload = await postJson(GRAPHQL, {
    query: SEARCH,
    variables: {
      c: {
        scope: 6,
        ccfVersion: CCF_VERSION,
        nonce: `fetch-${areaIds.join('-') || 'all'}`,
        predicates: [
          {
            predicateType: 'ANATOMICAL',
            tracingIdsOrDOIs: [],
            tracingIdsOrDOIsExactMatch: false,
            tracingStructureIds: [],
            nodeStructureIds: areaIds.length ? [somaId] : [],
            operatorId: null,
            amount: 0,
            brainAreaIds: areaIds,
            arbCenter: { x: 0, y: 0, z: 0 },
            arbSize: 0,
            invert: false,
            composition: 0,
          },
        ],
      },
    },
  })
  return payload.data.searchNeurons.neurons
}

/**
 * Pack one neuron's arbors.
 *
 * Layout: 'MLN1', uint32 axon segment count, uint32 dendrite segment count,
 * then int16 segment endpoints — six per segment, ordered (AP, DV, ML) to match
 * every other volume-derived position in BrainCAD, reordered here from
 * MouseLight's (ML, DV, AP).
 *
 * int16 because CCF spans 0-13200 um and holds 1 um precision inside a signed
 * 16-bit range, which halves the file against float32 while staying far finer
 * than the 25 um atlas it is drawn over.
 */
function packNeuron(tracings, structureByTracingId) {
  const perStructure = { axon: [], dendrite: [] }
  let soma = null

  for (const tracing of tracings) {
    const structure = structureByTracingId.get(tracing.id) ?? 'axon'
    const bySample = new Map(tracing.nodes.map((n) => [n.sampleNumber, n]))
    for (const node of tracing.nodes) {
      if (node.parentNumber === -1) soma ??= [node.z, node.y, node.x]
      const parent = bySample.get(node.parentNumber)
      if (!parent) continue
      perStructure[structure].push(
        parent.z, parent.y, parent.x,
        node.z, node.y, node.x,
      )
    }
  }

  const axon = perStructure.axon
  const dendrite = perStructure.dendrite
  const header = 12
  const buffer = Buffer.alloc(header + (axon.length + dendrite.length) * 2)
  buffer.write('MLN1', 0, 'ascii')
  buffer.writeUInt32LE(axon.length / 6, 4)
  buffer.writeUInt32LE(dendrite.length / 6, 8)

  let at = header
  for (const value of [...axon, ...dendrite]) {
    // Clamp rather than wrap: a coordinate outside the atlas is bad data, and
    // wrapping would place it on the far side of the brain instead.
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), at)
    at += 2
  }

  return { buffer, axonSegments: axon.length / 6, dendriteSegments: dendrite.length / 6, soma }
}

async function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const acronyms = args.filter((a) => !a.startsWith('--'))
  const wanted = all ? [] : acronyms.length ? acronyms : DEFAULT_STRUCTURES

  console.log(
    all
      ? 'Fetching every MouseLight neuron (~110 MB) …'
      : `Fetching MouseLight neurons with soma in: ${wanted.join(', ')}`,
  )

  const areas = await brainAreaIndex()
  const somaId = await somaStructureId()

  const areaIds = []
  for (const acronym of wanted) {
    const area = areas.byAcronym.get(acronym)
    if (!area) {
      console.warn(`  ! MouseLight has no area "${acronym}" — skipped`)
      continue
    }
    areaIds.push(area.id)
  }

  const neurons = await searchNeurons(areaIds, somaId)
  console.log(`  ${neurons.length} neurons`)

  mkdirSync(OUT_DIR, { recursive: true })

  // Allen structure ids so the app can search the bundle with the same ontology
  // it already has loaded, rather than a second naming scheme.
  let allenByAcronym = new Map()
  try {
    const structures = JSON.parse(readFileSync(ATLAS_STRUCTURES, 'utf8'))
    allenByAcronym = new Map(structures.map((s) => [s.acronym, s]))
  } catch {
    console.warn('  ! public/atlas/structures.json not found; soma ids will be null')
  }

  const index = []
  let bytes = 0

  for (const [i, neuron] of neurons.entries()) {
    const ids = neuron.tracings.map((t) => t.id)
    const structureByTracingId = new Map(
      neuron.tracings.map((t) => [
        t.id,
        t.tracingStructure.name.includes('axon') ? 'axon' : 'dendrite',
      ]),
    )

    const payload = await postJson(TRACINGS, { ids, ccfVersion: CCF_VERSION })
    const packed = packNeuron(payload.tracings ?? [], structureByTracingId)

    writeFileSync(join(OUT_DIR, `${neuron.idString}.bin`), packed.buffer)
    bytes += packed.buffer.length

    const acronym = neuron.brainArea?.acronym ?? null
    const structure = acronym ? allenByAcronym.get(acronym) : null
    index.push({
      id: neuron.idString,
      somaAcronym: acronym,
      somaName: neuron.brainArea?.name ?? null,
      somaStructureId: structure?.id ?? null,
      // The full ancestor path, so a search for a parent structure finds
      // neurons filed under its layers without another round trip. Stored with
      // leading and trailing slashes so a substring match on "/385/" cannot
      // also hit "/1385/". `structures.json` spells this as an id array.
      somaStructureIdPath: structure?.path ? `/${structure.path.join('/')}/` : null,
      soma: packed.soma ? packed.soma.map((v) => Math.round(v)) : null,
      axonSegments: packed.axonSegments,
      dendriteSegments: packed.dendriteSegments,
    })

    if ((i + 1) % 10 === 0 || i === neurons.length - 1) {
      console.log(`  ${i + 1}/${neurons.length}  ${(bytes / 1e6).toFixed(1)} MB`)
    }
  }

  writeFileSync(
    join(OUT_DIR, 'index.json'),
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        ccfVersion: CCF_VERSION,
        source: 'Janelia MouseLight — Winnubst et al. (2019), Cell 179(1):268-281.',
        coordinateOrder: 'AP,DV,ML micrometres in Allen CCFv3',
        neurons: index,
      },
      null,
      1,
    ) + '\n',
  )

  console.log(`Wrote ${index.length} neurons, ${(bytes / 1e6).toFixed(1)} MB → public/mouselight/`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
