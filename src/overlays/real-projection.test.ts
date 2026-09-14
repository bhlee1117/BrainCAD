/**
 * End-to-end validation against a real Allen connectivity volume.
 *
 * The unit tests prove the point cloud is built correctly from synthetic data.
 * This proves it lands on the right anatomy: it takes an actual projection
 * volume, builds the cloud, maps the densest voxel back through the coordinate
 * profile, and asks the annotation volume what structure is there.
 *
 * That check is the whole point of the overlay. A cloud registered half a
 * millimetre off, or with two axes transposed, would still look like a
 * plausible spray of axons over a brain — and would be wrong in exactly the way
 * that matters for planning.
 *
 * Fixture: experiment 100141219, projection_density at 100 µm, as served by
 * the Allen API.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AnnotationVolume, UNLABELLED } from '../atlas/annotation.ts'
import { voxelToStereotaxic } from '../atlas/coords.ts'
import { parseNrrd } from '../atlas/nrrd.ts'
import { buildIndex, isDescendantOf, type Structure } from '../atlas/ontology.ts'
import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import { makeVolumeSpace } from '../atlas/space.ts'
import { buildProjectionPointCloud } from './pointCloud.ts'

const FIXTURE = join(process.cwd(), 'test-fixtures', 'projection-100141219-100um.nrrd')
const ATLAS_DIR = join(process.cwd(), 'public', 'atlas')
const ANNOTATION = join(ATLAS_DIR, 'annotation_50.nrrd')
const STRUCTURES = join(ATLAS_DIR, 'structures.json')

const ready = existsSync(FIXTURE) && existsSync(ANNOTATION) && existsSync(STRUCTURES)

describe.skipIf(!ready)('real Allen projection volume', () => {
  const nrrd = parseNrrd(readFileSync(FIXTURE))
  const space = makeVolumeSpace(nrrd.shape, nrrd.spacing[0], 'asr')
  const density =
    nrrd.data instanceof Float32Array
      ? nrrd.data
      : Float32Array.from(nrrd.data as ArrayLike<number>)

  const annotationNrrd = parseNrrd(readFileSync(ANNOTATION))
  const annotationSpace = makeVolumeSpace(annotationNrrd.shape, 50, 'asr')
  const annotation = new AnnotationVolume(
    annotationSpace,
    annotationNrrd.data instanceof Uint32Array
      ? annotationNrrd.data
      : Uint32Array.from(annotationNrrd.data as ArrayLike<number>),
  )

  const index = buildIndex(JSON.parse(readFileSync(STRUCTURES, 'utf8')) as Structure[])
  const profile = ALLEN_CCFV3_50UM

  it('is the geometry the connectivity API documents', () => {
    expect(nrrd.shape).toEqual([132, 80, 114])
    expect(nrrd.type).toBe('float')
    expect(nrrd.spacing).toEqual([100, 100, 100])
  })

  it('occupies the same physical space as the annotation volume', () => {
    // 132 x 100 µm = 13.2 mm AP, matching 264 x 50 µm. This is why no
    // registration step is needed.
    const projectionExtent = nrrd.shape.map((n) => (n * 100) / 1000)
    const annotationExtent = annotationNrrd.shape.map((n) => (n * 50) / 1000)
    expect(projectionExtent).toEqual(annotationExtent)
  })

  it('has densities in the documented 0-1 range', () => {
    let max = 0
    let min = Infinity
    for (const value of density) {
      if (value > max) max = value
      if (value < min) min = value
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(max).toBeGreaterThan(0.1)
  })

  it('builds a cloud that is a small fraction of the volume', () => {
    // A tracing experiment labels a few percent of the brain. A cloud that
    // covered most of it would mean the threshold or the parse is wrong.
    const cloud = buildProjectionPointCloud(density, space, {
      threshold: 0.05,
      maxPoints: 500_000,
    })

    expect(cloud.pointCount).toBeGreaterThan(1000)
    expect(cloud.pointCount).toBeLessThan(density.length * 0.25)
  })

  it('places its densest voxel inside annotated brain tissue', () => {
    const cloud = buildProjectionPointCloud(density, space, {
      threshold: 0.05,
      maxPoints: 500_000,
    })

    let best = -1
    let bestIndex = 0
    for (let i = 0; i < cloud.pointCount; i++) {
      if (cloud.densities[i]! > best) {
        best = cloud.densities[i]!
        bestIndex = i
      }
    }

    // Point positions are CCF micrometres; convert to the annotation volume's
    // own voxel indices, which are the same space at 50 µm.
    const um = [
      cloud.positionsUm[bestIndex * 3]!,
      cloud.positionsUm[bestIndex * 3 + 1]!,
      cloud.positionsUm[bestIndex * 3 + 2]!,
    ]
    const voxel = { i0: um[0]! / 50, i1: um[1]! / 50, i2: um[2]! / 50 }

    const label = annotation.labelAtVoxel(voxel.i0, voxel.i1, voxel.i2)
    expect(label).not.toBe(UNLABELLED)

    // And it must be somewhere in the brain proper, not a ventricle or a tract.
    const grey = index.byAcronym.get('grey')!
    expect(
      isDescendantOf(index, label, grey.id),
      `densest projection voxel resolved to ${index.byId.get(label)?.acronym}`,
    ).toBe(true)
  })

  it('sits within the brain when read as stereotaxic coordinates', () => {
    const cloud = buildProjectionPointCloud(density, space, {
      threshold: 0.1,
      maxPoints: 500_000,
    })

    // Centroid of the cloud, in annotation-volume voxel units.
    let sum0 = 0
    let sum1 = 0
    let sum2 = 0
    for (let i = 0; i < cloud.pointCount; i++) {
      sum0 += cloud.positionsUm[i * 3]! / 50
      sum1 += cloud.positionsUm[i * 3 + 1]! / 50
      sum2 += cloud.positionsUm[i * 3 + 2]! / 50
    }

    const centroid = voxelToStereotaxic(profile, {
      i0: sum0 / cloud.pointCount,
      i1: sum1 / cloud.pointCount,
      i2: sum2 / cloud.pointCount,
    })

    // A mouse brain spans roughly AP +5 to -8, ML ±6, DV +1 to -7 relative to
    // bregma. A centroid outside that means the axes are transposed.
    expect(centroid.ap).toBeGreaterThan(-9)
    expect(centroid.ap).toBeLessThan(6)
    expect(Math.abs(centroid.ml)).toBeLessThan(6)
    expect(centroid.dv).toBeLessThan(2)
    expect(centroid.dv).toBeGreaterThan(-9)
  })

  it('shrinks monotonically as the threshold rises', () => {
    const counts = [0.02, 0.1, 0.3, 0.6].map(
      (threshold) =>
        buildProjectionPointCloud(density, space, { threshold, maxPoints: 500_000 })
          .pointCount,
    )

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!)
    }
    expect(counts[0]!).toBeGreaterThan(counts[counts.length - 1]!)
  })
})
