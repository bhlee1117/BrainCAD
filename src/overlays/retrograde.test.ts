/**
 * Back-trace client tests.
 *
 * Three things here can be wrong in ways that still look right on screen: the
 * seed point (a swapped axis searches a different brain region and returns a
 * confident, plausible list), the ranking (the service answers in no useful
 * order, so truncating before sorting silently drops the strongest sources),
 * and the injection-overlap flag (an injection sitting on the target reports
 * near-1.0 density, which reads as the strongest input in the brain).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { voxelToStereotaxic } from '../atlas/coords.ts'
import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import { TransientApiError } from './connectivity.ts'
import {
  INJECTION_OVERLAP_FACTOR,
  clearRetrogradeCache,
  isSeedCached,
  RETROGRADE_CAVEATS,
  experimentUrl,
  injectionRadiusMm,
  parseRetrogradeResponse,
  retrogradeMatrix,
  mirrorSource,
  searchRetrograde,
  searchRetrogradeMirrored,
  seedPointParam,
  sourceSide,
  targetInsideInjection,
  visibleSources,
  type RetrogradeSource,
} from './retrograde.ts'

const PROFILE = ALLEN_CCFV3_50UM
const CA1 = { ap: -2.0, ml: 1.5, dv: -1.35 }

const FAST = [0, 0, 0]
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  // The cache is module-level and would otherwise answer the next test's
  // query with this test's canned response.
  clearRetrogradeCache()
})

function mockFetch(responses: unknown[]) {
  let call = 0
  // Typed with its arguments so a test can assert on the URL that went out.
  const spy = vi.fn(async (_url: unknown, _init?: unknown) => {
    const body = responses[Math.min(call, responses.length - 1)]
    call += 1
    return { ok: true, status: 200, json: async () => body } as Response
  })
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    'structure-id': 382,
    'structure-abbrev': 'CA3',
    'structure-name': 'Field CA3',
    'structure-color': '7ED04B',
    density: 0.5,
    'injection-coordinates': [7400, 1682, 9000],
    'injection-volume': 0.1,
    path: [
      { coord: [7400, 1682, 7200], density: 0.5 },
      { coord: [7400, 1682, 9000], density: 0.1 },
    ],
    ...over,
  }
}

describe('seedPointParam', () => {
  it('converts a target to CCF micrometres in the volume axis order', () => {
    // Derived by hand from the Allen profile: bregma sits at voxel
    // (108, 6.64, 114) in a 50 um 'asl' volume, so AP -2.0 is 40 voxels
    // posterior, DV -1.35 is 27 ventral and ML +1.5 is 30 to the right.
    expect(seedPointParam(PROFILE, CA1)).toBe('7400,1682,7200')
  })

  it('round-trips against the conversion the overlay panel already uses', () => {
    // The injection marker converts the other way, from the API's triple back
    // to a coordinate. Running that inverse over the seed has to land on the
    // target again — if the two ever disagree, a back-trace searches a
    // different voxel than the one its own markers are drawn at.
    for (const coord of [
      { ap: 0, ml: 0, dv: 0 },
      { ap: 2.4, ml: -3.1, dv: -4.2 },
      { ap: -4.8, ml: 2.2, dv: -0.5 },
    ]) {
      const [a, b, c] = seedPointParam(PROFILE, coord)!.split(',').map(Number)
      const back = voxelToStereotaxic(PROFILE, {
        i0: a! / PROFILE.space.resolutionUm,
        i1: b! / PROFILE.space.resolutionUm,
        i2: c! / PROFILE.space.resolutionUm,
      })

      // Within a micrometre: the only loss is rounding the seed to whole
      // micrometres, which is a fortieth of a voxel.
      expect(back.ap).toBeCloseTo(coord.ap, 3)
      expect(back.ml).toBeCloseTo(coord.ml, 3)
      expect(back.dv).toBeCloseTo(coord.dv, 3)
    }
  })

  it('refuses a point outside the volume', () => {
    // The service answers a nonsense seed with the nearest thing it can find
    // rather than an error, so the guard has to be on this side.
    expect(seedPointParam(PROFILE, { ap: 40, ml: 0, dv: 0 })).toBeNull()
    expect(seedPointParam(PROFILE, { ap: 0, ml: 0, dv: 30 })).toBeNull()
  })

  it('is refused by the search with the coordinate named', async () => {
    const spy = mockFetch([{ success: true, msg: [] }])
    await expect(
      searchRetrograde(PROFILE, { ap: 40, ml: 0, dv: 0 }, { retryDelaysMs: FAST }),
    ).rejects.toThrow(/outside the atlas volume/i)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('injection overlap', () => {
  it('derives a radius from the reported volume', () => {
    // A 0.1 mm³ injection is a 0.29 mm sphere.
    expect(injectionRadiusMm(0.1)).toBeCloseTo(0.2879, 3)
    expect(injectionRadiusMm((4 / 3) * Math.PI)).toBeCloseTo(1, 10)
  })

  it('flags a target sitting inside the injection', () => {
    const radius = injectionRadiusMm(0.094)
    // The real CA1 case: 0.37 mm from the centre of a 0.094 mm³ injection,
    // reporting 0.9999 density. Just outside the sphere, well inside the
    // elongated reality the factor accounts for.
    expect(targetInsideInjection(0.369, radius)).toBe(true)
    expect(radius * INJECTION_OVERLAP_FACTOR).toBeGreaterThan(0.369)
  })

  it('does not flag a distant source', () => {
    // NDB at 5.5 mm is a genuine septal input, not an overlap.
    expect(targetInsideInjection(5.535, injectionRadiusMm(0.138))).toBe(false)
  })

  it('does not flag when either number is missing', () => {
    expect(targetInsideInjection(null, 0.3)).toBe(false)
    expect(targetInsideInjection(0.1, null)).toBe(false)
  })
})

describe('parseRetrogradeResponse', () => {
  it('ranks by density rather than trusting the service order', () => {
    // A real response put 0.0125 in row two and 0.0313 in row four. Slicing a
    // limit off an unsorted list drops the strongest sources.
    const payload = {
      success: true,
      msg: [
        row({ id: 1, density: 0.01 }),
        row({ id: 2, density: 0.9 }),
        row({ id: 3, density: 0.4 }),
      ],
    }
    const parsed = parseRetrogradeResponse(PROFILE, CA1, payload)
    expect(parsed.map((s) => s.experimentId)).toEqual([2, 3, 1])
  })

  it('applies the limit after ranking', () => {
    const payload = {
      success: true,
      msg: [row({ id: 1, density: 0.01 }), row({ id: 2, density: 0.9 })],
    }
    const parsed = parseRetrogradeResponse(PROFILE, CA1, payload, 1)
    expect(parsed.map((s) => s.experimentId)).toEqual([2])
  })

  it('converts the path into stereotaxic millimetres', () => {
    const [source] = parseRetrogradeResponse(PROFILE, CA1, {
      success: true,
      msg: [row()],
    })
    // The first path point is the seed voxel itself, so it must come back as
    // the target that was asked about.
    expect(source!.path[0]!.coord.ap).toBeCloseTo(CA1.ap, 6)
    expect(source!.path[0]!.coord.ml).toBeCloseTo(CA1.ml, 6)
    expect(source!.path[0]!.coord.dv).toBeCloseTo(CA1.dv, 6)
    expect(source!.path).toHaveLength(2)
  })

  it('measures the injection distance from the target', () => {
    const [source] = parseRetrogradeResponse(PROFILE, CA1, {
      success: true,
      msg: [row()],
    })
    // The injection is 1800 um further right than the seed: 9000 - 7200.
    expect(source!.injectionDistanceMm).toBeCloseTo(1.8, 6)
  })

  it('adds the hash the API leaves off its colours', () => {
    const [source] = parseRetrogradeResponse(PROFILE, CA1, {
      success: true,
      msg: [row()],
    })
    expect(source!.structureColor).toBe('#7ED04B')
  })

  it('treats a non-array message as an empty result', () => {
    // A seed in white matter answers success with `msg: {}`, exactly as the
    // forward service does for a structure with no experiments.
    expect(parseRetrogradeResponse(PROFILE, CA1, { success: true, msg: {} })).toEqual([])
  })

  it('raises a transient error for the service failing on itself', () => {
    expect(() =>
      parseRetrogradeResponse(PROFILE, CA1, {
        success: false,
        msg: 'Error in query: service::mouse_connectivity_target_spatial, Informatics service request failed on parsing response.',
      }),
    ).toThrow(TransientApiError)
  })

  it('raises a plain error for a real rejection', () => {
    const call = () =>
      parseRetrogradeResponse(PROFILE, CA1, { success: false, msg: 'Bad criteria' })
    expect(call).toThrow(/rejected the query/i)
    expect(call).not.toThrow(TransientApiError)
  })

  it('drops rows with no experiment id', () => {
    const parsed = parseRetrogradeResponse(PROFILE, CA1, {
      success: true,
      msg: [{ density: 0.5 }, row({ id: 9 })],
    })
    expect(parsed.map((s) => s.experimentId)).toEqual([9])
  })

  it('tolerates a row with no injection, path or colour', () => {
    const [source] = parseRetrogradeResponse(PROFILE, CA1, {
      success: true,
      msg: [{ id: 3 }],
    })
    expect(source!.injectionCentre).toBeNull()
    expect(source!.injectionDistanceMm).toBeNull()
    expect(source!.targetInsideInjection).toBe(false)
    expect(source!.path).toEqual([])
    expect(source!.structureAbbrev).toBe('—')
  })
})

describe('searchRetrograde', () => {
  it('retries a dropped connection rather than reporting "Failed to fetch"', async () => {
    // A bare fetch rejection says nothing a user can act on, and this query is
    // slow enough that the connection really does drop sometimes.
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      if (call === 1) throw new TypeError('Failed to fetch')
      return { ok: true, status: 200, json: async () => ({ success: true, msg: [row({ id: 7 })] }) } as Response
    }) as unknown as typeof fetch

    const found = await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    expect(found.map((s) => s.experimentId)).toEqual([7])
    expect(call).toBe(2)
  })

  it('lets an abort through instead of retrying it', async () => {
    // A superseded query must stop, not try three more times.
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      throw new DOMException('The user aborted a request.', 'AbortError')
    }) as unknown as typeof fetch

    await expect(
      searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST }),
    ).rejects.toThrow(/aborted/i)
    expect(call).toBe(1)
  })

  it('retries a transient failure and returns the retry', async () => {
    const spy = mockFetch([
      { success: false, msg: 'Informatics service request failed on parsing response.' },
      { success: true, msg: [row({ id: 42 })] },
    ])
    const found = await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    expect(found.map((s) => s.experimentId)).toEqual([42])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not retry a real rejection', async () => {
    const spy = mockFetch([{ success: false, msg: 'Bad criteria' }])
    await expect(searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })).rejects.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('sends the seed derived from the target', async () => {
    const spy = mockFetch([{ success: true, msg: [] }])
    await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    expect(String(spy.mock.calls[0]![0])).toContain(encodeURIComponent('7400,1682,7200'))
  })
})

describe('the response cache', () => {
  it('answers a repeated seed without asking again', async () => {
    // Stepping back over a coordinate is the common case when the target is
    // being walked around with the number pad, and the query takes seconds.
    const spy = mockFetch([{ success: true, msg: [row({ id: 11 })] }])
    await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    const again = await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(again.map((s) => s.experimentId)).toEqual([11])
    expect(isSeedCached(seedPointParam(PROFILE, CA1)!)).toBe(true)
  })

  it('re-measures distances for the new target rather than reusing them', async () => {
    // Two targets a few micrometres apart share a seed voxel but deserve their
    // own injection distances, which is why the raw payload is what is cached.
    mockFetch([{ success: true, msg: [row()] }])
    const [first] = await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    const [second] = await searchRetrograde(
      PROFILE,
      { ...CA1, ml: CA1.ml + 0.01 },
      { retryDelaysMs: FAST },
    )
    expect(second!.injectionDistanceMm).not.toBe(first!.injectionDistanceMm)
  })

  it('asks again for a different seed', async () => {
    const spy = mockFetch([{ success: true, msg: [] }])
    await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    await searchRetrograde(PROFILE, { ...CA1, ap: CA1.ap - 1 }, { retryDelaysMs: FAST })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('never stores a failure as the answer', async () => {
    // A cached rejection would make one bad moment permanent for that voxel.
    const spy = mockFetch([
      { success: false, msg: 'Informatics service request failed' },
      { success: true, msg: [row({ id: 3 })] },
    ])
    const found = await searchRetrograde(PROFILE, CA1, { retryDelaysMs: FAST })
    expect(found.map((s) => s.experimentId)).toEqual([3])
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

/** Build a source with just the fields the matrix and the filter read. */
function source(
  over: Partial<RetrogradeSource> & { abbrev: string; density: number },
) {
  return {
    experimentId: over.experimentId ?? Math.round(over.density * 1e6),
    structureId: 1,
    structureAbbrev: over.abbrev,
    structureName: over.abbrev,
    structureColor: '#888888',
    transgenicLine: '',
    densityAtTarget: over.density,
    injectionVolumeMm3: null,
    injectionCentre: null,
    injectionDistanceMm: null,
    injectionRadiusMm: null,
    targetInsideInjection: over.targetInsideInjection ?? false,
    injectionStructures: [],
    // `in`, not `??`: a test that passes `side: null` means it, and `??`
    // would quietly turn that into 'ipsi'.
    side: 'side' in over ? over.side : 'ipsi',
    mirrored: over.mirrored ?? false,
    path: [],
  } as RetrogradeSource
}

