/**
 * Tests for pivot-aware placement.
 *
 * The defining property is simple and worth stating plainly: whatever the
 * pivot is and however the object is rotated, the anchor must land exactly on
 * the target. If that ever fails, a pipette tip is not where the coordinate
 * readout says it is.
 */

import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  AXIS_DV,
  NO_ROTATION,
  angleFromVerticalDeg,
  localToWorld,
  normaliseDegrees,
  orientationToQuaternion,
  quaternionToOrientation,
  solvePlacement,
  worldAxis,
  type Orientation,
} from './placement.ts'
import { stereotaxicToWorld } from '../scene/world.ts'
import type { Stereotaxic } from '../atlas/coords.ts'

const TARGET: Stereotaxic = { ap: -2.0, ml: 1.5, dv: -1.35 }

/** Assert that a solved placement really does put the anchor on the target. */
function expectAnchorOnTarget(
  anchor: Vector3,
  pivot: Vector3,
  orientation: Orientation,
  target: Stereotaxic,
) {
  const placement = solvePlacement(anchor, pivot, orientation, target)
  const world = localToWorld(anchor, placement, pivot)
  const expected = stereotaxicToWorld(target)

  expect(world.x).toBeCloseTo(expected.x, 9)
  expect(world.y).toBeCloseTo(expected.y, 9)
  expect(world.z).toBeCloseTo(expected.z, 9)
}

describe('the anchor always lands on the target', () => {
  const cases: [string, Vector3, Vector3, Orientation][] = [
    ['no rotation, pivot at anchor', new Vector3(0, 0, 0), new Vector3(0, 0, 0), NO_ROTATION],
    [
      'pivot far from anchor, no rotation',
      new Vector3(0, 0, 0),
      new Vector3(0, 8, 0),
      NO_ROTATION,
    ],
    [
      'angled approach, pivot at skull entry',
      new Vector3(0, 0, 0),
      new Vector3(0, 4.5, 0),
      { apTiltDeg: -12, mlTiltDeg: 17, rollDeg: 0 },
    ],
    [
      'offset anchor and offset pivot, fully rotated',
      new Vector3(0.4, 1.2, -0.3),
      new Vector3(-1.1, 6.0, 0.75),
      { apTiltDeg: 23.5, mlTiltDeg: -8.25, rollDeg: 41 },
    ],
    [
      'roll only',
      new Vector3(0.5, 0, 0),
      new Vector3(0, 3, 0),
      { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 90 },
    ],
  ]

  it.each(cases)('%s', (_name, anchor, pivot, orientation) => {
    expectAnchorOnTarget(anchor, pivot, orientation, TARGET)
  })

  it('holds across a sweep of tilt combinations', () => {
    const anchor = new Vector3(0, 0, 0)
    const pivot = new Vector3(0, 5, 0)
    for (let ap = -30; ap <= 30; ap += 15) {
      for (let ml = -30; ml <= 30; ml += 15) {
        expectAnchorOnTarget(anchor, pivot, { apTiltDeg: ap, mlTiltDeg: ml, rollDeg: 0 }, TARGET)
      }
    }
  })
})

describe('solvePlacement degenerate cases', () => {
  it('reduces to a plain offset when nothing is rotated', () => {
    const anchor = new Vector3(0, 0, 0)
    const pivot = new Vector3(0, 7, 0)
    const placement = solvePlacement(anchor, pivot, NO_ROTATION, TARGET)
    const expected = stereotaxicToWorld(TARGET).sub(anchor)

    expect(placement.position.x).toBeCloseTo(expected.x, 9)
    expect(placement.position.y).toBeCloseTo(expected.y, 9)
    expect(placement.position.z).toBeCloseTo(expected.z, 9)
  })

  it('rotates about the target itself when pivot and anchor coincide', () => {
    const point = new Vector3(0, 0, 0)
    const orientation: Orientation = { apTiltDeg: 20, mlTiltDeg: 10, rollDeg: 0 }
    const placement = solvePlacement(point, point, orientation, TARGET)

    // A second point on the instrument must stay at its original distance from
    // the target, since the whole object pivots around that point.
    const shaftPoint = new Vector3(0, 6, 0)
    const world = localToWorld(shaftPoint, placement, point)
    expect(world.distanceTo(stereotaxicToWorld(TARGET))).toBeCloseTo(6, 9)
  })
})

