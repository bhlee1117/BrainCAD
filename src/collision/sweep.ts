/**
 * Objective approach-angle sweep (blueprint §12).
 *
 * Sweeps a grid of AP/ML tilts, checks clearance at each pose, and reports the
 * feasible region plus the limiting object. Because the objective's anchor is
 * its focal point and the pivot defaults to the same point, rotating it sweeps
 * the barrel around a fixed focus — which is exactly the question being asked:
 * *from which directions can I reach this spot?*
 *
 * This is the payoff for keeping collision as pure functions. A sweep is just
 * the same pair check run over a grid, with the object's matrix recomputed per
 * pose — no new geometry code.
 */

import { Matrix4 } from 'three'

import { effectivePivot, type SceneObject } from '../objects/model.ts'
import { orientationToQuaternion, solvePlacement, type Orientation } from '../objects/placement.ts'
import type { BuiltPrimitive } from '../objects/primitives.ts'
import {
  checkPair,
  worseOf,
  type CollisionMesh,
  type CollisionSettings,
  type CollisionState,
} from './check.ts'

export interface SweepRange {
  /** Inclusive AP tilt bounds, degrees. */
  apFromDeg: number
  apToDeg: number
  /** Inclusive ML tilt bounds, degrees. */
  mlFromDeg: number
  mlToDeg: number
  /** Grid spacing, degrees. */
  stepDeg: number
}

export const DEFAULT_SWEEP_RANGE: SweepRange = {
  apFromDeg: -30,
  apToDeg: 30,
  mlFromDeg: -30,
  mlToDeg: 30,
  stepDeg: 5,
}

export interface SweepSample {
  readonly apTiltDeg: number
  readonly mlTiltDeg: number
  readonly state: CollisionState
  /** Minimum clearance at this pose, when one could be measured. */
  readonly clearanceMm: number | null
  /** Which mesh was closest or collided. */
  readonly limitingLabel: string | null
}

export interface SweepResult {
  readonly samples: readonly SweepSample[]
  readonly range: SweepRange
  readonly apValues: readonly number[]
  readonly mlValues: readonly number[]
  /** Largest contiguous safe span through the current pose, in degrees. */
  readonly allowedApDeg: readonly [number, number] | null
  readonly allowedMlDeg: readonly [number, number] | null
  readonly feasibleCount: number
  readonly totalCount: number
  readonly elapsedMs: number
}

function axisValues(from: number, to: number, step: number): number[] {
  const values: number[] = []
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const size = Math.max(0.5, step)
  for (let v = lo; v <= hi + 1e-9; v += size) values.push(Number(v.toFixed(4)))
  return values
}

/**
 * World matrix for an object at a hypothetical orientation.
 *
 * Kept separate from the live object so a sweep never mutates the scene the
 * user is looking at.
 */
function matrixForPose(
  object: SceneObject,
  built: BuiltPrimitive,
  orientation: Orientation,
): Matrix4 {
  const pivot = effectivePivot(object, built)
  const placement = solvePlacement(built.anchor, pivot, orientation, object.target)
  return new Matrix4()
    .makeRotationFromQuaternion(orientationToQuaternion(orientation))
    .setPosition(placement.position)
}

/**
 * Run the sweep.
 *
 * `obstacles` is every mesh the objective must avoid — anatomy, headbar,
 * implants, other hardware — already prepared with BVHs.
 */