describe('retrogradeMatrix', () => {
  const sources = [
    source({ abbrev: 'CA3', density: 0.98 }),
    source({ abbrev: 'DG', density: 0.88 }),
    source({ abbrev: 'CA3', density: 0.2 }),
    source({ abbrev: 'NDB', density: 0.13 }),
    source({ abbrev: 'DG', density: 0.1 }),
    source({ abbrev: 'DG', density: 0.05 }),
  ]

  it('pools experiments by their injection structure', () => {
    const matrix = retrogradeMatrix(sources)
    expect(matrix.map((r) => r.abbrev)).toEqual(['CA3', 'DG', 'NDB'])
    expect(matrix[1]!.experimentCount).toBe(3)
  })

  it('ranks by peak, not by mean or by count', () => {
    // DG has the most experiments and CA3 the strongest one. Ranking by count
    // would rank the Allen Institute's sampling, not the anatomy; ranking by
    // mean would bury a region seen once, well.
    const matrix = retrogradeMatrix(sources)
    expect(matrix[0]!.abbrev).toBe('CA3')
    expect(matrix[0]!.peakDensity).toBeCloseTo(0.98, 6)
    expect(matrix[1]!.meanDensity).toBeCloseTo((0.88 + 0.1 + 0.05) / 3, 6)
  })

  it('keeps each structure its own experiments, strongest first', () => {
    const matrix = retrogradeMatrix(sources)
    expect(matrix[1]!.sources.map((s) => s.densityAtTarget)).toEqual([0.88, 0.1, 0.05])
  })

  it('counts how many of a structure overlap the target', () => {
    const matrix = retrogradeMatrix([
      source({ abbrev: 'CA1', density: 0.99, targetInsideInjection: true }),
      source({ abbrev: 'CA1', density: 0.2 }),
    ])
    expect(matrix[0]!.overlappingCount).toBe(1)
    expect(matrix[0]!.experimentCount).toBe(2)
  })

  it('is empty for no sources', () => {
    expect(retrogradeMatrix([])).toEqual([])
  })
})

