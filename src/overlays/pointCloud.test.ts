/**
 * Point-cloud tests.
 *
 * The overlay sits on top of anatomy a surgeon is reading coordinates from, so
 * two things must hold exactly: points land at voxel centres in the right
 * space, and thresholding never silently misrepresents what is in the data.
 */

import { Matrix4 } from 'three'
import { describe, expect, it } from 'vitest'

import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import { makeVolumeSpace } from '../atlas/space.ts'
import { flatIndex } from '../atlas/space.ts'
import { atlasToWorldMatrix } from '../scene/world.ts'
import {
  DEFAULT_POINT_CLOUD_OPTIONS,
  buildProjectionPointCloud,
  densityColors,
  positionsToWorld,
} from './pointCloud.ts'

/** A small volume with density written through the real storage layout. */
function volumeWith(
  shape: [number, number, number],
  resolutionUm: number,
  write: (set: (i0: number, i1: number, i2: number, value: number) => void) => void,
) {
  const space = makeVolumeSpace(shape, resolutionUm, 'asr')
  const data = new Float32Array(shape[0] * shape[1] * shape[2])
  write((i0, i1, i2, value) => {
    data[flatIndex(space, i0, i1, i2)] = value
  })
  return { space, data }
}

describe('thresholding', () => {
  it('emits nothing from an empty volume', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, () => {})
    const cloud = buildProjectionPointCloud(data, space)

    expect(cloud.pointCount).toBe(0)
    expect(cloud.voxelsAboveThreshold).toBe(0)
    expect(cloud.maxDensity).toBe(0)
  })

  it('keeps only voxels above the threshold', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => {
      set(0, 0, 0, 0.01)
      set(1, 0, 0, 0.2)
      set(2, 0, 0, 0.9)
    })
    const cloud = buildProjectionPointCloud(data, space, {
      ...DEFAULT_POINT_CLOUD_OPTIONS,
      threshold: 0.05,
    })

    expect(cloud.pointCount).toBe(2)
    expect(cloud.voxelsAboveThreshold).toBe(2)
    // Float32Array round-trips 0.2 as 0.20000000298, so compare with tolerance.
    const sorted = [...cloud.densities].sort((a, b) => a - b)
    expect(sorted[0]!).toBeCloseTo(0.2, 6)
    expect(sorted[1]!).toBeCloseTo(0.9, 6)
  })

  it('reports the peak density even when it is below the threshold', () => {
    // The UI needs this to tell the user their threshold excluded everything,
    // rather than showing an empty view that looks like "no projection".
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => set(1, 1, 1, 0.03))
    const cloud = buildProjectionPointCloud(data, space, {
      ...DEFAULT_POINT_CLOUD_OPTIONS,
      threshold: 0.5,
    })

    expect(cloud.pointCount).toBe(0)
    expect(cloud.maxDensity).toBeCloseTo(0.03, 6)
  })

  it('records the threshold it applied', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => set(0, 0, 0, 1))
    const cloud = buildProjectionPointCloud(data, space, {
      ...DEFAULT_POINT_CLOUD_OPTIONS,
      threshold: 0.25,
    })
    expect(cloud.threshold).toBeCloseTo(0.25, 9)
  })

  it('treats a negative threshold as zero', () => {
    const { space, data } = volumeWith([2, 2, 2], 100, (set) => set(0, 0, 0, 0.001))
    const cloud = buildProjectionPointCloud(data, space, {
      ...DEFAULT_POINT_CLOUD_OPTIONS,
      threshold: -1,
    })
    expect(cloud.threshold).toBe(0)
    expect(cloud.pointCount).toBe(1)
  })
})

describe('point placement', () => {
  it('puts points at voxel centres, not corners', () => {
    // At 100 µm a corner sits 50 µm off the tissue it represents.
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => set(0, 0, 0, 1))
    const cloud = buildProjectionPointCloud(data, space)

    expect(cloud.pointCount).toBe(1)
    expect([...cloud.positionsUm]).toEqual([50, 50, 50])
  })

  it('scales positions by the volume resolution', () => {
    const { space, data } = volumeWith([4, 4, 4], 25, (set) => set(2, 1, 3, 1))
    const cloud = buildProjectionPointCloud(data, space)

    expect([...cloud.positionsUm]).toEqual([2.5 * 25, 1.5 * 25, 3.5 * 25])
  })

  it('reads the volume through its declared storage layout', () => {
    // Written at one voxel through flatIndex; if the reader disagreed with the
    // writer about layout, the point would come back at the wrong coordinate.
    const { space, data } = volumeWith([6, 5, 4], 100, (set) => set(4, 1, 2, 0.8))
    const cloud = buildProjectionPointCloud(data, space)

    expect(cloud.pointCount).toBe(1)
    expect([...cloud.positionsUm]).toEqual([450, 150, 250])
  })
})

