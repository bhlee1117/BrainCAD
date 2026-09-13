#!/usr/bin/env node
/**
 * Build-time atlas asset pipeline.
 *
 * Downloads the Allen CCFv3 annotation volume, structure ontology and a curated
 * set of region meshes, then processes them into small, static, browser-ready
 * assets under `public/atlas/`. Run once with `npm run atlas:fetch`; the output
 * is committed so deploys need no build-time network access.
 *
 * Raw downloads are cached in `data/raw/` (gitignored) so re-runs are cheap.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MeshoptSimplifier } from 'meshoptimizer'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW_DIR = join(ROOT, 'data', 'raw')
const OUT_DIR = join(ROOT, 'public', 'atlas')
const MESH_OUT_DIR = join(OUT_DIR, 'meshes')

const ALLEN_BASE =
  'https://download.alleninstitute.org/informatics-archive/current-release/mouse_ccf'
const ANNOTATION_URL = `${ALLEN_BASE}/annotation/ccf_2017/annotation_50.nrrd`
const MESH_BASE = `${ALLEN_BASE}/annotation/ccf_2017/structure_meshes`
const ONTOLOGY_URL = 'https://api.brain-map.org/api/v2/structure_graph_download/1.json'

/**
 * Structures whose meshes ship with the app. Everything else is lazy-loaded on
 * demand, so this list is a startup-cost decision, not a capability limit.
 */
const CURATED_STRUCTURES = [
  { id: 997, name: 'root', targetTriangles: 60_000 },
  { id: 8, name: 'grey', targetTriangles: 40_000 },
  { id: 315, name: 'Isocortex', targetTriangles: 40_000 },
  { id: 698, name: 'OLF', targetTriangles: 15_000 },
  { id: 1089, name: 'HPF', targetTriangles: 25_000 },
  { id: 382, name: 'CA1', targetTriangles: 15_000 },
  { id: 463, name: 'CA3', targetTriangles: 15_000 },
  { id: 726, name: 'DG', targetTriangles: 15_000 },
  { id: 477, name: 'STR', targetTriangles: 20_000 },
  { id: 672, name: 'CP', targetTriangles: 15_000 },
  { id: 56, name: 'ACB', targetTriangles: 10_000 },
  { id: 803, name: 'PAL', targetTriangles: 12_000 },
  { id: 549, name: 'TH', targetTriangles: 20_000 },
  { id: 1097, name: 'HY', targetTriangles: 15_000 },
  { id: 313, name: 'MB', targetTriangles: 20_000 },
  { id: 749, name: 'VTA', targetTriangles: 8_000 },
  { id: 374, name: 'SNc', targetTriangles: 8_000 },
  { id: 771, name: 'P', targetTriangles: 15_000 },
  { id: 354, name: 'MY', targetTriangles: 15_000 },
  { id: 512, name: 'CB', targetTriangles: 25_000 },
  { id: 73, name: 'VS', targetTriangles: 12_000 },
  { id: 1009, name: 'fiber tracts', targetTriangles: 25_000 },
]

const MESH_MAGIC = 'BCMSH1\0\0'

