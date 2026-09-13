/**
 * Loader for BrainCAD's `.msh` container (see `scripts/fetch-atlas.mjs` for the
 * layout). The format exists so atlas geometry arrives as the exact typed
 * arrays three.js wants, with no parsing and no decoder dependency.
 *
 * User-supplied geometry does not come through here — that path uses three.js's
 * STL/OBJ/GLTF loaders, which handle arbitrary units, origins and hierarchy.
 */

import { BufferAttribute, BufferGeometry, Box3, Vector3 } from 'three'

const MAGIC = 'BCMSH1\0\0'
const HEADER_BYTES = 40

export interface AtlasMesh {
  readonly geometry: BufferGeometry
  readonly triangleCount: number
  /** Axis-aligned bounds in CCF micrometres, as recorded at build time. */
  readonly boundsUm: Box3
}

function readMagic(view: DataView): string {
  let magic = ''
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(view.getUint8(i))
  return magic
}

/**
 * Decode a `.msh` buffer into a three.js geometry.
 *
 * Positions are converted from CCF micrometres to millimetres, because
 * BrainCAD's world unit is 1 mm — keeping millimetres in the scene means
 * camera near/far planes, gizmo sizes and clearance numbers all stay in a
 * range where float32 precision is comfortable.
 */
export function decodeAtlasMesh(buffer: ArrayBuffer): AtlasMesh {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`Not a .msh file: only ${buffer.byteLength} bytes`)
  }

  const view = new DataView(buffer)
  const magic = readMagic(view)
  if (magic !== MAGIC) {
    throw new Error(`Bad .msh magic: ${JSON.stringify(magic)}`)
  }

  const vertexCount = view.getUint32(8, true)
  const indexCount = view.getUint32(12, true)

  const positionBytes = vertexCount * 3 * 4
  const expected = HEADER_BYTES + positionBytes + indexCount * 4
  if (buffer.byteLength < expected) {
    throw new Error(
      `.msh is short: header declares ${vertexCount} vertices and ${indexCount} ` +
        `indices (${expected} bytes) but the file is ${buffer.byteLength}`,
    )
  }

  const boundsUm = new Box3(
    new Vector3(view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)),
    new Vector3(view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true)),
  )

  let offset = HEADER_BYTES
  const positionsUm = new Float32Array(buffer.slice(offset, offset + positionBytes))
  offset += positionBytes
  const indices = new Uint32Array(buffer.slice(offset, offset + indexCount * 4))

  const positionsMm = new Float32Array(positionsUm.length)
  for (let i = 0; i < positionsUm.length; i++) positionsMm[i] = positionsUm[i]! / 1000

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positionsMm, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  // Normals are not stored in the container (see scripts/fetch-atlas.mjs);
  // recomputing them here costs a few milliseconds and halves every download.
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  return { geometry, triangleCount: indexCount / 3, boundsUm }
}

/** Fetch and decode one atlas mesh. */
export async function loadAtlasMesh(url: string, signal?: AbortSignal): Promise<AtlasMesh> {
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) {
    throw new Error(`Failed to load mesh ${url}: HTTP ${response.status}`)
  }
  return decodeAtlasMesh(await response.arrayBuffer())
}
