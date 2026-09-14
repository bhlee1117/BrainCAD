/**
 * Validation of the built-in models against the real STL files.
 *
 * The declarations in `builtins.ts` are claims about parts this test can
 * actually check: that the microprism's imaging face ends up on the plane the
 * placement solve aims by, that the objective's focal point sits one working
 * distance in front of its front element, that the headbar's opening is
 * centred on its anchor and the plate rests on it.
 *
 * That matters more here than for a parametric primitive. A wrong dimension in
 * a builder shows up as a visibly wrong shape; a wrong *rotation* on an
 * imported mesh renders the correct part, beautifully, in a pose that is
 * ninety degrees from the truth — and every clearance computed against it is
 * confidently wrong. Self-consistency cannot catch that. Reading the real
 * geometry and asking where a known feature landed can.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Matrix3, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  BUILTIN_MODELS,
  HEADBAR,
  MICROPRISM,
  OBJECTIVE_N16XLWD,
  fileToLocalMatrix,
  toLocalFrame,
  type BuiltinModel,
} from './builtins.ts'
import { parseGeometry } from './import.ts'
import { KIND_COLOR, KIND_LABEL, makeObject } from './model.ts'
import { prismImagingFace, type BuiltPrimitive } from './primitives.ts'

const MODELS_DIR = join(process.cwd(), 'public', 'models')

const assetsPresent = BUILTIN_MODELS.every((m) => existsSync(join(MODELS_DIR, m.file)))

/** Load and place a model exactly as the app does, but from disk. */
function place(model: BuiltinModel): BuiltPrimitive {
  const bytes = readFileSync(join(MODELS_DIR, model.file))
  // Node's Buffer is a view into a larger pool, so hand the loader just this
  // file's bytes rather than the whole underlying ArrayBuffer.
  const parsed = parseGeometry(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    'stl',
  )
  return toLocalFrame(model, parsed.geometry)
}

/** Every distinct vertex of a placed model, in local millimetres. */
function vertices(built: BuiltPrimitive): Vector3[] {
  const position = built.geometry.getAttribute('position')
  const out: Vector3[] = []
  for (let i = 0; i < position.count; i++) {
    out.push(new Vector3(position.getX(i), position.getY(i), position.getZ(i)))
  }
  return out
}

describe('built-in model declarations', () => {
  it.each(BUILTIN_MODELS)('$id declares a proper rotation', (model) => {
    // An improper "rotation" — one with a reflection in it — would mirror the
    // part. A mirrored microprism reflects light the other way and a mirrored
    // headbar has its arms on the wrong side, and neither looks wrong on screen.
    const matrix = new Matrix3().setFromMatrix4(fileToLocalMatrix(model))
    const e = matrix.elements

    const columns = [
      new Vector3(e[0], e[1], e[2]),
      new Vector3(e[3], e[4], e[5]),
      new Vector3(e[6], e[7], e[8]),
    ]
    for (const column of columns) expect(column.length()).toBeCloseTo(1, 9)
    expect(columns[0]!.dot(columns[1]!)).toBeCloseTo(0, 9)
    expect(columns[1]!.dot(columns[2]!)).toBeCloseTo(0, 9)
    expect(columns[0]!.dot(columns[2]!)).toBeCloseTo(0, 9)
    expect(columns[0]!.clone().cross(columns[1]!).dot(columns[2]!)).toBeCloseTo(1, 9)
  })

  it.each(BUILTIN_MODELS)('$id has a colour and a label for its kind', (model) => {
    expect(KIND_COLOR[model.kind]).toBeTruthy()
    expect(KIND_LABEL[model.kind]).toBeTruthy()
  })

  it('gives every model a distinct id', () => {
    const ids = new Set(BUILTIN_MODELS.map((m) => m.id))
    expect(ids.size).toBe(BUILTIN_MODELS.length)
  })

  it.each(BUILTIN_MODELS)('places $id checking only against other objects', (model) => {
    // Collision answers "will these two parts hit each other". The atlas is an
    // averaged reference brain, not the animal's skull, so a hit against it is
    // not evidence — and left on, the one object always touching tissue keeps
    // the whole report red and buries the pairs that matter.
    const object = makeObject('object-1', model.kind, { ap: 0, ml: 0, dv: 0 })
    expect(object.collision).toBe(true)
    expect(object.anatomyCollision).toBe(false)
  })
})