describe('visibleSources', () => {
  const sources = [
    source({ abbrev: 'CA1', density: 0.99, targetInsideInjection: true }),
    source({ abbrev: 'CA3', density: 0.9 }),
    source({ abbrev: 'DG', density: 0.5 }),
    source({ abbrev: 'NDB', density: 0.1 }),
  ]

  it('limits by structure rather than by experiment', () => {
    // Taking the top N experiments would show eight CA3 injections and nothing
    // else; the question is which regions project here.
    const many = [
      source({ abbrev: 'CA3', density: 0.9 }),
      source({ abbrev: 'CA3', density: 0.8 }),
      source({ abbrev: 'CA3', density: 0.7 }),
      source({ abbrev: 'DG', density: 0.6 }),
    ]
    const shown = visibleSources(many, {
      includeOverlapping: true,
      topStructures: 2,
      focusAbbrev: null,
    })
    expect(new Set(shown.map((s) => s.structureAbbrev))).toEqual(new Set(['CA3', 'DG']))
    expect(shown).toHaveLength(4)
  })

  it('can drop the rows whose injection covers the target', () => {
    const shown = visibleSources(sources, {
      includeOverlapping: false,
      topStructures: 10,
      focusAbbrev: null,
    })
    expect(shown.map((s) => s.structureAbbrev)).toEqual(['CA3', 'DG', 'NDB'])
  })

  it('includes them by default', () => {
    // Excluding by default would cost a dorsal-CA1 target its CA3 input — the
    // most important afferent CA1 has — because a CA3 injection big enough to
    // label Schaffer collaterals also spills across the boundary.
    const shown = visibleSources(sources, {
      includeOverlapping: true,
      topStructures: 10,
      focusAbbrev: null,
    })
    expect(shown.map((s) => s.structureAbbrev)).toContain('CA1')
  })

  it('isolates one structure, ignoring the top-N limit', () => {
    const shown = visibleSources(sources, {
      includeOverlapping: true,
      topStructures: 1,
      focusAbbrev: 'NDB',
    })
    expect(shown.map((s) => s.structureAbbrev)).toEqual(['NDB'])
  })
})

