/**
 * Angle-sweep tests.
 *
 * Built around a deliberately simple obstacle — a wall on one side — so the
 * feasible region is something that can be predicted rather than merely
 * recorded. The property that matters most is that a reported range is
 * *traversable*: quoting "-30° to +30°" when the middle is blocked would
 * describe a path straight through the obstacle.
 */

import { BoxGeometry, Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'

import { makeObject } from '../objects/model.ts'
import { buildPrimitive, defaultParamsFor } from '../objects/primitives.ts'
import { DEFAULT_COLLISION_SETTINGS, buildBvh, type CollisionMesh } from './check.ts'
import { DEFAULT_SWEEP_RANGE, formatRange, sweepAngles } from './sweep.ts'

function obstacle(
  id: string,
  size: [number, number, number],
  position: [number, number, number],
): CollisionMesh {
  const geometry = new BoxGeometry(...size)
  geometry.computeBoundingBox()
  const bvh = buildBvh(geometry)!
  return {
    id,
    label: id,
    geometry,
    bvh,
    matrixWorld: new Matrix4().makeTranslation(...position),
    kind: 'hardware',
  }
}

function objective() {
  const object = makeObject('obj-1', 'objective', { ap: 0, ml: 0, dv: 0 })
  const built = buildPrimitive(defaultParamsFor('objective')!)
  const bvh = buildBvh(built.geometry)!
  return { object, built, bvh }
}

describe('sweepAngles', () => {
  it('samples the whole grid', () => {
    const { object, built, bvh } = objective()
    const result = sweepAngles(object, built, bvh, [], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: -10,
      apToDeg: 10,
      mlFromDeg: -10,
      mlToDeg: 10,
      stepDeg: 5,
    })

    // 5 values on each axis.
    expect(result.apValues).toEqual([-10, -5, 0, 5, 10])
    expect(result.mlValues).toEqual([-10, -5, 0, 5, 10])
    expect(result.totalCount).toBe(25)
    expect(result.samples).toHaveLength(25)
  })

  it('finds everything feasible with no obstacles', () => {
    const { object, built, bvh } = objective()
    const result = sweepAngles(object, built, bvh, [], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: -10,
      apToDeg: 10,
      mlFromDeg: -10,
      mlToDeg: 10,
      stepDeg: 10,
    })
    expect(result.feasibleCount).toBe(result.totalCount)
    expect(result.samples.every((s) => s.state === 'safe')).toBe(true)
  })

  it('blocks the side an obstacle sits on', () => {
    // A tall wall out to the animal's right. Note the sense: the objective
    // pivots about its focal point, so tilting its *axis* to the right swings
    // its *body* to the left. A wall at +x is therefore hit by NEGATIVE ML
    // tilt, which is exactly the kind of thing this sweep exists to reveal.
    const { object, built, bvh } = objective()
    const wall = obstacle('headbar', [2, 60, 60], [22, 20, 0])

    const result = sweepAngles(object, built, bvh, [wall], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: 0,
      apToDeg: 0,
      mlFromDeg: -40,
      mlToDeg: 40,
      stepDeg: 10,
    })

    const at = (ml: number) => result.samples.find((s) => s.mlTiltDeg === ml)!
    expect(at(-40).state).toBe('collision')
    expect(at(40).state).toBe('safe')
  })

  it('names the limiting obstacle', () => {
    const { object, built, bvh } = objective()
    const wall = obstacle('headbar', [2, 60, 60], [22, 20, 0])

    const result = sweepAngles(object, built, bvh, [wall], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: 0,
      apToDeg: 0,
      mlFromDeg: -40,
      mlToDeg: -40,
      stepDeg: 10,
    })
    expect(result.samples[0]!.limitingLabel).toBe('headbar')
  })

  it('reports a traversable span, not the extremes of scattered islands', () => {
    // Two walls leave a clear corridor in the middle. A range quoted from the
    // outermost feasible samples would describe a sweep straight through them.
    const { object, built, bvh } = objective()
    const right = obstacle('right-wall', [2, 60, 60], [22, 20, 0])
    const left = obstacle('left-wall', [2, 60, 60], [-22, 20, 0])

    const result = sweepAngles(
      object,
      built,
      bvh,
      [right, left],
      DEFAULT_COLLISION_SETTINGS,
      { apFromDeg: 0, apToDeg: 0, mlFromDeg: -40, mlToDeg: 40, stepDeg: 10 },
    )

    expect(result.allowedMlDeg).not.toBeNull()
    const [lo, hi] = result.allowedMlDeg!

    // The span must contain the current pose (0°) and every sample inside it
    // must actually be feasible.
    expect(lo).toBeLessThanOrEqual(0)
    expect(hi).toBeGreaterThanOrEqual(0)
    for (const sample of result.samples) {
      if (sample.mlTiltDeg >= lo && sample.mlTiltDeg <= hi) {
        expect(sample.state).toBe('safe')
      }
    }
  })

  it('reports no allowed range when the current pose is boxed in', () => {
    const { object, built, bvh } = objective()
    // Sized so the objective always pokes through a face of the box; see the
    // containment limitation test below for why full enclosure is different.
    const cage = obstacle('cage', [60, 60, 60], [0, 0, 0])

    const result = sweepAngles(object, built, bvh, [cage], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: -10,
      apToDeg: 10,
      mlFromDeg: -10,
      mlToDeg: 10,
      stepDeg: 10,
    })

    expect(result.feasibleCount).toBe(0)
    expect(result.allowedMlDeg).toBeNull()
    expect(result.allowedApDeg).toBeNull()
  })

  it('never mutates the object it is sweeping', () => {
    // The sweep evaluates hypothetical poses; the scene the user is looking at
    // must be untouched.
    const { object, built, bvh } = objective()
    const before = { ...object.orientation }

    sweepAngles(object, built, bvh, [], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: -20,
      apToDeg: 20,
      mlFromDeg: -20,
      mlToDeg: 20,
      stepDeg: 10,
    })

    expect(object.orientation).toEqual(before)
  })

  it('keeps the objective roll fixed across the sweep', () => {
    // Roll aims a prism's imaging face; a sweep over approach angles must not
    // silently spin it.
    const { object, built, bvh } = objective()
    object.orientation = { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 33 }

    const result = sweepAngles(object, built, bvh, [], DEFAULT_COLLISION_SETTINGS, {
      apFromDeg: 0,
      apToDeg: 0,
      mlFromDeg: 0,
      mlToDeg: 0,
      stepDeg: 5,
    })
    expect(result.samples).toHaveLength(1)
    expect(object.orientation.rollDeg).toBe(33)
  })

  it('completes a realistic grid quickly enough to be usable', () => {
    const { object, built, bvh } = objective()
    const wall = obstacle('headbar', [2, 60, 60], [22, 20, 0])

    const result = sweepAngles(object, built, bvh, [wall], DEFAULT_COLLISION_SETTINGS, {
      ...DEFAULT_SWEEP_RANGE,
      stepDeg: 10,
    })
    expect(result.totalCount).toBe(49)
    expect(result.elapsedMs).toBeLessThan(4000)
  })
})

describe('formatRange', () => {
  it('formats a span', () => {
    expect(formatRange([-12.1, 18.4])).toBe('-12.1° to 18.4°')
  })

  it('says none when nothing is feasible', () => {
    expect(formatRange(null)).toBe('none')
  })
})