describe.skipIf(!assetsPresent)('built-in models, placed from the real files', () => {
  it.each(BUILTIN_MODELS)('$id lands its anchor on the local origin', (model) => {
    const built = place(model)
    expect(built.anchor.length()).toBe(0)
    expect(built.axis.equals(new Vector3(0, -1, 0))).toBe(true)
    expect(built.lengthMm).toBeGreaterThan(0)

    // Every part lies above its anchor along the axis — an objective's
    // anchor is its focal point and so sits in free space below the solid,
    // which is exactly why this is stated as "above" and not "contains".
    const box = built.geometry.boundingBox!
    expect(box.max.y).toBeGreaterThan(0)
    expect(built.lengthMm).toBeCloseTo(box.max.y, 6)

    // And the anchor is on the part's own axis, not off to one side of it.
    expect(box.min.x).toBeLessThanOrEqual(0)
    expect(box.max.x).toBeGreaterThanOrEqual(0)
    expect(box.min.z).toBeLessThanOrEqual(0)
    expect(box.max.z).toBeGreaterThanOrEqual(0)
  })

  describe('Nikon 16× objective', () => {
    const built = place(OBJECTIVE_N16XLWD)
    const box = built.geometry.boundingBox!

    it('puts the front element exactly one working distance above the focus', () => {
      // The anchor is the focal point and the objective points down, so the
      // nearest part of the solid is the front element. This is the claim the
      // whole optical-access calculation rests on.
      const workingDistanceMm = (
        OBJECTIVE_N16XLWD.spec!.params as { workingDistanceMm: number }
      ).workingDistanceMm
      expect(box.min.y).toBeCloseTo(workingDistanceMm, 3)
    })

    it('runs along the DV axis, barrel upward', () => {
      expect(box.max.y).toBeCloseTo(built.lengthMm, 6)
      // 76.96 mm of objective above a 3 mm working distance.
      expect(built.lengthMm).toBeCloseTo(79.962, 2)
    })

    it('is a body of revolution about the optical axis', () => {
      // Whatever rotation was applied, a barrel that came out tilted would
      // show up as an off-centre or asymmetric footprint in ML/AP.
      expect(box.min.x).toBeCloseTo(-box.max.x, 3)
      expect(box.min.z).toBeCloseTo(-box.max.z, 3)
      // The widest point is the mounting collar, ⌀35.05 mm.
      expect(box.max.x * 2).toBeCloseTo(35.05, 1)
    })

    it('sits 75 mm — the catalogue parfocal distance — behind its collar', () => {
      // An independent check that this file really is a 16×/WD 3.0 objective
      // and that the anchor is at the focus rather than, say, at the tip. The
      // collar is the widest feature; find where along the axis it starts.
      const radius = box.max.x
      const collarY = vertices(built)
        .filter((v) => Math.hypot(v.x, v.z) > radius - 0.05)
        .reduce((max, v) => Math.max(max, v.y), 0)
      expect(collarY).toBeGreaterThan(70)
      expect(collarY).toBeCloseTo(75, 0)
    })
  })

  describe('microprism', () => {
    const built = place(MICROPRISM)
    const box = built.geometry.boundingBox!

    it('lands the imaging face on the plane the placement solve aims', () => {
      // `prismImagingFace()` declares +Z, and roll is what aims it. A prism
      // whose face came out on −Z would be aimed 180° from every angle the
      // user types.
      const face = prismImagingFace()
      expect(face.normal.equals(new Vector3(0, 0, 1))).toBe(true)

      // Only the coverslip, which overhangs the glass, reaches past the face.
      const prismBody = vertices(built).filter((v) => v.y < 1.5)
      const beyond = prismBody.filter((v) => v.z > 1e-3)
      expect(beyond).toHaveLength(0)
    })

    it('puts the anchor at the centre of the 1.5 mm aperture', () => {
      // The aperture is not a face of its own — it is the lower 1.5 mm of a
      // taller flat, and the 45° hypotenuse is what decides where it starts
      // and stops, since only light that reflects off the hypotenuse leaves
      // through it. So the claim is checked against the hypotenuse itself.
      //
      // After the transform, the reflecting face lies on y + z = −0.75, the
      // coverslip nowhere near it. Its extent along the axis *is* the
      // aperture, and it must straddle the anchor evenly: half the field
      // above the coordinate and half below is what "the coordinate is the
      // tissue the prism images" means geometrically.
      const hypotenuse = vertices(built).filter((v) => Math.abs(v.y + v.z + 0.75) < 1e-3)
      expect(hypotenuse.length).toBeGreaterThan(3)

      const ys = hypotenuse.map((v) => v.y)
      const xs = hypotenuse.map((v) => v.x)
      expect(Math.min(...ys)).toBeCloseTo(-0.75, 3)
      expect(Math.max(...ys)).toBeCloseTo(0.75, 3)
      expect(Math.min(...xs)).toBeCloseTo(-0.75, 3)
      expect(Math.max(...xs)).toBeCloseTo(0.75, 3)
    })

    it('descends 0.75 mm below the anchor to the tip', () => {
      expect(box.min.y).toBeCloseTo(-0.75, 3)
    })

    it('caps the assembly with a 3 mm coverslip', () => {
      // The coverslip is the top 0.17 mm and is the widest thing in the part.
      expect(box.max.y).toBeCloseTo(1.75, 3)
      expect(box.max.x - box.min.x).toBeCloseTo(3.0, 2)
    })
  })

  describe('headbar', () => {
    const built = place(HEADBAR)
    const box = built.geometry.boundingBox!

    it('rests its skull-contact face on the anchor', () => {
      // Placing the headbar at DV 0 should put the underside of the plate at
      // DV 0, not its mid-plane or its top.
      expect(box.min.y).toBeCloseTo(0, 6)
      expect(box.max.y).toBeCloseTo(1.0, 3)
    })

    it('centres the 8 mm opening on the anchor', () => {
      // Every vertex on the bore of the opening should be exactly 4 mm from
      // the anchor's axis. Found by radius rather than by index, because the
      // plate also carries two 1.4 mm arm holes.
      const bore = vertices(built).filter((v) => {
        const r = Math.hypot(v.x, v.z)
        return r > 3.9 && r < 4.1
      })
      expect(bore.length).toBeGreaterThan(100)

      for (const v of bore) {
        expect(Math.hypot(v.x, v.z)).toBeCloseTo(4.0, 2)
      }
    })

    it('is symmetric about the midline', () => {
      // The arms must come out mirror-imaged about ML 0, or the plate would be
      // planned onto one hemisphere.
      expect(box.min.x).toBeCloseTo(-box.max.x, 1)
    })
  })
})
