/**
 * Tests for custom geometry import.
 *
 * The unit and origin logic is what these cover. A wrongly-scaled import does
 * not look broken — it looks like a part that happens to be the wrong size —
 * so the inference and its warnings are worth pinning down precisely.
 */

import { Box3, BoxGeometry, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_IMPORT_OPTIONS,
  MM_PER_UNIT,
  applyImportOptions,
  describeSize,
  formatFromFilename,
  guessUnit,
  parseGeometry,
  sizeWarning,
  type ImportedGeometry,
} from './import.ts'

/** Build a fake parsed import around a box of a given size. */
function fakeImport(sizeX: number, sizeY: number, sizeZ: number): ImportedGeometry {
  const geometry = new BoxGeometry(sizeX, sizeY, sizeZ)
  geometry.computeBoundingBox()
  const rawBounds = geometry.boundingBox!.clone()
  return {
    geometry,
    format: 'stl',
    triangleCount: 12,
    rawBounds,
    unitGuess: guessUnit(rawBounds),
  }
}

/** A minimal binary STL: one triangle. */
function binaryStlOneTriangle(): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + 50)
  const view = new DataView(buffer)
  view.setUint32(80, 1, true) // triangle count

  const floats = [
    0, 0, 1, // normal
    0, 0, 0, // v1
    2, 0, 0, // v2
    0, 3, 0, // v3
  ]
  floats.forEach((value, i) => view.setFloat32(84 + i * 4, value, true))
  return buffer
}

describe('format detection', () => {
  it.each([
    ['headplate.stl', 'stl'],
    ['PRISM_v2.STL', 'stl'],
    ['cannula.obj', 'obj'],
    ['rig.glb', 'glb'],
    ['rig.gltf', 'glb'],
  ])('recognises %s', (name, expected) => {
    expect(formatFromFilename(name)).toBe(expected)
  })

  it('rejects formats it cannot read', () => {
    expect(formatFromFilename('design.step')).toBeNull()
    expect(formatFromFilename('notes.txt')).toBeNull()
    expect(formatFromFilename('noextension')).toBeNull()
  })
})

describe('unit inference', () => {
  it('reads a several-millimetre part as millimetres, confidently', () => {
    const guess = guessUnit(fakeImport(12, 8, 5).rawBounds)
    expect(guess.unit).toBe('mm')
    expect(guess.confidence).toBe('likely')
  })

  it('flags a small ambiguous part as uncertain rather than guessing firmly', () => {
    // A 2-unit part could be 2 mm or 2 cm; the UI must ask.
    const guess = guessUnit(fakeImport(2, 1, 1).rawBounds)
    expect(guess.unit).toBe('mm')
    expect(guess.confidence).toBe('uncertain')
  })

  it('reads a thousands-of-units part as micrometres', () => {
    const guess = guessUnit(fakeImport(12000, 8000, 5000).rawBounds)
    expect(guess.unit).toBe('um')
    expect(guess.confidence).toBe('likely')
  })

  it('reads a sub-millimetre-valued part as metres', () => {
    // 0.012 units across is 12 mm expressed in metres.
    const guess = guessUnit(fakeImport(0.012, 0.008, 0.005).rawBounds)
    expect(guess.unit).toBe('m')
    expect(guess.confidence).toBe('likely')
  })

  it('degrades gracefully on empty geometry', () => {
    const guess = guessUnit(new Box3())
    expect(guess.confidence).toBe('uncertain')
    expect(guess.reason).toMatch(/no measurable size/i)
  })

  it('always explains its reasoning', () => {
    const sizes: [number, number, number][] = [
      [12, 8, 5],
      [0.01, 0.01, 0.01],
      [5000, 100, 100],
    ]
    for (const [x, y, z] of sizes) {
      const guess = guessUnit(fakeImport(x, y, z).rawBounds)
      expect(guess.reason.length).toBeGreaterThan(10)
    }
  })
})

