/**
 * Tests for the atlas-to-world transform.
 *
 * If this matrix is wrong, the 3D view and the numeric readouts disagree — and
 * the 3D view is the one users trust on sight. So the transform is checked
 * against real landmark geometry, not just algebraic identities.
 */

import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import {
  atlasToWorldMatrix,
  bregmaCcfMm,
  stereotaxicToWorld,
  worldToStereotaxic,
} from './world.ts'

const profile = ALLEN_CCFV3_50UM
const matrix = atlasToWorldMatrix(profile)

/** Apply the transform to a CCF point given in millimetres. */
function toWorld(apMm: number, dvMm: number, mlMm: number): Vector3 {
  return new Vector3(apMm, dvMm, mlMm).applyMatrix4(matrix)
}

describe('bregma in CCF millimetres', () => {
  it('matches the profile landmark', () => {
    const b = bregmaCcfMm(profile)
    expect(b.x).toBeCloseTo(5.4, 6) // AP: 108 voxels * 50 µm
    expect(b.y).toBeCloseTo(0.332, 6) // DV
    expect(b.z).toBeCloseTo(5.7, 6) // ML: 114 voxels * 50 µm
  })
})

describe('atlasToWorldMatrix', () => {
  it('sends bregma to the world origin', () => {
    const b = bregmaCcfMm(profile)
    const world = toWorld(b.x, b.y, b.z)
    expect(world.x).toBeCloseTo(0, 10)
    expect(world.y).toBeCloseTo(0, 10)
    expect(world.z).toBeCloseTo(0, 10)
  })

  it('puts anterior at +Z and posterior at -Z', () => {
    const b = bregmaCcfMm(profile)
    // CCF AP increases posteriorly.
    expect(toWorld(b.x + 2, b.y, b.z).z).toBeCloseTo(-2, 10)
    expect(toWorld(b.x - 2, b.y, b.z).z).toBeCloseTo(+2, 10)
  })

  it('puts dorsal at +Y and ventral at -Y', () => {
    const b = bregmaCcfMm(profile)
    // CCF DV increases ventrally.
    expect(toWorld(b.x, b.y + 3, b.z).y).toBeCloseTo(-3, 10)
    expect(toWorld(b.x, b.y - 1, b.z).y).toBeCloseTo(+1, 10)
  })

  it('puts the right hemisphere at +X', () => {
    const b = bregmaCcfMm(profile)
    expect(toWorld(b.x, b.y, b.z + 2.5).x).toBeCloseTo(+2.5, 10)
    expect(toWorld(b.x, b.y, b.z - 2.5).x).toBeCloseTo(-2.5, 10)
  })

  it('preserves distances, as a rigid transform must', () => {
    const a = toWorld(4, 2, 5)
    const b = toWorld(4 + 3, 2 + 4, 5)
    expect(a.distanceTo(b)).toBeCloseTo(5, 10)
  })

  it('maps the whole-brain bounding box to a sensible world extent', () => {
    // Root mesh bounds, from the built asset: AP 0-13.19, DV 0.13-7.56,
    // ML 0.49-10.89 mm.
    const min = toWorld(0, 0.134, 0.486)
    const max = toWorld(13.193, 7.564, 10.891)

    // Anterior pole must land in front of bregma, posterior pole behind it.
    expect(min.z).toBeGreaterThan(0)
    expect(max.z).toBeLessThan(0)
    // Brain sits below the bregma plane.
    expect(max.y).toBeLessThan(0)
    // Lateral extent straddles the midline.
    expect(min.x).toBeLessThan(0)
    expect(max.x).toBeGreaterThan(0)
  })
})

describe('stereotaxic <-> world', () => {
  it('round-trips', () => {
    const coord = { ap: -2.0, ml: 1.5, dv: -1.35 }
    expect(worldToStereotaxic(stereotaxicToWorld(coord))).toEqual(coord)
  })

  it('agrees with the matrix for a real target', () => {
    // A CA1 target expressed in CCF millimetres, transformed by the matrix,
    // must equal the same target placed directly in world space.
    const b = bregmaCcfMm(profile)
    const coord = { ap: -2.0, ml: 1.5, dv: -1.35 }
    const viaMatrix = toWorld(b.x + 2.0, b.y + 1.35, b.z + 1.5)
    const direct = stereotaxicToWorld(coord)

    expect(viaMatrix.x).toBeCloseTo(direct.x, 10)
    expect(viaMatrix.y).toBeCloseTo(direct.y, 10)
    expect(viaMatrix.z).toBeCloseTo(direct.z, 10)
  })
})
