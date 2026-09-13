/**
 * Tests for the hardware primitives.
 *
 * The geometry itself barely needs testing — three.js draws cylinders
 * correctly. What matters is that each primitive's declared anchor, pivot and
 * extent describe the geometry it actually built, because the placement solve
 * trusts those numbers completely.
 */

import { Box3, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CANNULA,
  DEFAULT_OBJECTIVE,
  DEFAULT_PIPETTE,
  DEFAULT_PRISM,
  buildCannula,
  buildObjective,
  buildPipette,
  buildPrimitive,
  buildPrism,
  defaultParamsFor,
  prismImagingFace,
  triangleCount,
  type ObjectKind,
} from './primitives.ts'

function bounds(geometry: Parameters<typeof triangleCount>[0]) {
  geometry.computeBoundingBox()
  return geometry.boundingBox ?? new Box3()
}

describe('pipette', () => {
  const built = buildPipette(DEFAULT_PIPETTE)

  it('anchors at the tip', () => {
    expect(built.anchor.equals(new Vector3(0, 0, 0))).toBe(true)
  })

  it('points straight down', () => {
    expect(built.axis.equals(new Vector3(0, -1, 0))).toBe(true)
  })

  it('extends upward from the tip, never below it', () => {
    const box = bounds(built.geometry)
    expect(box.min.y).toBeCloseTo(0, 6)
    expect(box.max.y).toBeCloseTo(
      DEFAULT_PIPETTE.taperLengthMm + DEFAULT_PIPETTE.shaftLengthMm,
      4,
    )
  })

  it('is no wider than its shaft', () => {
    const box = bounds(built.geometry)
    expect(box.max.x).toBeLessThanOrEqual(DEFAULT_PIPETTE.shaftDiameterMm / 2 + 1e-6)
  })

  it('reports a length matching its geometry', () => {
    expect(built.lengthMm).toBeCloseTo(bounds(built.geometry).max.y, 4)
  })

  it('tapers to a fine tip', () => {
    // The taper must actually narrow: sample the lowest ring of vertices.
    const position = built.geometry.getAttribute('position')
    let minRadiusNearTip = Infinity
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) > 0.01) continue
      minRadiusNearTip = Math.min(
        minRadiusNearTip,
        Math.hypot(position.getX(i), position.getZ(i)),
      )
    }
    expect(minRadiusNearTip).toBeLessThan(DEFAULT_PIPETTE.shaftDiameterMm / 2)
  })
})

describe('cannula', () => {
  const built = buildCannula(DEFAULT_CANNULA)

  it('anchors at the tip but pivots where the shaft meets the ferrule', () => {
    expect(built.anchor.y).toBeCloseTo(0, 9)
    expect(built.pivot.y).toBeCloseTo(DEFAULT_CANNULA.lengthMm, 9)
    // The two are genuinely distinct — this is the case the model exists for.
    expect(built.pivot.equals(built.anchor)).toBe(false)
  })

  it('spans shaft plus ferrule', () => {
    const box = bounds(built.geometry)
    expect(box.min.y).toBeCloseTo(0, 4)
    expect(box.max.y).toBeCloseTo(
      DEFAULT_CANNULA.lengthMm + DEFAULT_CANNULA.ferruleLengthMm,
      4,
    )
  })

  it('is widest at the ferrule', () => {
    const box = bounds(built.geometry)
    expect(box.max.x).toBeCloseTo(DEFAULT_CANNULA.ferruleDiameterMm / 2, 3)
  })
})