describe('orientation semantics', () => {
  it('leaves a straight-down instrument pointing down when unrotated', () => {
    const axis = worldAxis(new Vector3(0, -1, 0), NO_ROTATION)
    expect(axis.x).toBeCloseTo(0, 9)
    expect(axis.y).toBeCloseTo(-1, 9)
    expect(axis.z).toBeCloseTo(0, 9)
  })

  it('swings the tip anteriorly for positive AP tilt', () => {
    const axis = worldAxis(new Vector3(0, -1, 0), {
      apTiltDeg: 30,
      mlTiltDeg: 0,
      rollDeg: 0,
    })
    expect(axis.z).toBeGreaterThan(0) // +Z is anterior
    expect(axis.y).toBeLessThan(0) // still pointing downward
    expect(axis.x).toBeCloseTo(0, 9) // no lateral component
  })

  it('swings the tip toward the right for positive ML tilt', () => {
    const axis = worldAxis(new Vector3(0, -1, 0), {
      apTiltDeg: 0,
      mlTiltDeg: 30,
      rollDeg: 0,
    })
    expect(axis.x).toBeGreaterThan(0) // +X is the animal's right
    expect(axis.y).toBeLessThan(0)
    expect(axis.z).toBeCloseTo(0, 9)
  })

  it('does not change where the instrument points when only roll changes', () => {
    // The property that makes the fixed rotation order worth specifying: an
    // experimenter spinning a prism about its axis must not alter the approach.
    const base: Orientation = { apTiltDeg: 14, mlTiltDeg: -9, rollDeg: 0 }
    const rolled: Orientation = { ...base, rollDeg: 75 }

    const a = worldAxis(new Vector3(0, -1, 0), base)
    const b = worldAxis(new Vector3(0, -1, 0), rolled)

    expect(b.x).toBeCloseTo(a.x, 9)
    expect(b.y).toBeCloseTo(a.y, 9)
    expect(b.z).toBeCloseTo(a.z, 9)
  })

  it('does rotate off-axis features when rolled', () => {
    // Roll must still do something: a point offset from the axis moves.
    const offset = new Vector3(1, 0, 0)
    const straight = offset.clone().applyQuaternion(orientationToQuaternion(NO_ROTATION))
    const rolled = offset
      .clone()
      .applyQuaternion(
        orientationToQuaternion({ apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 90 }),
      )
    expect(rolled.distanceTo(straight)).toBeGreaterThan(1)
  })

  it('reports the angle away from vertical for combined tilts', () => {
    expect(angleFromVerticalDeg(NO_ROTATION)).toBeCloseTo(0, 9)
    expect(
      angleFromVerticalDeg({ apTiltDeg: 30, mlTiltDeg: 0, rollDeg: 0 }),
    ).toBeCloseTo(30, 6)
    expect(
      angleFromVerticalDeg({ apTiltDeg: 0, mlTiltDeg: -25, rollDeg: 0 }),
    ).toBeCloseTo(25, 6)

    // Combined tilts compound into something steeper than either alone, but
    // less than their sum.
    const combined = angleFromVerticalDeg({ apTiltDeg: 30, mlTiltDeg: 30, rollDeg: 0 })
    expect(combined).toBeGreaterThan(30)
    expect(combined).toBeLessThan(60)
    expect(combined).toBeCloseTo(41.409, 2)
  })

  it('is unaffected in angle-from-vertical by roll alone', () => {
    expect(
      angleFromVerticalDeg({ apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 180 }),
    ).toBeCloseTo(0, 6)
  })

  it('produces a unit quaternion', () => {
    const q = orientationToQuaternion({ apTiltDeg: 33, mlTiltDeg: -12, rollDeg: 88 })
    expect(q.length()).toBeCloseTo(1, 9)
  })

  it('rotates about the DV axis for roll, by construction', () => {
    const q = orientationToQuaternion({ apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 37 })
    const axis = AXIS_DV.clone().applyQuaternion(q)
    // The roll axis is its own fixed point.
    expect(axis.x).toBeCloseTo(0, 9)
    expect(axis.y).toBeCloseTo(1, 9)
    expect(axis.z).toBeCloseTo(0, 9)
  })
})

