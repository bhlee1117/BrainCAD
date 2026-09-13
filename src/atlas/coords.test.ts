/**
 * The landmark validation suite.
 *
 * This is the gate for every coordinate BrainCAD will ever display. A silent
 * sign flip or axis swap here would be invisible in the 3D view but would put
 * a pipette in the wrong hemisphere, so these assertions are deliberately
 * literal: they check published numbers, physical extents, and sign
 * conventions rather than re-deriving them from the same code under test.
 */

import { describe, expect, it } from 'vitest'

import {
  bregmaLambdaDistanceMm,
  componentDifferences,
  euclideanDistanceMm,
  formatStereotaxic,
  roundVoxel,
  stereotaxicToVoxel,
  voxelToStereotaxic,
} from './coords.ts'
import {
  ALLEN_CCFV3_50UM,
  BUILT_IN_PROFILES,
  PERENS_STEREOTAXIC_MRI,
  getProfile,
} from './profile.ts'
import {
  arrayAxisFor,
  extentMm,
  flatIndex,
  makeVolumeSpace,
  parseOrientation,
  voxelCount,
} from './space.ts'

describe('orientation parsing', () => {
  it('maps a BrainGlobe "asr" code onto AP/DV/ML array axes', () => {
    const axes = parseOrientation('asr')
    expect(axes.map((a) => a.axis)).toEqual(['AP', 'DV', 'ML'])
    expect(axes.map((a) => a.origin)).toEqual(['a', 's', 'r'])
  })

  it('rejects codes that do not name three distinct axes', () => {
    expect(() => parseOrientation('aas')).toThrow(/distinct/)
    expect(() => parseOrientation('as')).toThrow(/3 letters/)
    expect(() => parseOrientation('axr')).toThrow(/Invalid orientation letter/)
  })

  it('rejects nonsensical volume parameters', () => {
    expect(() => makeVolumeSpace([10, 10, 10], 0, 'asr')).toThrow(/positive/)
    expect(() => makeVolumeSpace([10, 0, 10], 25, 'asr')).toThrow(/positive integers/)
  })
})

describe('voxel array layout', () => {
  // NRRD stores the FIRST axis fastest. This was originally implemented as C
  // order, which scrambled anatomy without erroring — the olfactory bulb
  // appeared to span the whole volume. These assertions pin the layout.
  const space = makeVolumeSpace([4, 3, 5], 50, 'asr')

  it('advances by one element when the first axis increments', () => {
    expect(flatIndex(space, 0, 0, 0)).toBe(0)
    expect(flatIndex(space, 1, 0, 0)).toBe(1)
    expect(flatIndex(space, 3, 0, 0)).toBe(3)
  })

  it('strides by shape[0] on the second axis and shape[0]*shape[1] on the third', () => {
    expect(flatIndex(space, 0, 1, 0)).toBe(4)
    expect(flatIndex(space, 0, 0, 1)).toBe(12)
    expect(flatIndex(space, 3, 2, 4)).toBe(3 + 4 * (2 + 3 * 4))
  })

  it('covers exactly the voxel count with no collisions', () => {
    const seen = new Set<number>()
    for (let i2 = 0; i2 < 5; i2++)
      for (let i1 = 0; i1 < 3; i1++)
        for (let i0 = 0; i0 < 4; i0++) seen.add(flatIndex(space, i0, i1, i2))
    expect(seen.size).toBe(voxelCount(space))
    expect(Math.max(...seen)).toBe(voxelCount(space) - 1)
  })

  it('returns -1 outside the volume', () => {
    expect(flatIndex(space, -1, 0, 0)).toBe(-1)
    expect(flatIndex(space, 0, 3, 0)).toBe(-1)
    expect(flatIndex(space, 0, 0, 5)).toBe(-1)
  })
})

