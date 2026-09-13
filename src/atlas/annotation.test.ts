/**
 * Tests for the annotation volume and the template-space guard.
 *
 * The guard test matters more than it looks: pairing a coordinate profile with
 * the wrong template volume is the one error in BrainCAD that produces
 * confident, plausible, completely wrong coordinates.
 */

import { describe, expect, it } from 'vitest'

import { AnnotationVolume, UNLABELLED, colorizeSlice } from './annotation.ts'
import {
  ALLEN_CCFV3_50UM,
  PERENS_STEREOTAXIC_MRI,
  assertProfileMatchesSpace,
  profileMatchesSpace,
  profilesForSpace,
} from './profile.ts'
import { makeVolumeSpace } from './space.ts'
import { buildColorTable, buildIndex, searchStructures, type Structure } from './ontology.ts'

/** A tiny synthetic volume so slice geometry can be reasoned about by hand. */
function makeTestVolume() {
  // 4 AP x 3 DV x 5 ML, 100 µm, 'asr' like the real assets.
  const space = makeVolumeSpace([4, 3, 5], 100, 'asr')
  const labels = new Uint32Array(4 * 3 * 5)
  // Encode position into the label so slices are checkable: i0*100 + i1*10 + i2.
  // Written through the same column-major layout the real NRRD assets use.
  for (let i0 = 0; i0 < 4; i0++) {
    for (let i1 = 0; i1 < 3; i1++) {
      for (let i2 = 0; i2 < 5; i2++) {
        labels[i0 + 4 * (i1 + 3 * i2)] = i0 * 100 + i1 * 10 + i2
      }
    }
  }
  return new AnnotationVolume(space, labels)
}

describe('template-space guard', () => {
  it('accepts a profile that describes the loaded volume', () => {
    expect(profileMatchesSpace(ALLEN_CCFV3_50UM, ALLEN_CCFV3_50UM.space)).toBe(true)
    expect(() =>
      assertProfileMatchesSpace(ALLEN_CCFV3_50UM, ALLEN_CCFV3_50UM.space),
    ).not.toThrow()
  })

  it('rejects the Perens profile against the Allen volume', () => {
    // Both are real mouse-brain profiles; only their template spaces differ.
    expect(profileMatchesSpace(PERENS_STEREOTAXIC_MRI, ALLEN_CCFV3_50UM.space)).toBe(false)
    expect(() =>
      assertProfileMatchesSpace(PERENS_STEREOTAXIC_MRI, ALLEN_CCFV3_50UM.space),
    ).toThrow(/Refusing to mix template spaces/)
  })

  it('offers only the profiles valid for a given volume', () => {
    const allen = profilesForSpace(ALLEN_CCFV3_50UM.space)
    expect(allen).toHaveLength(1)
    expect(allen[0]!.id).toBe(ALLEN_CCFV3_50UM.id)

    const perens = profilesForSpace(PERENS_STEREOTAXIC_MRI.space)
    expect(perens.map((p) => p.id)).toEqual([PERENS_STEREOTAXIC_MRI.id])
  })
})

describe('AnnotationVolume', () => {
  it('rejects a label array that does not match its space', () => {
    const space = makeVolumeSpace([4, 3, 5], 100, 'asr')
    expect(() => new AnnotationVolume(space, new Uint32Array(10))).toThrow(/size mismatch/)
  })

  it('reads labels at voxel positions and returns UNLABELLED out of bounds', () => {
    const volume = makeTestVolume()
    expect(volume.labelAtVoxel(2, 1, 3)).toBe(213)
    expect(volume.labelAtVoxel(0, 0, 0)).toBe(0)
    expect(volume.labelAtVoxel(-1, 0, 0)).toBe(UNLABELLED)
    expect(volume.labelAtVoxel(99, 0, 0)).toBe(UNLABELLED)
  })

  it('extracts a coronal slice with ML across and DV down', () => {
    const volume = makeTestVolume()
    const slice = volume.extractSlice('AP', 2)

    expect(slice.horizontalAxis).toBe('ML')
    expect(slice.verticalAxis).toBe('DV')
    expect(slice.width).toBe(5) // ML voxels
    expect(slice.height).toBe(3) // DV voxels

    // Every pixel comes from AP index 2, so labels are in the 2xx range.
    for (const label of slice.labels) {
      expect(Math.floor(label / 100)).toBe(2)
    }

    // 'asr' axis 1 starts superior, and dorsal renders at the top, so image
    // row 0 must be DV voxel 0.
    expect(Math.floor((slice.labels[0]! % 100) / 10)).toBe(0)
    expect(Math.floor((slice.labels[2 * 5]! % 100) / 10)).toBe(2)
  })

  it('returns an empty slice rather than throwing when out of range', () => {
    const volume = makeTestVolume()
    const slice = volume.extractSlice('AP', 99)
    expect(slice.width).toBe(5)
    expect(slice.labels.every((l) => l === UNLABELLED)).toBe(true)
  })

  it('extracts sagittal and horizontal slices with the documented axes', () => {
    const volume = makeTestVolume()

    const sagittal = volume.extractSlice('ML', 2)
    expect(sagittal.horizontalAxis).toBe('AP')
    expect(sagittal.verticalAxis).toBe('DV')
    expect(sagittal.width).toBe(4)
    expect(sagittal.height).toBe(3)

    const horizontal = volume.extractSlice('DV', 1)
    expect(horizontal.horizontalAxis).toBe('ML')
    expect(horizontal.verticalAxis).toBe('AP')
    expect(horizontal.width).toBe(5)
    expect(horizontal.height).toBe(4)
  })

  it('reports contiguous structure runs along a trajectory', () => {
    // A volume split into two labelled blocks along AP.
    const space = makeVolumeSpace([10, 1, 1], 100, 'asr')
    const labels = new Uint32Array(10)
    labels.fill(7, 0, 5)
    labels.fill(9, 5, 10)
    const volume = new AnnotationVolume(space, labels)

    const profile = {
      ...ALLEN_CCFV3_50UM,
      space,
      bregma: { i0: 0, i1: 0, i2: 0 },
    }

    const runs = volume.structuresAlong(
      profile,
      { ap: 0, ml: 0, dv: 0 },
      { ap: -0.9, ml: 0, dv: 0 },
    )
    expect(runs.map((r) => r.id)).toEqual([7, 9])
    expect(runs[0]!.entryMm).toBeCloseTo(0, 6)
    expect(runs[1]!.exitMm).toBeCloseTo(0.9, 6)
  })

  it('finds the first labelled point along a ray, or null when there is none', () => {
    const space = makeVolumeSpace([10, 1, 1], 100, 'asr')
    const labels = new Uint32Array(10)
    labels.fill(42, 4, 10)
    const volume = new AnnotationVolume(space, labels)
    const profile = { ...ALLEN_CCFV3_50UM, space, bregma: { i0: 0, i1: 0, i2: 0 } }

    const hit = volume.firstLabelledPoint(
      profile,
      { ap: 0, ml: 0, dv: 0 },
      { ap: -0.9, ml: 0, dv: 0 },
    )
    expect(hit).not.toBeNull()
    expect(hit!.id).toBe(42)
    // Sampling rounds to the nearest voxel, so the labelled block starting at
    // voxel 4 is first detected at voxel 3.5 — half a voxel (0.05 mm) earlier.
    expect(hit!.distanceMm).toBeCloseTo(0.35, 2)

    const empty = new AnnotationVolume(space, new Uint32Array(10))
    expect(
      empty.firstLabelledPoint(profile, { ap: 0, ml: 0, dv: 0 }, { ap: -0.9, ml: 0, dv: 0 }),
    ).toBeNull()
  })
})

