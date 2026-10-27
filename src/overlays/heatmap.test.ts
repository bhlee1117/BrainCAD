/**
 * Heat-map tests.
 *
 * The one that matters is the ancestor walk. The annotation volume labels
 * voxels with leaf structures — "Field CA3, pyramidal layer" — while an
 * injection is reported against "Field CA3", so matching on equality would
 * leave the brain unpainted while the list beside it confidently named CA3.
 * That failure is silent: an empty map looks exactly like a target with no
 * inputs.
 */

import { describe, expect, it } from 'vitest'

import { AnnotationVolume } from '../atlas/annotation.ts'
import { buildIndex, type Structure } from '../atlas/ontology.ts'
import { makeVolumeSpace } from '../atlas/space.ts'
import {
  DEFAULT_HEATMAP_OPTIONS,
  HEATMAP_MODE_LABEL,
  buildRetrogradeHeatmap,
  buildRouteHeat,
  heatColor,
  heatmapColors,
  strengthForStructure,
  type HeatmapMode,
} from './heatmap.ts'

/**
 * A miniature ontology: root › grey › {HPF › CA3 › CA3sp, TH › RT}.
 *
 * Deep enough that the ancestor walk has somewhere to walk, and shaped like
 * the real one where a source is named at a level above the voxel labels.
 */
const STRUCTURES: Structure[] = [
  { id: 997, acronym: 'root', name: 'root', colorHex: 'FFFFFF', parentId: null, path: [997], depth: 0 },
  { id: 8, acronym: 'grey', name: 'Basic cell groups', colorHex: 'BFDAE3', parentId: 997, path: [997, 8], depth: 1 },
  { id: 1089, acronym: 'HPF', name: 'Hippocampal formation', colorHex: '7ED04B', parentId: 8, path: [997, 8, 1089], depth: 2 },
  { id: 382, acronym: 'CA3', name: 'Field CA3', colorHex: '7ED04B', parentId: 1089, path: [997, 8, 1089, 382], depth: 3 },
  { id: 3821, acronym: 'CA3sp', name: 'Field CA3, pyramidal layer', colorHex: '7ED04B', parentId: 382, path: [997, 8, 1089, 382, 3821], depth: 4 },
  { id: 549, acronym: 'TH', name: 'Thalamus', colorHex: 'FF7080', parentId: 8, path: [997, 8, 549], depth: 2 },
  { id: 262, acronym: 'RT', name: 'Reticular nucleus', colorHex: 'FF909F', parentId: 549, path: [997, 8, 549, 262], depth: 3 },
]

const INDEX = buildIndex(STRUCTURES)

/**
 * A 4x4x4 volume: one quadrant CA3sp, one RT, the rest root and unlabelled.
 *
 * Laid out by hand so the expected point counts can be reasoned about rather
 * than read back out of the function under test.
 */
/** Both halves given the same values, when a test is not about laterality. */
function bothSides(map: Map<number, number>) {
  return { ipsi: map, contra: map }
}

/**
 * Compare colours with tolerance.
 *
 * The buffers are Float32Array, so a stop written as 0.92 reads back as
 * 0.9200000166893005 and an exact comparison fails on the storage format
 * rather than on anything about the colour.
 */
function expectColor(actual: ArrayLike<number>, expected: readonly number[]) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i]!, 5)
  }
}

function miniVolume(): AnnotationVolume {
  const space = makeVolumeSpace([4, 4, 4], 50, 'asl')
  const labels = new Uint32Array(4 * 4 * 4)
  // NRRD order: first axis fastest.
  const at = (i0: number, i1: number, i2: number) => i0 + 4 * (i1 + 4 * i2)
  for (let i0 = 0; i0 < 4; i0++) {
    for (let i1 = 0; i1 < 4; i1++) {
      for (let i2 = 0; i2 < 4; i2++) {
        labels[at(i0, i1, i2)] = i0 < 2 ? 3821 : i1 < 2 ? 262 : 997
      }
    }
  }
  return new AnnotationVolume(space, labels)
}