describe('unit conversion', () => {
  it('converts every supported unit to millimetres', () => {
    expect(MM_PER_UNIT.um).toBeCloseTo(0.001, 9)
    expect(MM_PER_UNIT.mm).toBe(1)
    expect(MM_PER_UNIT.cm).toBe(10)
    expect(MM_PER_UNIT.m).toBe(1000)
    expect(MM_PER_UNIT.in).toBeCloseTo(25.4, 9)
  })

  it('scales a metre-valued part up to millimetres', () => {
    const imported = fakeImport(0.012, 0.008, 0.005)
    const { boundsMm } = applyImportOptions(imported, {
      ...DEFAULT_IMPORT_OPTIONS,
      unit: 'm',
    })
    const size = boundsMm.getSize(new Vector3())
    expect(size.x).toBeCloseTo(12, 4)
    expect(size.y).toBeCloseTo(8, 4)
  })

  it('scales a micrometre-valued part down to millimetres', () => {
    const { boundsMm } = applyImportOptions(fakeImport(12000, 8000, 5000), {
      ...DEFAULT_IMPORT_OPTIONS,
      unit: 'um',
    })
    expect(boundsMm.getSize(new Vector3()).x).toBeCloseTo(12, 4)
  })

  it('applies an extra scale factor on top of the unit', () => {
    const { boundsMm } = applyImportOptions(fakeImport(10, 10, 10), {
      ...DEFAULT_IMPORT_OPTIONS,
      unit: 'mm',
      scale: 2.5,
    })
    expect(boundsMm.getSize(new Vector3()).x).toBeCloseTo(25, 4)
  })

  it('treats a zero scale as 1 rather than collapsing the part to a point', () => {
    const { boundsMm } = applyImportOptions(fakeImport(10, 10, 10), {
      ...DEFAULT_IMPORT_OPTIONS,
      scale: 0,
    })
    expect(boundsMm.getSize(new Vector3()).x).toBeCloseTo(10, 4)
  })

  it('leaves the parsed geometry untouched so units can be changed again', () => {
    const imported = fakeImport(10, 10, 10)
    const before = imported.rawBounds.getSize(new Vector3()).x
    applyImportOptions(imported, { ...DEFAULT_IMPORT_OPTIONS, unit: 'm' })
    imported.geometry.computeBoundingBox()
    expect(imported.geometry.boundingBox!.getSize(new Vector3()).x).toBeCloseTo(before, 6)
  })
})

describe('origin handling', () => {
  it('keeps the file origin when asked to', () => {
    const geometry = new BoxGeometry(4, 4, 4)
    geometry.translate(10, 20, 30) // deliberately off-origin
    geometry.computeBoundingBox()
    const imported: ImportedGeometry = {
      geometry,
      format: 'stl',
      triangleCount: 12,
      rawBounds: geometry.boundingBox!.clone(),
      unitGuess: guessUnit(geometry.boundingBox!),
    }

    const { boundsMm } = applyImportOptions(imported, {
      ...DEFAULT_IMPORT_OPTIONS,
      origin: 'file',
    })
    expect(boundsMm.getCenter(new Vector3()).x).toBeCloseTo(10, 4)
  })

  it('centres the part on its bounding box', () => {
    const geometry = new BoxGeometry(4, 4, 4)
    geometry.translate(10, 20, 30)
    geometry.computeBoundingBox()
    const imported: ImportedGeometry = {
      geometry,
      format: 'stl',
      triangleCount: 12,
      rawBounds: geometry.boundingBox!.clone(),
      unitGuess: guessUnit(geometry.boundingBox!),
    }

    const { boundsMm } = applyImportOptions(imported, {
      ...DEFAULT_IMPORT_OPTIONS,
      origin: 'center',
    })
    const centre = boundsMm.getCenter(new Vector3())
    expect(centre.x).toBeCloseTo(0, 4)
    expect(centre.y).toBeCloseTo(0, 4)
    expect(centre.z).toBeCloseTo(0, 4)
  })

  it('sits the part on its base, centred laterally', () => {
    const imported = fakeImport(4, 6, 4)
    const { boundsMm } = applyImportOptions(imported, {
      ...DEFAULT_IMPORT_OPTIONS,
      origin: 'base',
    })
    // Lowest point at the origin, so the origin reads as a tip or seating face.
    expect(boundsMm.min.y).toBeCloseTo(0, 4)
    expect(boundsMm.max.y).toBeCloseTo(6, 4)
    expect(boundsMm.getCenter(new Vector3()).x).toBeCloseTo(0, 4)
  })
})

describe('size warnings', () => {
  it('says nothing about a plausible piece of mouse hardware', () => {
    const geometry = new BoxGeometry(12, 4, 8)
    geometry.computeBoundingBox()
    expect(sizeWarning(geometry.boundingBox!)).toBeNull()
  })

  it('warns when a part dwarfs a mouse skull', () => {
    const geometry = new BoxGeometry(400, 10, 10)
    geometry.computeBoundingBox()
    expect(sizeWarning(geometry.boundingBox!)).toMatch(/unit setting/i)
  })

  it('warns when a part is implausibly tiny', () => {
    const geometry = new BoxGeometry(0.01, 0.01, 0.01)
    geometry.computeBoundingBox()
    expect(sizeWarning(geometry.boundingBox!)).toMatch(/µm across/)
  })
})

describe('STL parsing', () => {
  it('reads a binary STL and measures it', () => {
    const imported = parseGeometry(binaryStlOneTriangle(), 'stl')
    expect(imported.triangleCount).toBe(1)
    const size = imported.rawBounds.getSize(new Vector3())
    expect(size.x).toBeCloseTo(2, 5)
    expect(size.y).toBeCloseTo(3, 5)
  })

  it('refuses GLB through the synchronous path', () => {
    expect(() => parseGeometry(new ArrayBuffer(8), 'glb')).toThrow(/parseGeometryAsync/)
  })
})

describe('describeSize', () => {
  it('formats dimensions with their unit', () => {
    const geometry = new BoxGeometry(1.5, 2.25, 3)
    geometry.computeBoundingBox()
    expect(describeSize(geometry.boundingBox!, 'mm')).toBe('1.50 × 2.25 × 3.00 mm')
  })
})
