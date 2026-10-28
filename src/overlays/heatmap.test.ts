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

import { buildIndex, type Structure } from '../atlas/ontology.ts'
import {
  HEATMAP_MODE_LABEL,
  MIN_BLOB_RADIUS_MM,
  buildInjectionBlobs,
  buildRouteHeat,
  heatColor,
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

/** A back-trace source with only the fields the blob builder reads. */
const blobSource = (over: {
  id?: number
  abbrev?: string
  ml?: number
  density?: number
  radius?: number | null
  centre?: boolean
}) =>
  ({
    experimentId: over.id ?? 1,
    structureAbbrev: over.abbrev ?? 'CA3',
    densityAtTarget: over.density ?? 0.5,
    injectionRadiusMm: over.radius === undefined ? 0.3 : over.radius,
    injectionCentre:
      over.centre === false ? null : { ap: -2, ml: over.ml ?? -1.5, dv: -2 },
  }) as never

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

  it('normalises a blob from zero, against the strongest present', () => {
    // From zero rather than stretched between weakest and strongest, which is
    // what the structure maps do. A count of 60 out of 110 is not "55% of a
    // hub" — counts have no meaningful zero. A projection density does: zero
    // is no projection, so the weakest source should look as weak as it is.
    const { blobs } = buildInjectionBlobs([
      blobSource({ id: 1, density: 0.4 }),
      blobSource({ id: 2, density: 0.1 }),
    ])
    expect(blobs[0]!.normalised).toBeCloseTo(1, 5)
    expect(blobs[1]!.normalised).toBeCloseTo(0.25, 5)
  })

  it('puts a single value at the top rather than dividing by zero', () => {
    const { blobs } = buildInjectionBlobs([blobSource({ density: 0.08 })])
    expect(blobs[0]!.normalised).toBeCloseTo(1, 5)
  })

  it('does not care what scale the values are on', () => {
    // The same shape of answer paints the same, in densities or in anything
    // proportional to them.
    const small = buildInjectionBlobs([
      blobSource({ id: 1, density: 0.11 }),
      blobSource({ id: 2, density: 0.06 }),
    ])
    const large = buildInjectionBlobs([
      blobSource({ id: 1, density: 110 }),
      blobSource({ id: 2, density: 60 }),
    ])
    expect(small.blobs.map((b) => b.normalised)).toEqual(
      large.blobs.map((b) => b.normalised),
    )
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

describe('buildInjectionBlobs', () => {
  const source = blobSource

  it('places one blob per experiment at its own coordinate', () => {
    // Per experiment, not per structure: six CA3 injections into one field are
    // six overlapping spheres, which is what six experiments look like. The
    // version this replaced collapsed them to one value and flooded CA3.
    const built = buildInjectionBlobs([
      source({ id: 1, ml: -1.5 }),
      source({ id: 2, ml: -1.9 }),
      source({ id: 3, ml: -2.3 }),
    ])
    expect(built.blobs.map((b) => b.experimentId)).toEqual([1, 2, 3])
    expect(built.blobs.map((b) => b.centre.ml)).toEqual([-1.5, -1.9, -2.3])
    // One structure, three blobs — the distinction the caption needs.
    expect(built.structureCount).toBe(1)
  })

  it('sizes a blob by its reported volume', () => {
    const [big, small] = buildInjectionBlobs([
      source({ id: 1, radius: 0.5 }),
      source({ id: 2, radius: 0.2 }),
    ]).blobs
    expect(big!.radiusMm).toBeCloseTo(0.5, 5)
    expect(small!.radiusMm).toBeCloseTo(0.2, 5)
  })

  it('floors a tiny or missing radius so the experiment stays findable', () => {
    // Allen reports volumes down to a 0.08 mm sphere. Drawn true to size it is
    // a couple of pixels; the colour, not the size, is carrying the strength.
    const built = buildInjectionBlobs([
      source({ id: 1, radius: 0.01 }),
      source({ id: 2, radius: null }),
    ])
    for (const blob of built.blobs) expect(blob.radiusMm).toBe(MIN_BLOB_RADIUS_MM)
  })

  it('skips an experiment with no reported centre', () => {
    // There is nowhere to put it, and the centre of the named structure would
    // be a guess dressed as a measurement.
    expect(buildInjectionBlobs([source({ centre: false })]).blobs).toHaveLength(0)
  })

  it('skips an experiment with no strength at the target', () => {
    expect(buildInjectionBlobs([source({ density: 0 })]).blobs).toHaveLength(0)
  })

  it('reports the range the ramp is normalised against', () => {
    const built = buildInjectionBlobs([
      source({ id: 1, density: 0.02, abbrev: 'CA3' }),
      source({ id: 2, density: 0.4, abbrev: 'DG' }),
      source({ id: 3, density: 0.11, abbrev: 'DG' }),
    ])
    expect(built.minStrength).toBeCloseTo(0.02, 5)
    expect(built.maxStrength).toBeCloseTo(0.4, 5)
    expect(built.structureCount).toBe(2)
  })

  it('reports a zero range for nothing, so the caption can say so', () => {
    const built = buildInjectionBlobs([])
    expect(built.blobs).toHaveLength(0)
    expect(built.minStrength).toBe(0)
    expect(built.maxStrength).toBe(0)
  })
})