describe('ontology', () => {
  const structures: Structure[] = [
    { id: 997, acronym: 'root', name: 'root', colorHex: 'FFFFFF', parentId: null, path: [997], depth: 0 },
    { id: 8, acronym: 'grey', name: 'Basic cell groups and regions', colorHex: 'BFDAE3', parentId: 997, path: [997, 8], depth: 1 },
    { id: 1089, acronym: 'HPF', name: 'Hippocampal formation', colorHex: '7ED04B', parentId: 8, path: [997, 8, 1089], depth: 2 },
    { id: 382, acronym: 'CA1', name: 'Field CA1', colorHex: '7ED04B', parentId: 1089, path: [997, 8, 1089, 382], depth: 3 },
  ]
  const index = buildIndex(structures)

  it('ranks an exact acronym match above longer names containing it', () => {
    const results = searchStructures(index, 'CA1')
    expect(results[0]!.id).toBe(382)
  })

  it('finds structures by name fragment', () => {
    expect(searchStructures(index, 'hippocampal')[0]!.acronym).toBe('HPF')
  })

  it('returns nothing for an empty query', () => {
    expect(searchStructures(index, '   ')).toEqual([])
  })

  it('builds a colour table keyed by structure id', () => {
    const table = buildColorTable(index)
    expect(table.size).toBe(structures.length)
    // CA1 is 7ED04B, packed little-endian RGBA.
    expect(table.get(382)).toBe(((255 << 24) | (0x4b << 16) | (0xd0 << 8) | 0x7e) >>> 0)
  })

  it('stays small even when structure ids are enormous', () => {
    // Real Allen ids reach 614,454,277. A table indexed by id would need
    // 2.4 GB — which is exactly how the original dense implementation failed
    // on real data after passing tests built on small fixture ids.
    const sparse = buildIndex([
      ...structures,
      {
        id: 614454277,
        acronym: 'BIG',
        name: 'Structure with a very large id',
        colorHex: '112233',
        parentId: 997,
        path: [997, 614454277],
        depth: 1,
      },
    ])
    const table = buildColorTable(sparse)
    expect(table.size).toBe(structures.length + 1)
    expect(table.get(614454277)).toBe(((255 << 24) | (0x33 << 16) | (0x22 << 8) | 0x11) >>> 0)
  })

  it('colourises a slice, leaving unlabelled voxels transparent', () => {
    const table = buildColorTable(index)
    const slice = {
      width: 2,
      height: 1,
      labels: new Uint32Array([382, UNLABELLED]),
      horizontalAxis: 'ML' as const,
      verticalAxis: 'DV' as const,
    }
    const pixels = colorizeSlice(slice, table)
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([0x7e, 0xd0, 0x4b, 255])
    expect(pixels[7]).toBe(0) // alpha of the unlabelled pixel
  })

  it('leaves pixels transparent for ids absent from the table', () => {
    const table = buildColorTable(index)
    const slice = {
      width: 1,
      height: 1,
      labels: new Uint32Array([999999]),
      horizontalAxis: 'ML' as const,
      verticalAxis: 'DV' as const,
    }
    expect(colorizeSlice(slice, table)[3]).toBe(0)
  })
})