describe('physical extents identify the axes unambiguously', () => {
  // The mouse brain is ~13 mm AP, ~11 mm ML, ~8 mm DV. No two axes are close
  // enough in length to be confused, so extents independently confirm that the
  // orientation codes were interpreted correctly.

  it('Perens 25 µm volume has plausible mouse-head extents', () => {
    const s = PERENS_STEREOTAXIC_MRI.space
    expect(extentMm(s, 'AP')).toBeCloseTo(15.375, 3) // 615 * 25 µm
    expect(extentMm(s, 'DV')).toBeCloseTo(7.425, 3) // 297 * 25 µm
    expect(extentMm(s, 'ML')).toBeCloseTo(11.375, 3) // 455 * 25 µm

    // AP is the longest axis, DV the shortest — true of any mouse brain volume.
    expect(extentMm(s, 'AP')).toBeGreaterThan(extentMm(s, 'ML'))
    expect(extentMm(s, 'ML')).toBeGreaterThan(extentMm(s, 'DV'))
  })

  it('Allen CCFv3 50 µm volume has the documented 13.2 x 8.0 x 11.4 mm extents', () => {
    const s = ALLEN_CCFV3_50UM.space
    expect(extentMm(s, 'AP')).toBeCloseTo(13.2, 6)
    expect(extentMm(s, 'DV')).toBeCloseTo(8.0, 6)
    expect(extentMm(s, 'ML')).toBeCloseTo(11.4, 6)
  })
})

describe('Perens 2023 published landmarks', () => {
  const profile = PERENS_STEREOTAXIC_MRI

  it('places bregma at the coordinate origin', () => {
    const origin = voxelToStereotaxic(profile, profile.bregma)
    expect(origin.ap).toBeCloseTo(0, 10)
    expect(origin.ml).toBeCloseTo(0, 10)
    expect(origin.dv).toBeCloseTo(0, 10)
  })

  it('reproduces the published bregma-lambda distance of 4.80 mm', () => {
    // Perens et al. 2023: Δ(bregma, lambda) = 192 ± 5.94 voxels = 4.80 ± 0.15 mm
    const distance = bregmaLambdaDistanceMm(profile)
    expect(distance).not.toBeNull()
    expect(distance!).toBeCloseTo(4.8, 6)
  })

  it('puts lambda posterior to bregma, at the midline, at the same height', () => {
    const lambda = voxelToStereotaxic(profile, profile.lambda!)
    expect(lambda.ap).toBeLessThan(0) // posterior is negative AP
    expect(lambda.ap).toBeCloseTo(-4.8, 6)
    expect(lambda.ml).toBeCloseTo(0, 10) // on the sagittal midline
    expect(lambda.dv).toBeCloseTo(0, 10) // template levelled: same DV as bregma
  })

  it('places bregma on the ML midline of the volume', () => {
    // 455 ML voxels → midline at index 227; the paper reports x = 227.00.
    const mlAxis = arrayAxisFor(profile.space, 'ML')
    const midline = (profile.space.shape[mlAxis] - 1) / 2
    expect(Math.abs(profile.bregma.i2 - midline)).toBeLessThan(1)
  })

  it('places bregma near the dorsal surface, as a skull landmark must be', () => {
    const dvAxis = arrayAxisFor(profile.space, 'DV')
    expect(dvAxis).toBe(1)
    // 'asr' → axis 1 starts superior, so a small index is dorsal.
    expect(profile.bregma.i1).toBeLessThan(profile.space.shape[dvAxis] * 0.1)
  })
})

describe('sign conventions', () => {
  const profile = PERENS_STEREOTAXIC_MRI

  it('makes anterior positive and posterior negative', () => {
    const b = profile.bregma
    // 'asr' → increasing axis-0 index travels posteriorly.
    const posterior = voxelToStereotaxic(profile, { ...b, i0: b.i0 + 40 })
    const anterior = voxelToStereotaxic(profile, { ...b, i0: b.i0 - 40 })
    expect(posterior.ap).toBeCloseTo(-1.0, 6) // 40 * 25 µm = 1 mm
    expect(anterior.ap).toBeCloseTo(+1.0, 6)
  })

  it('makes dorsal positive, so brain targets sit at negative DV', () => {
    const b = profile.bregma
    // 'asr' → increasing axis-1 index travels ventrally.
    const deeper = voxelToStereotaxic(profile, { ...b, i1: b.i1 + 80 })
    expect(deeper.dv).toBeCloseTo(-2.0, 6)
    expect(deeper.dv).toBeLessThan(0)
  })

  it('is self-consistent in ML even though handedness is a profile choice', () => {
    // The template is left/right symmetric, so the volume cannot establish
    // handedness — the profile declares it and this test pins the declaration.
    const b = profile.bregma
    const a = voxelToStereotaxic(profile, { ...b, i2: b.i2 + 60 })
    const c = voxelToStereotaxic(profile, { ...b, i2: b.i2 - 60 })
    expect(Math.abs(a.ml)).toBeCloseTo(1.5, 6)
    expect(a.ml).toBeCloseTo(-c.ml, 10) // symmetric about the midline
  })
})

