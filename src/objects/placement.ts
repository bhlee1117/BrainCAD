/**
 * Pivot-aware placement — the geometric core of BrainCAD's object model.
 *
 * Every object carries two distinct points in its own local space:
 *
 *   pivot   the point rotation happens around (a cannula's skull entry,
 *           an objective's focal point, a manipulator axis)
 *   anchor  the point that must end up at the chosen AP/ML/DV target
 *           (a pipette tip, a prism's imaging face, a cannula tip)
 *
 * They are frequently different, and conflating them is what makes implant
 * planning fiddly in general-purpose CAD. Keeping them separate turns the
 * whole problem into one small solve, implemented in `solvePlacement` below.
 */

import { Euler, Matrix4, Quaternion, Vector3 } from 'three'

import type { Stereotaxic } from '../atlas/coords.ts'
import { stereotaxicToWorld } from '../scene/world.ts'

/**
 * World axes, named anatomically.
 *
 * World space is stereotaxic millimetres: +X right (ML), +Y dorsal (DV),
 * +Z anterior (AP). See src/scene/world.ts.
 */
export const AXIS_ML = new Vector3(1, 0, 0)
export const AXIS_DV = new Vector3(0, 1, 0)
export const AXIS_AP = new Vector3(0, 0, 1)

/**
 * Object orientation, in the terms a stereotaxic manipulator uses.
 *
 * For an instrument whose default pose points straight down (-DV), these map
 * onto the physical adjustments an experimenter actually makes:
 *
 *   apTiltDeg  tilt within the sagittal plane — rotation about the ML axis.
 *              Positive swings the tip anteriorly.
 *   mlTiltDeg  tilt within the coronal plane — rotation about the AP axis.
 *              Positive swings the tip toward the animal's right.
 *   rollDeg    spin about the instrument's own long axis. Geometrically
 *              irrelevant for a cylinder, but essential for a prism, whose
 *              imaging face must point somewhere specific.
 */
export interface Orientation {
  readonly apTiltDeg: number
  readonly mlTiltDeg: number
  readonly rollDeg: number
}

export const NO_ROTATION: Orientation = { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 0 }

const DEG = Math.PI / 180

/**
 * Compose an orientation into a quaternion.
 *
 * Order is fixed and deliberate: roll is applied first, in the object's own
 * frame, then ML tilt, then AP tilt. Because the two tilts are applied about
 * fixed world axes afterwards, changing roll never changes where the
 * instrument points — it only spins it about its own axis. That is the
 * behaviour an experimenter expects from a manipulator, and it is the reason
 * the order is not left to an Euler default.
 */
export function orientationToQuaternion(orientation: Orientation): Quaternion {
  const roll = new Quaternion().setFromAxisAngle(AXIS_DV, orientation.rollDeg * DEG)
  const mlTilt = new Quaternion().setFromAxisAngle(AXIS_AP, orientation.mlTiltDeg * DEG)
  // Negated: a positive rotation about +ML would swing a downward-pointing
  // instrument posteriorly, but +AP means anterior everywhere else in
  // BrainCAD. Keeping the sign consistent matters more here than matching the
  // raw right-hand rule, since the number is shown to the user beside AP
  // coordinates that use the opposite sense.
  const apTilt = new Quaternion().setFromAxisAngle(AXIS_ML, -orientation.apTiltDeg * DEG)

  return apTilt.multiply(mlTilt).multiply(roll)
}