describe('strengthForStructure', () => {
  it('matches a leaf voxel to the ancestor that was injected', () => {
    // The whole reason this walk exists.
    const strengths = new Map([[382, 0.9]])
    expect(strengthForStructure(INDEX, strengths, 3821)).toBeCloseTo(0.9, 6)
  })

  it('prefers the most specific ancestor when several match', () => {
    // A map naming both HPF and CA3 should paint CA3sp with CA3's value, not
    // the coarser one it also sits under.
    const strengths = new Map([
      [1089, 0.2],
      [382, 0.9],
    ])
    expect(strengthForStructure(INDEX, strengths, 3821)).toBeCloseTo(0.9, 6)
  })

  it('paints everything beneath a coarse source', () => {
    const strengths = new Map([[549, 0.5]])
    expect(strengthForStructure(INDEX, strengths, 262)).toBeCloseTo(0.5, 6)
  })

  it('returns null for a structure under nothing named', () => {
    expect(strengthForStructure(INDEX, new Map([[382, 0.9]]), 262)).toBeNull()
  })

  it('returns null for an id the ontology does not know', () => {
    expect(strengthForStructure(INDEX, new Map([[382, 0.9]]), 999999)).toBeNull()
  })
})

describe('buildRetrogradeHeatmap', () => {
  const volume = miniVolume()

  it('paints only the voxels under a source', () => {
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map([[382, 0.9]])), {
      stride: 1,
    })
    // Half the volume is CA3sp: 2 of 4 along the first axis.
    expect(heatmap.pointCount).toBe(32)
    expect(heatmap.maxStrength).toBeCloseTo(0.9, 6)
    expect(heatmap.paintedStructureIds).toEqual([382])
  })

  it('emits voxel centres, not corners', () => {
    // Half a voxel matters: a corner is 25 um off the tissue it stands for.
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map([[382, 0.9]])), {
      stride: 1,
    })
    expect(heatmap.positionsUm[0]).toBeCloseTo(25, 6)
    expect(heatmap.positionsUm[1]).toBeCloseTo(25, 6)
    expect(heatmap.positionsUm[2]).toBeCloseTo(25, 6)
  })

  it('carries each voxel its own structure strength', () => {
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map([
        [382, 0.9],
        [262, 0.3],
      ])), { stride: 1 },
    )
    const values = new Set([...heatmap.strengths].map((v) => Number(v.toFixed(3))))
    expect(values).toEqual(new Set([0.9, 0.3]))
    expect(heatmap.maxStrength).toBeCloseTo(0.9, 6)
  })

  it('reports sources it could not paint', () => {
    // A named source the volume does not carry has to be visible as a gap,
    // not silently absent from a map that looks complete.
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map([[262, 0.3], [999999, 0.5]])), {
      stride: 1,
    })
    expect(heatmap.paintedStructureIds).toEqual([262])
    expect(heatmap.unpaintedStructureIds).toEqual([999999])
  })

  it('raises the stride rather than thinning the cloud at random', () => {
    // Dropping points at random would thin a dense hub and a faint one by the
    // same fraction, which looks like a measurement and is not.
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map([[382, 0.9]])), {
      stride: 1,
      maxPoints: 10,
    })
    expect(heatmap.stride).toBeGreaterThan(1)
    expect(heatmap.pointCount).toBeLessThanOrEqual(10)
  })

  it('is empty when nothing matches', () => {
    const heatmap = buildRetrogradeHeatmap(volume, INDEX, bothSides(new Map()), { stride: 1 })
    expect(heatmap.pointCount).toBe(0)
    expect(heatmap.maxStrength).toBe(0)
    expect(heatmapColors(heatmap)).toHaveLength(0)
  })

  it('samples at the data resolution by default, not finer', () => {
    // The connectivity volumes are published at 100 um and the annotation is
    // 50 um; sampling finer than the data costs eight times the points for
    // the same information.
    expect(DEFAULT_HEATMAP_OPTIONS.stride).toBe(2)
  })
})

