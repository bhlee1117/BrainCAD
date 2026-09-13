/**
 * Import of user-supplied hardware geometry.
 *
 * The hard part of importing a lab's own STL is not parsing it — three.js does
 * that — but reconciling two things the file does not reliably state: what unit
 * its numbers are in, and where its origin sits relative to the part. A
 * headplate exported in metres and one exported in millimetres look identical
 * on screen until they are placed next to a 13 mm brain.
 *
 * So imports are never silently trusted. The unit is inferred with an explicit
 * confidence level and always shown for confirmation, and the origin is chosen
 * deliberately rather than assumed to be meaningful.
 */

import { Box3, BufferGeometry, Vector3 } from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type ImportFormat = 'stl' | 'obj' | 'glb'

/** Unit the file's numbers are expressed in. */
export type SourceUnit = 'mm' | 'um' | 'cm' | 'm' | 'in'

/** Millimetres per one unit of each kind. */
export const MM_PER_UNIT: Record<SourceUnit, number> = {
  um: 0.001,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
}

/** Where the object's local origin should sit once imported. */
export type OriginMode =
  /** Keep the file's own origin. */
  | 'file'
  /** Centre of the bounding box. */
  | 'center'
  /** Centred in X/Z, but sitting on the lowest point — useful for a tip. */
  | 'base'

export interface ImportOptions {
  unit: SourceUnit
  /** Extra multiplier applied after the unit conversion. */
  scale: number
  origin: OriginMode
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  unit: 'mm',
  scale: 1,
  origin: 'file',
}

export interface UnitGuess {
  readonly unit: SourceUnit
  readonly confidence: 'likely' | 'uncertain'
  readonly reason: string
}

export interface ImportedGeometry {
  readonly geometry: BufferGeometry
  readonly format: ImportFormat
  readonly triangleCount: number
  /** Bounds in the file's own units, before any conversion. */
  readonly rawBounds: Box3
  readonly unitGuess: UnitGuess
}

export function formatFromFilename(name: string): ImportFormat | null {
  const ext = name.toLowerCase().split('.').pop()
  if (ext === 'stl') return 'stl'
  if (ext === 'obj') return 'obj'
  if (ext === 'glb' || ext === 'gltf') return 'glb'
  return null
}

/**
 * Guess the file's unit from the size of the part.
 *
 * Lab hardware for mouse surgery is, in millimetres, roughly 0.1 mm (a
 * pipette tip) to 100 mm (a stereotaxic arm). Reading the largest dimension
 * against that range distinguishes the common cases, but it is a heuristic
 * and is labelled as one: a part that is genuinely 3 units across is
 * ambiguous, and the UI asks rather than assumes.
 */
export function guessUnit(bounds: Box3): UnitGuess {
  const size = bounds.getSize(new Vector3())
  const largest = Math.max(size.x, size.y, size.z)

  if (!Number.isFinite(largest) || largest <= 0) {
    return { unit: 'mm', confidence: 'uncertain', reason: 'Geometry has no measurable size.' }
  }

  if (largest > 1000) {
    return {
      unit: 'um',
      confidence: 'likely',
      reason: `Largest dimension is ${largest.toFixed(0)} units — plausible only as micrometres.`,
    }
  }
  if (largest >= 1) {
    return {
      unit: 'mm',
      confidence: largest >= 3 ? 'likely' : 'uncertain',
      reason: `Largest dimension is ${largest.toFixed(2)} units — consistent with millimetres.`,
    }
  }
  return {
    unit: 'm',
    confidence: largest < 0.2 ? 'likely' : 'uncertain',
    reason: `Largest dimension is ${largest.toFixed(4)} units — too small for millimetres; likely metres.`,
  }
}

/** Collect every mesh geometry in a parsed scene into one buffer geometry. */
function flattenScene(root: { traverse: (fn: (o: unknown) => void) => void }): BufferGeometry {
  const parts: BufferGeometry[] = []

  root.traverse((node: unknown) => {
    const candidate = node as {
      isMesh?: boolean
      geometry?: BufferGeometry
      updateWorldMatrix?: (a: boolean, b: boolean) => void
      matrixWorld?: { clone: () => unknown }
    }
    if (!candidate.isMesh || !candidate.geometry) return

    const geometry = candidate.geometry.clone()
    candidate.updateWorldMatrix?.(true, false)
    if (candidate.matrixWorld) {
      // Bake the node's own placement in, so a hierarchy imports as one solid.
      geometry.applyMatrix4(candidate.matrixWorld as never)
    }
    // Normals and positions are all collision and rendering need; dropping
    // everything else lets geometries with mismatched attributes merge.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    parts.push(geometry.toNonIndexed())
  })

  if (parts.length === 0) throw new Error('File contains no mesh geometry.')
  return parts.length === 1 ? parts[0]! : (mergeGeometries(parts, false) ?? parts[0]!)
}