describe('recovering angles from a quaternion', () => {
  // The gizmo hands back a quaternion; the panel and the planning sheet speak
  // in tilt angles. These must be the same rotation, or dragging and typing
  // would disagree.
  const orientations: Orientation[] = [
    { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 0 },
    { apTiltDeg: 17, mlTiltDeg: 0, rollDeg: 0 },
    { apTiltDeg: 0, mlTiltDeg: -23.5, rollDeg: 0 },
    { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 64 },
    { apTiltDeg: 12, mlTiltDeg: 8, rollDeg: 30 },
    { apTiltDeg: -28.25, mlTiltDeg: 19.75, rollDeg: -47.5 },
    { apTiltDeg: 60, mlTiltDeg: -40, rollDeg: 170 },
  ]

  it.each(orientations)('round-trips %j', (orientation) => {
    const recovered = quaternionToOrientation(orientationToQuaternion(orientation))
    expect(recovered.apTiltDeg).toBeCloseTo(orientation.apTiltDeg, 6)
    expect(recovered.mlTiltDeg).toBeCloseTo(orientation.mlTiltDeg, 6)
    expect(recovered.rollDeg).toBeCloseTo(normaliseDegrees(orientation.rollDeg), 6)
  })

  it('produces the same rotation even where the angles are degenerate', () => {
    // Pointing straight sideways: AP tilt and roll describe the same motion, so
    // the recovered angles may differ while the rotation must not.
    const orientation: Orientation = { apTiltDeg: 25, mlTiltDeg: 90, rollDeg: 10 }
    const q = orientationToQuaternion(orientation)
    const recovered = orientationToQuaternion(quaternionToOrientation(q))

    const probe = new Vector3(0, -1, 0)
    const a = probe.clone().applyQuaternion(q)
    const b = probe.clone().applyQuaternion(recovered)
    expect(a.distanceTo(b)).toBeLessThan(1e-6)
  })

  it('reports angles in (-180, 180]', () => {
    const recovered = quaternionToOrientation(
      orientationToQuaternion({ apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 350 }),
    )
    expect(recovered.rollDeg).toBeCloseTo(-10, 6)
  })
})

describe('normaliseDegrees', () => {
  it.each([
    [0, 0],
    [10, 10],
    [-10, -10],
    [180, 180],
    [190, -170],
    [360, 0],
    [-370, -10],
    [720, 0],
  ])('maps %d to %d', (input, expected) => {
    expect(normaliseDegrees(input)).toBe(expected)
  })

  it('never returns negative zero', () => {
    expect(Object.is(normaliseDegrees(-360), -0)).toBe(false)
  })
})

describe('entry point geometry', () => {
  it('places a shaft point above the target for a vertical insertion', () => {
    const anchor = new Vector3(0, 0, 0) // tip
    const pivot = new Vector3(0, 0, 0)
    const placement = solvePlacement(anchor, pivot, NO_ROTATION, TARGET)

    // 3 mm up the shaft from the tip.
    const shaft = localToWorld(new Vector3(0, 3, 0), placement, pivot)
    const target = stereotaxicToWorld(TARGET)

    expect(shaft.y - target.y).toBeCloseTo(3, 9)
    expect(shaft.x).toBeCloseTo(target.x, 9)
    expect(shaft.z).toBeCloseTo(target.z, 9)
  })

  it('offsets the entry point laterally for an angled insertion', () => {
    const anchor = new Vector3(0, 0, 0)
    const pivot = new Vector3(0, 0, 0)
    const orientation: Orientation = { apTiltDeg: 0, mlTiltDeg: 20, rollDeg: 0 }
    const placement = solvePlacement(anchor, pivot, orientation, TARGET)

    const shaft = localToWorld(new Vector3(0, 4, 0), placement, pivot)
    const target = stereotaxicToWorld(TARGET)

    // Entering 4 mm up an axis tilted 20° toward the right means the entry
    // sits 4·sin20° = 1.368 mm to the LEFT of the target.
    expect(shaft.x - target.x).toBeCloseTo(-4 * Math.sin((20 * Math.PI) / 180), 6)
    expect(shaft.y - target.y).toBeCloseTo(4 * Math.cos((20 * Math.PI) / 180), 6)
  })
})