describe('sourceSide', () => {
  const target = { ap: -2, ml: 1.5, dv: -1.35 }

  it('calls a same-signed injection ipsilateral', () => {
    expect(sourceSide({ ap: 0, ml: 3, dv: 0 }, target)).toBe('ipsi')
    expect(sourceSide({ ap: 0, ml: -3, dv: 0 }, { ...target, ml: -1.5 })).toBe('ipsi')
  })

  it('calls an opposite-signed injection contralateral', () => {
    expect(sourceSide({ ap: 0, ml: -3, dv: 0 }, target)).toBe('contra')
    expect(sourceSide({ ap: 0, ml: 3, dv: 0 }, { ...target, ml: -1.5 })).toBe('contra')
  })

  it('refuses to decide when either point is on the midline', () => {
    // "Same side" has no meaning there, and guessing would put a source in a
    // hemisphere it is not in.
    expect(sourceSide({ ap: 0, ml: 0, dv: 0 }, target)).toBeNull()
    expect(sourceSide({ ap: 0, ml: 3, dv: 0 }, { ...target, ml: 0 })).toBeNull()
  })

  it('is null without an injection centre', () => {
    expect(sourceSide(null, target)).toBeNull()
  })

  it('is read off the pair, not off where Allen usually injects', () => {
    // The error this replaced: inferring the side from the corpus. True of the
    // hub map's experiments in aggregate, 81% right, and not of any one
    // target — a left-hemisphere target can be fed mostly from its own side.
    const [parsed] = parseRetrogradeResponse(
      PROFILE,
      { ap: 0.7, ml: -0.9, dv: -0.85 },
      {
        success: true,
        // Injected at ML index 52 of 228, left of the 114 midline.
        msg: [row({ 'injection-coordinates': [4700, 1182, 2600] })],
      },
    )
    expect(parsed!.injectionCentre!.ml).toBeLessThan(0)
    expect(parsed!.side).toBe('ipsi')
  })
})