/** Parse file bytes into a single geometry, in the file's own units. */
export function parseGeometry(buffer: ArrayBuffer, format: ImportFormat): ImportedGeometry {
  let geometry: BufferGeometry

  if (format === 'stl') {
    geometry = new STLLoader().parse(buffer)
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  } else if (format === 'obj') {
    const text = new TextDecoder().decode(buffer)
    geometry = flattenScene(new OBJLoader().parse(text))
  } else {
    throw new Error('GLB must be parsed with parseGeometryAsync.')
  }

  geometry.computeBoundingBox()
  const rawBounds = geometry.boundingBox?.clone() ?? new Box3()

  return {
    geometry,
    format,
    triangleCount: countTriangles(geometry),
    rawBounds,
    unitGuess: guessUnit(rawBounds),
  }
}

/** GLB/glTF needs an async parse; STL and OBJ go through {@link parseGeometry}. */
export async function parseGeometryAsync(
  buffer: ArrayBuffer,
  format: ImportFormat,
): Promise<ImportedGeometry> {
  if (format !== 'glb') return parseGeometry(buffer, format)

  const gltf = await new GLTFLoader().parseAsync(buffer, '')
  const geometry = flattenScene(gltf.scene)
  geometry.computeBoundingBox()
  const rawBounds = geometry.boundingBox?.clone() ?? new Box3()

  return {
    geometry,
    format,
    triangleCount: countTriangles(geometry),
    rawBounds,
    unitGuess: guessUnit(rawBounds),
  }
}

function countTriangles(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return index.count / 3
  const position = geometry.getAttribute('position')
  return position ? position.count / 3 : 0
}

/**
 * Apply unit conversion, scale and origin choice, producing geometry in
 * BrainCAD's local millimetre space.
 *
 * Returns a new geometry; the parsed original is left untouched so the user can
 * change units without re-reading the file.
 */
export function applyImportOptions(
  imported: ImportedGeometry,
  options: ImportOptions,
): { geometry: BufferGeometry; boundsMm: Box3 } {
  const factor = MM_PER_UNIT[options.unit] * (options.scale || 1)

  const geometry = imported.geometry.clone()
  geometry.scale(factor, factor, factor)
  geometry.computeBoundingBox()

  const box = geometry.boundingBox ?? new Box3()
  const centre = box.getCenter(new Vector3())

  if (options.origin === 'center') {
    geometry.translate(-centre.x, -centre.y, -centre.z)
  } else if (options.origin === 'base') {
    geometry.translate(-centre.x, -box.min.y, -centre.z)
  }

  geometry.computeBoundingBox()
  geometry.computeVertexNormals()

  return { geometry, boundsMm: geometry.boundingBox?.clone() ?? new Box3() }
}

/** Human-readable size summary, for the import panel. */
export function describeSize(bounds: Box3, unit: string): string {
  const size = bounds.getSize(new Vector3())
  return `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} ${unit}`
}

/**
 * Whether an imported part is a plausible size for mouse stereotaxic work.
 *
 * Used to warn — never to block — because a user may legitimately import a
 * whole rig assembly. A part 400 mm across next to a 13 mm brain is far more
 * likely a unit mistake than a deliberate choice, and saying so at import time
 * is much cheaper than discovering it during a collision check.
 */
export function sizeWarning(boundsMm: Box3): string | null {
  const size = boundsMm.getSize(new Vector3())
  const largest = Math.max(size.x, size.y, size.z)

  if (largest > 200) {
    return `This part is ${largest.toFixed(0)} mm across — far larger than a mouse skull (~13 mm). Check the unit setting.`
  }
  if (largest < 0.05) {
    return `This part is only ${(largest * 1000).toFixed(0)} µm across. Check the unit setting.`
  }
  return null
}
