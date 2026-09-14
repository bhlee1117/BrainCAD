/**
 * Objective-view geometry tests.
 *
 * The rendered image is presentation; the camera placement is the part that can
 * be silently wrong. A camera one working distance off, or aimed down the wrong
 * side of the axis, would produce a picture that looks entirely plausible and
 * shows the wrong thing — so the geometry is pinned here without needing a
 * WebGL context.
 */

import { describe, expect, it } from 'vitest'

import { makeObject } from '../objects/model.ts'
import { DEFAULT_OBJECTIVE, type ObjectiveParams } from '../objects/primitives.ts'
import { objectiveViewGeometry } from './objectiveView.ts'
import { stereotaxicToWorld } from '../scene/world.ts'
import type { Stereotaxic } from '../atlas/coords.ts'

function objective(
  target: Stereotaxic = { ap: -2, ml: 1.5, dv: -1.35 },
  params: Partial<ObjectiveParams> = {},
) {
  const object = makeObject('obj-1', 'objective', target)
  object.spec = {
    kind: 'objective',
    params: { ...DEFAULT_OBJECTIVE, ...params },
  }
  return object
}

describe('objectiveViewGeometry', () => {
  it('puts the focal point exactly on the target', () => {
    const target = { ap: -2, ml: 1.5, dv: -1.35 }
    const view = objectiveViewGeometry(objective(target))!
    const expected = stereotaxicToWorld(target)

    expect(view.focal.x).toBeCloseTo(expected.x, 9)
    expect(view.focal.y).toBeCloseTo(expected.y, 9)
    expect(view.focal.z).toBeCloseTo(expected.z, 9)
  })

  it('places the camera one working distance back along the axis', () => {
    const view = objectiveViewGeometry(objective())!
    expect(view.eye.distanceTo(view.focal)).toBeCloseTo(DEFAULT_OBJECTIVE.workingDistanceMm, 6)
  })

  it('places an unrotated objective directly above its focal point', () => {
    // Default pose points straight down, so the front element is dorsal of the
    // focus — not below it, which would put the camera inside the brain.
    const view = objectiveViewGeometry(objective())!
    expect(view.eye.y).toBeGreaterThan(view.focal.y)
    expect(view.eye.x).toBeCloseTo(view.focal.x, 9)
    expect(view.eye.z).toBeCloseTo(view.focal.z, 9)
  })

  it('looks along the optical axis, through the focal point', () => {
    const view = objectiveViewGeometry(objective())!
    const direction = view.lookAt.clone().sub(view.eye).normalize()

    expect(direction.x).toBeCloseTo(view.axis.x, 6)
    expect(direction.y).toBeCloseTo(view.axis.y, 6)
    expect(direction.z).toBeCloseTo(view.axis.z, 6)
  })

  it('aims beyond the focal plane so it is not clipped at the frustum edge', () => {
    const view = objectiveViewGeometry(objective())!
    expect(view.lookAt.distanceTo(view.eye)).toBeGreaterThan(
      view.focal.distanceTo(view.eye),
    )
  })

  it('follows the objective when it is tilted', () => {
    const tilted = objective()
    tilted.orientation = { apTiltDeg: 0, mlTiltDeg: 30, rollDeg: 0 }
    const view = objectiveViewGeometry(tilted)!

    // Focal point is unchanged — the objective pivots about it.
    const expected = stereotaxicToWorld(tilted.target)
    expect(view.focal.distanceTo(expected)).toBeCloseTo(0, 6)

    // The body swings opposite to where the axis points, so with the axis
    // tilted toward +ML the camera moves to -ML.
    expect(view.axis.x).toBeGreaterThan(0)
    expect(view.eye.x).toBeLessThan(view.focal.x)
    // Still one working distance away.
    expect(view.eye.distanceTo(view.focal)).toBeCloseTo(
      DEFAULT_OBJECTIVE.workingDistanceMm,
      6,
    )
  })

  it('honours a longer working distance', () => {
    const view = objectiveViewGeometry(objective(undefined, { workingDistanceMm: 8 }))!
    expect(view.eye.distanceTo(view.focal)).toBeCloseTo(8, 6)
    expect(view.workingDistanceMm).toBe(8)
  })

  it('reports the configured field of view', () => {
    const view = objectiveViewGeometry(objective(undefined, { fieldOfViewMm: 0.6 }))!
    expect(view.fieldOfViewMm).toBeCloseTo(0.6, 9)
  })

  it('refuses a degenerate field rather than rendering a zero-width frustum', () => {
    const view = objectiveViewGeometry(objective(undefined, { fieldOfViewMm: 0 }))!
    expect(view.fieldOfViewMm).toBeGreaterThan(0)
  })

  it('returns null for an object that is not a parametric objective', () => {
    // A custom import has no working distance, so there is no optical axis to
    // look down. Null must be read as "no view", never as "clear view".
    const custom = makeObject('obj-2', 'custom', { ap: 0, ml: 0, dv: 0 })
    expect(objectiveViewGeometry(custom)).toBeNull()
  })

  it('keeps the axis a unit vector under combined tilts', () => {
    const tilted = objective()
    tilted.orientation = { apTiltDeg: 17, mlTiltDeg: -23, rollDeg: 40 }
    const view = objectiveViewGeometry(tilted)!
    expect(view.axis.length()).toBeCloseTo(1, 9)
  })
})