describe('provenance', () => {
  it('says first that this is not retrograde tracing', () => {
    // The most likely misreading, so it leads.
    expect(RETROGRADE_CAVEATS[0]).toMatch(/anterograde data read backwards/i)
  })

  it('warns that absence may be absence of injections', () => {
    expect(RETROGRADE_CAVEATS.join(' ')).toMatch(/never have been injected/i)
  })

  it('links an experiment to its Allen page', () => {
    expect(experimentUrl(177780284)).toContain('177780284')
  })
})

describe('mirrorSource', () => {
  const sited = (ml: number) =>
    ({
      ...source({ abbrev: 'CA3', density: 0.5 }),
      injectionCentre: { ap: -2, ml, dv: -2 },
      injectionDistanceMm: 1.25,
      side: 'contra' as const,
      path: [{ coord: { ap: -2, ml, dv: -2 }, density: 0.5 }],
    }) as RetrogradeSource

  it('reflects the injection and the route, and nothing else', () => {
    // A reflection is an isometry and this one reflects the target too, so
    // every quantity defined between source and target survives untouched.
    const there = mirrorSource(sited(2.3))
    expect(there.injectionCentre!.ml).toBeCloseTo(-2.3, 6)
    expect(there.path[0]!.coord.ml).toBeCloseTo(-2.3, 6)
    expect(there.injectionCentre!.ap).toBeCloseTo(-2, 6)
    expect(there.injectionDistanceMm).toBe(1.25)
    expect(there.densityAtTarget).toBe(0.5)
    expect(there.side).toBe('contra')
  })

  it('flags the source, because nothing was injected there', () => {
    expect(sited(2.3).mirrored).toBe(false)
    expect(mirrorSource(sited(2.3)).mirrored).toBe(true)
  })

  it('never produces negative zero on the midline', () => {
    const mid = mirrorSource(sited(0))
    expect(Object.is(mid.injectionCentre!.ml, -0)).toBe(false)
    expect(Object.is(mid.path[0]!.coord.ml, -0)).toBe(false)
  })
})