function log(...args) {
  console.log('[atlas]', ...args)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Download a URL into `data/raw/`, reusing the cached copy when present. */
async function download(url, filename) {
  const target = join(RAW_DIR, filename)
  if (await exists(target)) {
    const info = await stat(target)
    log(`cached  ${filename} (${(info.size / 1e6).toFixed(1)} MB)`)
    return target
  }

  log(`fetch   ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(target, bytes)
  log(`saved   ${filename} (${(bytes.length / 1e6).toFixed(1)} MB)`)
  return target
}

/**
 * Parse a Wavefront OBJ into positions and triangle indices.
 *
 * Allen structure meshes are plain `v`/`f` triangle soups. Only the vertex
 * index of each face corner is read; texture and normal indices are ignored
 * because the meshes carry neither.
 */
function parseObj(text) {
  const positions = []
  const indices = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.charCodeAt(0) === 35 /* '#' */) continue

    if (line.startsWith('v ')) {
      const parts = line.split(/\s+/)
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]))
      continue
    }

    if (line.startsWith('f ')) {
      const parts = line.split(/\s+/).slice(1)
      // Fan-triangulate, so quads and n-gons are handled if they ever appear.
      const corners = parts.map((part) => {
        const index = Number.parseInt(part.split('/')[0], 10)
        // OBJ indices are 1-based; negatives count back from the end.
        return index < 0 ? positions.length / 3 + index : index - 1
      })
      for (let i = 1; i + 1 < corners.length; i++) {
        indices.push(corners[0], corners[i], corners[i + 1])
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  }
}

/**
 * Serialise a mesh to BrainCAD's `.msh` container.
 *
 * Layout (little-endian):
 *   0   char[8]   "BCMSH1\0\0"
 *   8   uint32    vertex count
 *   12  uint32    index count
 *   16  float32[6] bounding box (minX minY minZ maxX maxY maxZ), µm
 *   40  float32[3 * vertexCount] positions, µm in CCF space
 *       uint32[indexCount] indices
 *
 * A custom container beats glTF here: both ends are ours, the browser loader is
 * a few lines with no dependency, and the payload is already the exact typed
 * arrays three.js wants. User-supplied geometry still arrives as STL/OBJ/GLB.
 *
 * Normals are deliberately NOT stored. They are exactly as large as the
 * position data, and three.js recomputes them from the indexed geometry in a
 * few milliseconds — so shipping them would double every download to save work
 * that is not worth saving.
 */
function encodeMesh(positions, indices) {
  const vertexCount = positions.length / 3
  const headerBytes = 40
  const buffer = new ArrayBuffer(headerBytes + positions.byteLength + indices.byteLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  for (let i = 0; i < 8; i++) view.setUint8(i, MESH_MAGIC.charCodeAt(i))
  view.setUint32(8, vertexCount, true)
  view.setUint32(12, indices.length, true)

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat32(16 + axis * 4, min[axis], true)
    view.setFloat32(28 + axis * 4, max[axis], true)
  }

  let offset = headerBytes
  bytes.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), offset)
  offset += positions.byteLength
  bytes.set(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), offset)

  return Buffer.from(buffer)
}

async function processMesh(entry) {
  const filename = `${entry.id}.obj`
  let rawPath
  try {
    rawPath = await download(`${MESH_BASE}/${filename}`, filename)
  } catch (error) {
    log(`SKIP    ${entry.id} (${entry.name}): ${error.message}`)
    return null
  }

  const text = await readFile(rawPath, 'utf8')
  const { positions, indices } = parseObj(text)
  const sourceTriangles = indices.length / 3

  let finalIndices = indices
  if (sourceTriangles > entry.targetTriangles) {
    const targetIndexCount = entry.targetTriangles * 3
    // 1% target error keeps outer surfaces faithful enough for clearance work
    // while cutting download size by roughly an order of magnitude.
    finalIndices = MeshoptSimplifier.simplify(
      indices,
      positions,
      3,
      targetIndexCount,
      0.01,
      ['LockBorder'],
    )[0]
  }

  const encoded = encodeMesh(positions, finalIndices)
  await writeFile(join(MESH_OUT_DIR, `${entry.id}.msh`), encoded)

  const finalTriangles = finalIndices.length / 3
  log(
    `mesh    ${String(entry.id).padStart(4)} ${entry.name.padEnd(14)} ` +
      `${sourceTriangles} → ${finalTriangles} tris, ${(encoded.length / 1024).toFixed(0)} KB`,
  )

  return {
    id: entry.id,
    name: entry.name,
    triangles: finalTriangles,
    bytes: encoded.length,
    file: `meshes/${entry.id}.msh`,
  }
}

/** Flatten the Allen ontology tree into the compact array the app loads. */
function flattenOntology(node, parentId, path, depth, out) {
  const currentPath = [...path, node.id]
  out.push({
    id: node.id,
    acronym: node.acronym,
    name: node.name,
    colorHex: node.color_hex_triplet,
    parentId,
    path: currentPath,
    depth,
  })
  for (const child of node.children ?? []) {
    flattenOntology(child, node.id, currentPath, depth + 1, out)
  }
  return out
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true })
  await mkdir(MESH_OUT_DIR, { recursive: true })

  // 1. Annotation volume — shipped as-is; 880 KB gzip decodes in a worker.
  const annotationPath = await download(ANNOTATION_URL, 'annotation_50.nrrd')
  const annotation = await readFile(annotationPath)
  await writeFile(join(OUT_DIR, 'annotation_50.nrrd'), annotation)

  // 2. Structure ontology.
  const ontologyPath = await download(ONTOLOGY_URL, 'structure_graph.json')
  const ontologyJson = JSON.parse(await readFile(ontologyPath, 'utf8'))
  const treeRoot = ontologyJson.msg?.[0]
  if (!treeRoot) throw new Error('Unexpected ontology payload: no msg[0]')

  const structures = flattenOntology(treeRoot, null, [], 0, [])
  await writeFile(join(OUT_DIR, 'structures.json'), JSON.stringify(structures))
  log(`ontology ${structures.length} structures`)

  // 3. Curated meshes.
  const meshes = []
  for (const entry of CURATED_STRUCTURES) {
    const result = await processMesh(entry)
    if (result) meshes.push(result)
  }

  // 4. Manifest.
  const manifest = {
    generatedAt: new Date().toISOString(),
    annotation: {
      file: 'annotation_50.nrrd',
      bytes: annotation.length,
      sha256: createHash('sha256').update(annotation).digest('hex'),
      resolutionUm: 50,
      orientation: 'asr',
      source: ANNOTATION_URL,
    },
    ontology: {
      file: 'structures.json',
      count: structures.length,
      source: ONTOLOGY_URL,
    },
    meshes,
    lazyMeshBaseUrl: MESH_BASE,
    citation:
      'Allen Mouse Brain Common Coordinate Framework v3 (CCFv3); ' +
      'Wang et al. (2020), Cell 181(4):936-953.',
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const totalBytes = meshes.reduce((sum, m) => sum + m.bytes, 0) + annotation.length
  log(`done. ${meshes.length} meshes, ${(totalBytes / 1e6).toFixed(1)} MB shipped.`)
}

await MeshoptSimplifier.ready
await main()