export function sweepAngles(
  object: SceneObject,
  built: BuiltPrimitive,
  bvh: CollisionMesh['bvh'],
  obstacles: readonly CollisionMesh[],
  settings: CollisionSettings,
  range: SweepRange = DEFAULT_SWEEP_RANGE,
): SweepResult {
  const started = Date.now()
  const apValues = axisValues(range.apFromDeg, range.apToDeg, range.stepDeg)
  const mlValues = axisValues(range.mlFromDeg, range.mlToDeg, range.stepDeg)
  const samples: SweepSample[] = []

  for (const apTiltDeg of apValues) {
    for (const mlTiltDeg of mlValues) {
      const orientation: Orientation = {
        apTiltDeg,
        mlTiltDeg,
        rollDeg: object.orientation.rollDeg,
      }

      const moving: CollisionMesh = {
        id: object.id,
        label: object.name,
        geometry: built.geometry,
        bvh,
        matrixWorld: matrixForPose(object, built, orientation),
        kind: 'hardware',
      }

      let state: CollisionState = 'safe'
      let clearanceMm: number | null = null
      let limitingLabel: string | null = null

      for (const obstacle of obstacles) {
        const result = checkPair(moving, obstacle, settings)
        state = worseOf(state, result.state)

        if (result.clearanceMm !== null) {
          if (clearanceMm === null || result.clearanceMm < clearanceMm) {
            clearanceMm = result.clearanceMm
            limitingLabel = obstacle.label
          }
        }
        if (result.state === 'collision') {
          limitingLabel = obstacle.label
          clearanceMm = null
          break
        }
      }

      samples.push({ apTiltDeg, mlTiltDeg, state, clearanceMm, limitingLabel })
    }
  }

  const current = {
    ap: object.orientation.apTiltDeg,
    ml: object.orientation.mlTiltDeg,
  }

  return {
    samples,
    range,
    apValues,
    mlValues,
    allowedApDeg: contiguousSpan(samples, apValues, 'apTiltDeg', 'mlTiltDeg', current.ml),
    allowedMlDeg: contiguousSpan(samples, mlValues, 'mlTiltDeg', 'apTiltDeg', current.ap),
    feasibleCount: samples.filter((s) => s.state === 'safe').length,
    totalCount: samples.length,
    elapsedMs: Date.now() - started,
  }
}

/**
 * The contiguous run of feasible angles along one axis, through the slice
 * nearest the object's current pose on the other axis.
 *
 * Reported as a contiguous span rather than min-to-max of all feasible samples,
 * because a range quoted as "-12° to +18°" must actually be traversable. Two
 * separated feasible islands summarised as one range would describe a path
 * straight through an obstacle.
 */
function contiguousSpan(
  samples: readonly SweepSample[],
  values: readonly number[],
  axis: 'apTiltDeg' | 'mlTiltDeg',
  otherAxis: 'apTiltDeg' | 'mlTiltDeg',
  otherValue: number,
): readonly [number, number] | null {
  if (values.length === 0) return null

  // Snap to the sampled slice closest to where the objective currently sits.
  let nearest = samples[0]![otherAxis]
  for (const sample of samples) {
    if (Math.abs(sample[otherAxis] - otherValue) < Math.abs(nearest - otherValue)) {
      nearest = sample[otherAxis]
    }
  }

  const slice = values
    .map((value) =>
      samples.find(
        (s) => s[axis] === value && Math.abs(s[otherAxis] - nearest) < 1e-9,
      ),
    )
    .filter((s): s is SweepSample => s !== undefined)

  if (slice.length === 0) return null

  // Find the feasible run containing (or nearest to) the current angle.
  const currentIndex = slice.reduce(
    (best, sample, index) =>
      Math.abs(sample[axis] - (axis === 'apTiltDeg' ? otherValue : otherValue)) <
      Math.abs(slice[best]![axis] - otherValue)
        ? index
        : best,
    0,
  )

  const start = slice[currentIndex]?.state === 'safe' ? currentIndex : findFirstSafe(slice)
  if (start < 0) return null

  let lo = start
  let hi = start
  while (lo - 1 >= 0 && slice[lo - 1]!.state === 'safe') lo--
  while (hi + 1 < slice.length && slice[hi + 1]!.state === 'safe') hi++

  return [slice[lo]![axis], slice[hi]![axis]]
}

function findFirstSafe(slice: readonly SweepSample[]): number {
  return slice.findIndex((s) => s.state === 'safe')
}

/** Format an allowed range for display. */
export function formatRange(range: readonly [number, number] | null): string {
  if (!range) return 'none'
  return `${range[0].toFixed(1)}° to ${range[1].toFixed(1)}°`
}