describe('capping', () => {
  it('does not cap when everything fits', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => {
      set(0, 0, 0, 1)
      set(1, 0, 0, 1)
    })
    const cloud = buildProjectionPointCloud(data, space, {
      threshold: 0.05,
      maxPoints: 100,
    })
    expect(cloud.capped).toBe(false)
    expect(cloud.pointCount).toBe(2)
  })

  it('keeps the densest voxels when it must cap', () => {
    // A random subsample would thin a faint tract into nothing while barely
    // touching a dense one; keeping the densest preserves every core.
    const { space, data } = volumeWith([10, 1, 1], 100, (set) => {
      for (let i = 0; i < 10; i++) set(i, 0, 0, (i + 1) / 10)
    })

    const cloud = buildProjectionPointCloud(data, space, {
      threshold: 0.0,
      maxPoints: 3,
    })

    expect(cloud.capped).toBe(true)
    expect(cloud.pointCount).toBeLessThanOrEqual(3)
    // Every kept point must be among the strongest.
    for (const density of cloud.densities) {
      expect(density).toBeGreaterThan(0.6)
    }
  })

  it('still reports how many voxels passed the user threshold', () => {
    // Capping is a rendering budget, not a statement about the data — the
    // original survivor count has to remain visible.
    const { space, data } = volumeWith([10, 1, 1], 100, (set) => {
      for (let i = 0; i < 10; i++) set(i, 0, 0, 0.5)
    })
    const cloud = buildProjectionPointCloud(data, space, {
      threshold: 0.1,
      maxPoints: 4,
    })

    expect(cloud.voxelsAboveThreshold).toBe(10)
    expect(cloud.pointCount).toBeLessThanOrEqual(4)
  })
})

describe('colours', () => {
  it('produces one rgb triple per point', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => {
      set(0, 0, 0, 0.2)
      set(1, 0, 0, 1.0)
    })
    const cloud = buildProjectionPointCloud(data, space)
    const colors = densityColors(cloud, '#ff6b4a')

    expect(colors.length).toBe(cloud.pointCount * 3)
  })

  it('renders denser points brighter than faint ones', () => {
    const { space, data } = volumeWith([4, 4, 4], 100, (set) => {
      set(0, 0, 0, 0.1)
      set(1, 0, 0, 1.0)
    })
    const cloud = buildProjectionPointCloud(data, space)
    const colors = densityColors(cloud, '#ffffff')

    const brightness = (i: number) =>
      colors[i * 3]! + colors[i * 3 + 1]! + colors[i * 3 + 2]!

    const faintIndex = cloud.densities[0]! < cloud.densities[1]! ? 0 : 1
    const denseIndex = 1 - faintIndex
    expect(brightness(denseIndex)).toBeGreaterThan(brightness(faintIndex))
  })

  it('does not divide by zero on an empty cloud', () => {
    const { space, data } = volumeWith([2, 2, 2], 100, () => {})
    const cloud = buildProjectionPointCloud(data, space)
    expect(densityColors(cloud, '#ffffff').length).toBe(0)
  })
})

describe('world transform', () => {
  const matrix = atlasToWorldMatrix(ALLEN_CCFV3_50UM)

  it('maps a point at bregma to the world origin', () => {
    // Bregma in CCF micrometres, per the Allen profile.
    const positions = new Float32Array([5400, 332, 5700])
    const world = positionsToWorld(positions, matrix)

    expect(world[0]!).toBeCloseTo(0, 5)
    expect(world[1]!).toBeCloseTo(0, 5)
    expect(world[2]!).toBeCloseTo(0, 5)
  })

  it('agrees with applying the matrix directly', () => {
    // The hand-rolled loop must match three.js exactly, or the overlay drifts
    // from the anatomy it is drawn over.
    const positions = new Float32Array([1000, 2000, 3000, 9000, 4000, 8000])
    const world = positionsToWorld(positions, matrix)

    for (let i = 0; i < positions.length; i += 3) {
      const expected = new (class {
        x = positions[i]! / 1000
        y = positions[i + 1]! / 1000
        z = positions[i + 2]! / 1000
      })()
      const v = { x: expected.x, y: expected.y, z: expected.z }
      const e = matrix.elements
      const ex = e[0]! * v.x + e[4]! * v.y + e[8]! * v.z + e[12]!
      const ey = e[1]! * v.x + e[5]! * v.y + e[9]! * v.z + e[13]!
      const ez = e[2]! * v.x + e[6]! * v.y + e[10]! * v.z + e[14]!

      expect(world[i]!).toBeCloseTo(ex, 6)
      expect(world[i + 1]!).toBeCloseTo(ey, 6)
      expect(world[i + 2]!).toBeCloseTo(ez, 6)
    }
  })

  it('preserves distances, as a rigid transform must', () => {
    const positions = new Float32Array([1000, 1000, 1000, 1000, 1000, 4000])
    const world = positionsToWorld(positions, matrix)

    const dx = world[3]! - world[0]!
    const dy = world[4]! - world[1]!
    const dz = world[5]! - world[2]!
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(3, 5)
  })

  it('handles an identity matrix without reordering axes', () => {
    const world = positionsToWorld(new Float32Array([1000, 2000, 3000]), new Matrix4())
    expect([...world]).toEqual([1, 2, 3])
  })
})