describe('round-tripping', () => {
  it.each(BUILT_IN_PROFILES.map((p) => [p.id, p] as const))(
    'voxel → stereotaxic → voxel is the identity for %s',
    (_id, profile) => {
      for (const voxel of [
        { i0: 100, i1: 40, i2: 150 },
        { i0: 0, i1: 0, i2: 0 },
        { i0: 260, i1: 120, i2: 60 },
      ]) {
        const round = stereotaxicToVoxel(profile, voxelToStereotaxic(profile, voxel))
        expect(round.i0).toBeCloseTo(voxel.i0, 8)
        expect(round.i1).toBeCloseTo(voxel.i1, 8)
        expect(round.i2).toBeCloseTo(voxel.i2, 8)
      }
    },
  )

  it('stereotaxic → voxel → stereotaxic is the identity', () => {
    const profile = PERENS_STEREOTAXIC_MRI
    for (const coord of [
      { ap: -2.0, ml: 1.5, dv: -1.35 }, // dorsal CA1, a common target
      { ap: 0, ml: 0, dv: 0 },
      { ap: 1.7, ml: -0.9, dv: -4.2 },
    ]) {
      const round = voxelToStereotaxic(profile, stereotaxicToVoxel(profile, coord))
      expect(round.ap).toBeCloseTo(coord.ap, 10)
      expect(round.ml).toBeCloseTo(coord.ml, 10)
      expect(round.dv).toBeCloseTo(coord.dv, 10)
    }
  })

  it('resolves a published CA1 coordinate to a voxel inside the volume', () => {
    const profile = PERENS_STEREOTAXIC_MRI
    const voxel = roundVoxel(stereotaxicToVoxel(profile, { ap: -2.0, ml: 1.5, dv: -1.35 }))
    expect(flatIndex(profile.space, voxel.i0, voxel.i1, voxel.i2)).toBeGreaterThanOrEqual(0)
  })
})

describe('measurement helpers', () => {
  it('computes Euclidean distance and per-axis components', () => {
    const a = { ap: 1, ml: 2, dv: -3 }
    const b = { ap: 1, ml: 2, dv: -3 }
    expect(euclideanDistanceMm(a, b)).toBe(0)

    const c = { ap: 0, ml: 0, dv: 0 }
    const d = { ap: 3, ml: 4, dv: 0 }
    expect(euclideanDistanceMm(c, d)).toBeCloseTo(5, 10)
    expect(componentDifferences(d, c)).toEqual({ ap: 3, ml: 4, dv: 0 })
  })

  it('formats coordinates to 10 µm and no finer', () => {
    // Landmark SDs are ~100 µm; more digits would overstate the precision.
    expect(formatStereotaxic({ ap: -2.0, ml: 1.5, dv: -1.3456 })).toBe(
      'AP -2.00  ML +1.50  DV -1.35 mm',
    )
  })
})

describe('profile integrity', () => {
  it('exposes provenance and caveats on every built-in profile', () => {
    for (const profile of BUILT_IN_PROFILES) {
      expect(profile.provenance.citation.length).toBeGreaterThan(20)
      expect(profile.provenance.caveats.length).toBeGreaterThan(0)
      expect(getProfile(profile.id)).toBe(profile)
    }
  })

  it('marks the Allen bregma as a convention rather than a measurement', () => {
    expect(ALLEN_CCFV3_50UM.provenance.confidence).toBe('community-convention')
    expect(PERENS_STEREOTAXIC_MRI.provenance.confidence).toBe('published')
  })

  it('throws on an unknown profile id rather than falling back to a default', () => {
    expect(() => getProfile('nope')).toThrow(/Unknown coordinate profile/)
  })

  it('has a sane voxel count for the Perens volume', () => {
    expect(voxelCount(PERENS_STEREOTAXIC_MRI.space)).toBe(615 * 297 * 455)
  })
})