describe('prism', () => {
  const built = buildPrism(DEFAULT_PRISM)

  it('anchors on the imaging face, not the geometric centre', () => {
    // The whole reason the anchor concept exists: the useful coordinate is the
    // tissue being imaged, not the centre of the glass.
    const box = bounds(built.geometry)
    const centre = box.getCenter(new Vector3())
    expect(built.anchor.equals(new Vector3(0, 0, 0))).toBe(true)
    expect(centre.length()).toBeGreaterThan(0.1)
  })

  it('reports the imaging face pointing out along +Z', () => {
    const face = prismImagingFace()
    expect(face.centre.equals(new Vector3(0, 0, 0))).toBe(true)
    expect(face.normal.equals(new Vector3(0, 0, 1))).toBe(true)
  })

  it('extends below the anchor by the insertion depth', () => {
    const box = bounds(built.geometry)
    expect(box.min.y).toBeCloseTo(-DEFAULT_PRISM.insertionDepthMm, 6)
  })

  it('sits behind the imaging face', () => {
    const box = bounds(built.geometry)
    expect(box.max.z).toBeCloseTo(0, 6)
    expect(box.min.z).toBeCloseTo(-DEFAULT_PRISM.depthMm, 6)
  })
})

describe('objective', () => {
  const built = buildObjective(DEFAULT_OBJECTIVE)

  it('anchors at the focal point, one working distance below the glass', () => {
    expect(built.anchor.equals(new Vector3(0, 0, 0))).toBe(true)
    const box = bounds(built.geometry)
    // No geometry between the focal point and the front element.
    expect(box.min.y).toBeCloseTo(DEFAULT_OBJECTIVE.workingDistanceMm, 4)
  })

  it('is widest at the barrel and narrowest at the nose', () => {
    const position = built.geometry.getAttribute('position')
    const radiusAt = (yTarget: number) => {
      let best = 0
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getY(i) - yTarget) > 0.6) continue
        best = Math.max(best, Math.hypot(position.getX(i), position.getZ(i)))
      }
      return best
    }

    const front = radiusAt(DEFAULT_OBJECTIVE.workingDistanceMm + 0.2)
    const top = radiusAt(
      DEFAULT_OBJECTIVE.workingDistanceMm +
        DEFAULT_OBJECTIVE.noseLengthMm +
        DEFAULT_OBJECTIVE.barrelLengthMm -
        0.5,
    )
    expect(front).toBeLessThan(top)
  })

  it('includes the safety margin in its solid', () => {
    const withMargin = buildObjective({ ...DEFAULT_OBJECTIVE, safetyMarginMm: 2 })
    const plain = buildObjective({ ...DEFAULT_OBJECTIVE, safetyMarginMm: 0 })
    expect(bounds(withMargin.geometry).max.x - bounds(plain.geometry).max.x).toBeCloseTo(
      2,
      3,
    )
  })

  it('treats a negative safety margin as zero rather than shrinking the body', () => {
    const negative = buildObjective({ ...DEFAULT_OBJECTIVE, safetyMarginMm: -5 })
    const plain = buildObjective({ ...DEFAULT_OBJECTIVE, safetyMarginMm: 0 })
    expect(bounds(negative.geometry).max.x).toBeCloseTo(bounds(plain.geometry).max.x, 6)
  })
})

describe('dispatch', () => {
  const kinds: Exclude<ObjectKind, 'custom'>[] = ['pipette', 'cannula', 'prism', 'objective']

  it.each(kinds)('builds %s from its defaults', (kind) => {
    const built = buildPrimitive(defaultParamsFor(kind))
    expect(triangleCount(built.geometry)).toBeGreaterThan(0)
    expect(built.lengthMm).toBeGreaterThan(0)
    expect(built.axis.length()).toBeCloseTo(1, 9)
  })

  it.each(kinds)('gives %s independent default params', (kind) => {
    // Defaults are copied, so editing one object cannot mutate the shared
    // template and silently change every future object of that kind.
    const a = defaultParamsFor(kind)
    const b = defaultParamsFor(kind)
    expect(a.params).not.toBe(b.params)
    const mutable = a.params as unknown as Record<string, number>
    mutable[Object.keys(mutable)[0]!] = 999
    expect(b.params).not.toEqual(a.params)
  })
})
