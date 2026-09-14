/**
 * The single atlas-to-world transform.
 *
 * BrainCAD's world space is stereotaxic millimetres with bregma at the origin:
 *
 *   world +X = ML, toward the animal's right
 *   world +Y = DV, dorsal (up on screen)
 *   world +Z = AP, anterior
 *
 * Atlas mesh files arrive in CCF space, where the axes are ordered (AP, DV, ML)
 * and each runs the opposite way from the stereotaxic convention: CCF AP
 * increases posteriorly, CCF DV increases ventrally.
 *
 * Everything anatomical passes through this one matrix. Defining it once — and
 * testing it — is what lets the 3D view, the slice views and the numeric
 * readouts agree with each other.
 */

import { Matrix4, Vector3 } from 'three'

import type { Stereotaxic } from '../atlas/coords.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { arrayAxisFor } from '../atlas/space.ts'

/** Bregma's position in CCF millimetres, derived from the profile's landmark. */
export function bregmaCcfMm(profile: CoordinateProfile): Vector3 {
  const { space, bregma } = profile
  const byArrayAxis = [bregma.i0, bregma.i1, bregma.i2]
  const mm = (axis: 'AP' | 'DV' | 'ML') =>
    (byArrayAxis[arrayAxisFor(space, axis)]! * space.resolutionUm) / 1000

  // Mesh vertex order is (AP, DV, ML), matching the volume's array axes.
  return new Vector3(mm('AP'), mm('DV'), mm('ML'))
}

/**
 * Matrix mapping CCF mesh coordinates (in millimetres) to BrainCAD world space.
 *
 * The mapping is a permutation with two sign flips and a translation:
 *   world.x =  (ccf.z - bregma.z)   ML, right positive
 *   world.y = -(ccf.y - bregma.y)   DV, dorsal positive
 *   world.z = -(ccf.x - bregma.x)   AP, anterior positive
 */
export function atlasToWorldMatrix(profile: CoordinateProfile): Matrix4 {
  const b = bregmaCcfMm(profile)

  // Column-major constructor argument order is row-wise in three.js's `set`.
  return new Matrix4().set(
    0, 0, 1, -b.z,
    0, -1, 0, b.y,
    -1, 0, 0, b.x,
    0, 0, 0, 1,
  )
}

/**
 * World X of the volume's midline.
 *
 * Not assumed to be zero. It is exactly zero for the Allen profile, whose
 * bregma voxel sits on the midline, but the Perens profile places bregma at
 * voxel 227 of a 455-wide axis whose true centre is 227.5 — a 13 µm offset.
 * That is far below the voxel size and the published landmark SD, and mirroring
 * about the wrong axis by even that much is still avoidable, so it is not
 * hard-coded away.
 */
export function midlineWorldX(profile: CoordinateProfile): number {
  const { space } = profile
  const mlAxis = arrayAxisFor(space, 'ML')
  const midlineMm = (space.shape[mlAxis] * space.resolutionUm) / 2000
  return midlineMm - bregmaCcfMm(profile).z
}

/** Convert a stereotaxic coordinate to a world-space position. */
export function stereotaxicToWorld(coord: Stereotaxic): Vector3 {
  return new Vector3(coord.ml, coord.dv, coord.ap)
}

/** Convert a world-space position back to stereotaxic millimetres. */
export function worldToStereotaxic(position: Vector3): Stereotaxic {
  return { ml: position.x, dv: position.y, ap: position.z }
}