describe('searchRetrogradeMirrored', () => {
  it('searches both the target and its reflection', async () => {
    const spy = mockFetch([{ success: true, msg: [row({ id: 1 })] }])
    await searchRetrogradeMirrored(PROFILE, CA1)
    expect(spy).toHaveBeenCalledTimes(2)

    // The ML component of the seed, which is the third of the triple, has to
    // differ between the two — a single seed sent twice would double every
    // source and claim symmetry it never checked.
    const seeds = spy.mock.calls.map((call) =>
      decodeURIComponent(String(call[0])).match(/seed_point\$eq([\d,]+)/)?.[1],
    )
    expect(seeds[0]).not.toBe(seeds[1])
    expect(seeds[0]!.split(',').slice(0, 2)).toEqual(seeds[1]!.split(',').slice(0, 2))
  })

  it('keeps both answers rather than deduplicating by experiment', async () => {
    // An injection reaching the target and its reflection is two facts about
    // the target, from two places, and they belong at both.
    mockFetch([{ success: true, msg: [row({ id: 7 })] }])
    const found = await searchRetrogradeMirrored(PROFILE, CA1)
    expect(found).toHaveLength(2)
    expect(found.map((s) => s.mirrored)).toEqual([false, true])
    expect(found[0]!.injectionCentre!.ml).toBeCloseTo(-found[1]!.injectionCentre!.ml, 6)
  })

  it('does not search a midline target twice', async () => {
    // Its reflection is itself, so the second query would be the same query.
    const spy = mockFetch([{ success: true, msg: [row({ id: 1 })] }])
    const found = await searchRetrogradeMirrored(PROFILE, { ...CA1, ml: 0 })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(found.every((s) => !s.mirrored)).toBe(true)
  })
})
