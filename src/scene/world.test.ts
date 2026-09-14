/**
 * Tests for the atlas-to-world transform.
 *
 * If this matrix is wrong, the 3D view and the numeric readouts disagree — and
 * the 3D view is the one users trust on sight. So the transform is checked
 * against real landmark geometry, not just algebraic identities.
 */

import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { voxelToStereotaxic } from '../atlas/coords.ts'
import { ALLEN_CCFV3_50UM, PERENS_STEREOTAXIC_MRI } from '../atlas/profile.ts'
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

/**
 * The two routes from a voxel to the screen must agree.
 *
 * Anatomy — meshes, projection clouds — reaches world space through
 * `atlasToWorldMatrix`. Numbers the user reads and dials into a stereotax —
 * coordinates, region labels, the injection marker — go through
 * `voxelToStereotaxic`. Nothing forced the two to match, and for a while they
 * did not: the profiles were declared `asr`, so `voxelToStereotaxic` negated
 * ML while the matrix did not, and the injection marker rendered in the
 * hemisphere opposite its own point cloud. Every other test passed throughout,
 * because each checked one route in isolation.
 */
describe('the two paths to world space agree', () => {
  const cases: readonly [string, number, number, number][] = [
    ['bregma', profile.bregma.i0, profile.bregma.i1, profile.bregma.i2],
    ['right of midline', 108, 20, 154],
    ['left of midline', 108, 20, 74],
    ['anterior and deep', 40, 90, 130],
    ['posterior and shallow', 220, 12, 90],
  ]

  it.each(cases)('%s', (_name, i0, i1, i2) => {
    const viaMatrix = toWorld(
      (i0 * profile.space.resolutionUm) / 1000,
      (i1 * profile.space.resolutionUm) / 1000,
      (i2 * profile.space.resolutionUm) / 1000,
    )
    const viaCoords = stereotaxicToWorld(voxelToStereotaxic(profile, { i0, i1, i2 }))

    expect(viaCoords.x).toBeCloseTo(viaMatrix.x, 6)
    expect(viaCoords.y).toBeCloseTo(viaMatrix.y, 6)
    expect(viaCoords.z).toBeCloseTo(viaMatrix.z, 6)
  })
})

describe('ML handedness', () => {
  // Settled against Allen connectivity injection hemispheres, 36/36; see
  // ML_HANDEDNESS_NOTE. An injection Allen labels right-hemisphere sits above
  // the midline on array axis 2, so axis 2 increases rightward.
  it.each([ALLEN_CCFV3_50UM, PERENS_STEREOTAXIC_MRI])(
    'has %# increasing on axis 2 toward the right',
    (p) => {
      const midline = p.bregma.i2
      const higher = voxelToStereotaxic(p, { i0: p.bregma.i0, i1: p.bregma.i1, i2: midline + 40 })
      expect(higher.ml).toBeGreaterThan(0)
    },
  )

  it('places a right-hemisphere connectivity injection at positive ML', () => {
    // Experiment 180296424 (VISp), which Allen labels hemisphere_id 2 = right.
    // Its injection voxels centre on CCF axis 2 at about 9040 um.
    const p = ALLEN_CCFV3_50UM
    const coord = voxelToStereotaxic(p, {
      i0: 9582 / p.space.resolutionUm,
      i1: 1924 / p.space.resolutionUm,
      i2: 9037 / p.space.resolutionUm,
    })
    expect(coord.ml).toBeGreaterThan(3)
  })
})