/** Euler form of the same rotation, for three.js objects that want one. */
export function orientationToEuler(orientation: Orientation): Euler {
  return new Euler().setFromQuaternion(orientationToQuaternion(orientation))
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Recover tilt angles from a quaternion — the inverse of
 * {@link orientationToQuaternion}.
 *
 * Needed because a rotation gizmo hands back an arbitrary quaternion, but the
 * properties panel, the planning sheet and the surgeon's manipulator all speak
 * in AP tilt, ML tilt and roll. Without this, dragging the gizmo and typing a
 * number would be two different systems editing the same object.
 *
 * Derivation: applying the composed rotation to the default downward axis
 * gives `(sin ml, −cos ml·cos ap, cos ml·sin ap)`, which inverts directly for
 * the two tilts. Roll is then whatever rotation about the instrument's own
 * axis remains once both tilts are removed.
 */
export function quaternionToOrientation(q: Quaternion): Orientation {
  const axis = new Vector3(0, -1, 0).applyQuaternion(q)

  const mlTilt = Math.asin(clamp(axis.x, -1, 1))

  // At |ML tilt| = 90° the instrument points sideways and AP tilt becomes
  // degenerate — it and roll describe the same motion. Pinning AP to zero
  // there keeps the readout stable instead of letting it jump around.
  const degenerate = Math.abs(Math.cos(mlTilt)) < 1e-6
  const apTilt = degenerate ? 0 : Math.atan2(axis.z, -axis.y)

  const apQ = new Quaternion().setFromAxisAngle(AXIS_ML, -apTilt)
  const mlQ = new Quaternion().setFromAxisAngle(AXIS_AP, mlTilt)
  const remaining = mlQ.invert().multiply(apQ.invert()).multiply(q)

  const roll = 2 * Math.atan2(remaining.y, remaining.w)

  return {
    apTiltDeg: apTilt / DEG,
    mlTiltDeg: mlTilt / DEG,
    rollDeg: normaliseDegrees(roll / DEG),
  }
}

/** Fold an angle into (−180, 180] so the panel never shows 350° for −10°. */
export function normaliseDegrees(deg: number): number {
  let value = deg % 360
  if (value > 180) value -= 360
  if (value <= -180) value += 360
  // Squash negative zero, which would render as "-0.0".
  return value === 0 ? 0 : value
}

export interface Placement {
  /** World-space translation to apply to the object's group. */
  readonly position: Vector3
  readonly quaternion: Quaternion
}

/**
 * Solve for the object transform that rotates about `pivotLocal` and lands
 * `anchorLocal` exactly on `target`.
 *
 * The object's world transform is
 *
 *     world(x) = t + p + R·(x − p)
 *
 * — rotate about the pivot, then translate. Requiring `world(anchor) = target`
 * gives the whole solve in one line:
 *
 *     t = target − p − R·(anchor − p)
 *
 * With no rotation this collapses to `t = target − anchor`, and when pivot and
 * anchor coincide it collapses to rotation about the target itself. Both are
 * asserted in the tests.
 */
export function solvePlacement(
  anchorLocal: Vector3,
  pivotLocal: Vector3,
  orientation: Orientation,
  target: Stereotaxic,
): Placement {
  const quaternion = orientationToQuaternion(orientation)
  const targetWorld = stereotaxicToWorld(target)

  const rotated = anchorLocal.clone().sub(pivotLocal).applyQuaternion(quaternion)
  const position = targetWorld.clone().sub(pivotLocal).sub(rotated)

  return { position, quaternion }
}

/**
 * Full object-to-world matrix for a solved placement.
 *
 * Mirrors how the scene graph is assembled at render time (a positioned,
 * rotated group containing a mesh offset by −pivot), so tests can verify the
 * matrix and the rendered hierarchy agree.
 */
export function placementMatrix(placement: Placement, pivotLocal: Vector3): Matrix4 {
  return new Matrix4()
    .makeTranslation(placement.position.x, placement.position.y, placement.position.z)
    .multiply(new Matrix4().makeRotationFromQuaternion(placement.quaternion))
    .multiply(new Matrix4().makeTranslation(-pivotLocal.x, -pivotLocal.y, -pivotLocal.z))
    .premultiply(
      new Matrix4().makeTranslation(pivotLocal.x, pivotLocal.y, pivotLocal.z),
    )
}

/**
 * Where a local-space point ends up in world space under a placement.
 *
 * Used for entry points, tip positions and the trajectory readout, so those
 * numbers come from the same transform that positions the visible geometry
 * rather than a parallel calculation that can drift from it.
 */
export function localToWorld(
  pointLocal: Vector3,
  placement: Placement,
  pivotLocal: Vector3,
): Vector3 {
  return pointLocal
    .clone()
    .sub(pivotLocal)
    .applyQuaternion(placement.quaternion)
    .add(pivotLocal)
    .add(placement.position)
}

/**
 * The instrument's axis direction in world space.
 *
 * `axisLocal` is the direction the instrument points in its own frame —
 * conventionally -DV, straight down — so this is the insertion or optical
 * axis after the object has been oriented.
 */
export function worldAxis(axisLocal: Vector3, orientation: Orientation): Vector3 {
  return axisLocal.clone().normalize().applyQuaternion(orientationToQuaternion(orientation))
}

/**
 * Angle of an insertion axis away from straight-down, in degrees.
 *
 * Reported in the trajectory panel because a manipulator's dial angles do not
 * directly tell you how oblique the final approach is once both tilts combine.
 */
export function angleFromVerticalDeg(orientation: Orientation): number {
  const axis = worldAxis(new Vector3(0, -1, 0), orientation)
  const cos = Math.min(1, Math.max(-1, axis.dot(new Vector3(0, -1, 0))))
  return Math.acos(cos) / DEG
}