describe('the heat ramp', () => {
  it('rises in luminance from end to end', () => {
    // So the ordering survives greyscale and a colour-blind reader, which a
    // rainbow ramp does not.
    const luminance = (t: number) => {
      const [r, g, b] = heatColor(t)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    for (let t = 0.05; t <= 1; t += 0.05) {
      expect(luminance(t)).toBeGreaterThan(luminance(t - 0.05))
    }
  })

  it('clamps outside 0..1', () => {
    expect(heatColor(-1)).toEqual(heatColor(0))
    expect(heatColor(5)).toEqual(heatColor(1))
  })

  it('stretches between the lowest and highest value present', () => {
    // Normalising from zero was the first version and was wrong for counts:
    // they run 1 to 115 with most regions between 60 and 110, so nearly the
    // whole brain landed at the top of the ramp with nothing to stand out
    // from. Stretched, the weakest region sits at the bottom stop.
    const heatmap = buildRetrogradeHeatmap(miniVolume(), INDEX, bothSides(new Map([
        [382, 110],
        [262, 60],
      ])), { stride: 1 },
    )
    const colors = heatmapColors(heatmap)
    const strongIndex = [...heatmap.strengths].indexOf(110)
    const weakIndex = [...heatmap.strengths].indexOf(60)

    expect(heatmap.minStrength).toBe(60)
    expect(heatmap.maxStrength).toBe(110)
    expectColor(colors.slice(strongIndex * 3, strongIndex * 3 + 3), heatColor(1))
    expectColor(colors.slice(weakIndex * 3, weakIndex * 3 + 3), heatColor(0))
  })

  it('puts a single value at the top rather than dividing by zero', () => {
    const flat = buildRetrogradeHeatmap(miniVolume(), INDEX, bothSides(new Map([[382, 0.08]])), {
      stride: 1,
    })
    expectColor(heatmapColors(flat).slice(0, 3), heatColor(1))
  })

  it('does not care what scale the values are on', () => {
    // The same shape of answer, in counts or in densities, paints the same.
    const counts = buildRetrogradeHeatmap(miniVolume(), INDEX, bothSides(new Map([[382, 110], [262, 60]])), { stride: 1 },
    )
    const densities = buildRetrogradeHeatmap(miniVolume(), INDEX, bothSides(new Map([[382, 0.11], [262, 0.06]])), { stride: 1 },
    )
    expectColor(heatmapColors(counts), [...heatmapColors(densities)])
  })
})

describe('buildRouteHeat', () => {
  const route = (density: number, points: [number, number, number][]) => ({
    densityAtTarget: density,
    path: points.map(([ap, ml, dv]) => ({ coord: { ap, ml, dv } })),
  })

  it('emits one segment pair per step, not a strip', () => {
    // LineSegments draws disconnected pairs; writing a strip would join the
    // end of one source's route to the start of the next, drawing a line
    // across the brain that is not data.
    const heat = buildRouteHeat([
      route(0.5, [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ])
    expect(heat.segmentCount).toBe(2)
    expect(heat.points).toHaveLength(12)
  })

  it('writes points in world axis order', () => {
    // World space is +X right (ML), +Y dorsal (DV), +Z anterior (AP). The
    // paths arrive as stereotaxic coordinates, so the reorder happens here --
    // and getting it wrong draws an anatomically plausible route through the
    // wrong part of the brain.
    const heat = buildRouteHeat([
      route(1, [
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ])
    expect([...heat.points.slice(0, 6)]).toEqual([2, 3, 1, 5, 6, 4])
  })

  it('colours a whole route by its own strength', () => {
    const heat = buildRouteHeat([
      route(1, [
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ])
    // Both ends of a segment take the same colour: the route is one source.
    expect([...heat.colors.slice(0, 3)]).toEqual([...heat.colors.slice(3, 6)])
  })

  it('normalises against the strongest route present', () => {
    const heat = buildRouteHeat([
      route(0.2, [
        [0, 0, 0],
        [1, 0, 0],
      ]),
      route(0.05, [
        [0, 0, 0],
        [0, 1, 0],
      ]),
    ])
    expect(heat.maxStrength).toBeCloseTo(0.2, 6)
    // The strong one sits at the top of the ramp, the weak one below it.
    const strong = heat.colors[0]! + heat.colors[1]! + heat.colors[2]!
    const weak = heat.colors[6]! + heat.colors[7]! + heat.colors[8]!
    expect(strong).toBeGreaterThan(weak)
  })

  it('skips a source whose path has fewer than two points', () => {
    const heat = buildRouteHeat([route(1, [[0, 0, 0]]), route(1, [])])
    expect(heat.segmentCount).toBe(0)
    expect(heat.points).toHaveLength(0)
  })

  it('labels both modes for the checkbox', () => {
    for (const mode of ['regions', 'routes'] as HeatmapMode[]) {
      expect(HEATMAP_MODE_LABEL[mode]).toBeTruthy()
    }
  })
})
