/**
 * Convergence-matrix tests.
 *
 * The claim this view makes, and the one worth pinning, is that it does *not*
 * depend on the target. Everything else here is arithmetic over a bundled
 * table; that one property is what separates a hub map from a second drawing
 * of the back-trace, and it is a property of the inputs rather than of any
 * single function, so it is asserted directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CONVERGENCE_CAVEATS,
  CONVERGENCE_METRIC_LABEL,
  DEFAULT_CONNECTION_THRESHOLD,
  clearConvergenceCache,
  convergenceStrengths,
  formatConvergence,
  loadConvergenceMatrix,
  rankConvergence,
  type ConvergenceMatrix,
  type ConvergenceMetric,
} from './convergence.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  clearConvergenceCache()
})

/**
 * Three targets with deliberately opposed shapes.
 *
 *  - HUB    many sources, each weak
 *  - STRONG few sources, each strong
 *  - QUIET  one source, below the default threshold
 */
const MATRIX: ConvergenceMatrix = {
  generatedAt: '2026-10-26T00:00:00.000Z',
  source: 'test',
  structureSet: 'test',
  fetchFloor: 0.002,
  note: 'test',
  convergence: {
    1: {
      acronym: 'HUB',
      sources: [
        [10, 0.05],
        [11, 0.04],
        [12, 0.03],
        [13, 0.02],
        [14, 0.011],
      ],
    },
    2: { acronym: 'STRONG', sources: [[10, 0.9], [11, 0.5]] },
    3: { acronym: 'QUIET', sources: [[10, 0.004]] },
  },
}

describe('convergenceStrengths', () => {
  it('counts the sources that clear the threshold', () => {
    const s = convergenceStrengths(MATRIX, 'count')
    expect(s.get(1)).toBe(5)
    expect(s.get(2)).toBe(2)
  })

  it('averages only the sources that clear it', () => {
    // Dividing by every structure in the atlas instead would turn the mean
    // back into a count wearing a different name.
    const s = convergenceStrengths(MATRIX, 'mean')
    expect(s.get(2)).toBeCloseTo(0.7, 6)
    expect(s.get(1)).toBeCloseTo((0.05 + 0.04 + 0.03 + 0.02 + 0.011) / 5, 6)
  })

  it('ranks the two metrics differently, which is why both exist', () => {
    // HUB is the region many places aim at; STRONG is the one the places that
    // do aim at it aim at hard. Neither number says both.
    const byCount = convergenceStrengths(MATRIX, 'count')
    const byMean = convergenceStrengths(MATRIX, 'mean')

    expect(byCount.get(1)!).toBeGreaterThan(byCount.get(2)!)
    expect(byMean.get(2)!).toBeGreaterThan(byMean.get(1)!)
  })

  it('drops a structure with nothing above the threshold', () => {
    // Absent from the map rather than painted black at zero: no sources that
    // clear the bar is not the same claim as a measured zero.
    const s = convergenceStrengths(MATRIX, 'count')
    expect(s.has(3)).toBe(false)
  })

  it('moves the answer when the threshold moves', () => {
    expect(convergenceStrengths(MATRIX, 'count', 0.001).get(3)).toBe(1)
    expect(convergenceStrengths(MATRIX, 'count', 0.025).get(1)).toBe(3)
  })

  it('defaults to a threshold above the file is own fetch floor', () => {
    // The floor keeps the asset small; the threshold is the claim about what
    // counts as a connection, and it has to be the stricter of the two or the
    // stored noise floor would be making that claim instead.
    expect(DEFAULT_CONNECTION_THRESHOLD).toBeGreaterThan(MATRIX.fetchFloor)
  })
})

describe('independence from the target', () => {
  it('reads nothing that a target could change', () => {
    // The property the whole view rests on. `convergenceStrengths` takes a
    // matrix, a metric and a threshold -- there is no coordinate in its
    // signature, so no target can reach it.
    expect(convergenceStrengths.length).toBeLessThanOrEqual(3)

    const first = convergenceStrengths(MATRIX, 'count')
    const second = convergenceStrengths(MATRIX, 'count')
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('says so in the first caveat', () => {
    // A reader who arrived here by moving a target will assume the map
    // followed them unless told otherwise, so it leads.
    expect(CONVERGENCE_CAVEATS[0]).toMatch(/moving the target does not/i)
  })

  it('warns that fibres of passage are counted', () => {
    expect(CONVERGENCE_CAVEATS.join(' ')).toMatch(/fibres passing through/i)
  })

  it('warns that it counts sources, not experiments', () => {
    expect(CONVERGENCE_CAVEATS.join(' ')).toMatch(/how often Allen injected/i)
  })
})

describe('rankConvergence', () => {
  it('ranks hubs and names them', () => {
    const ranked = rankConvergence(MATRIX, 'count')
    expect(ranked.map((r) => r.acronym)).toEqual(['HUB', 'STRONG'])
    expect(ranked[0]!.sourceCount).toBe(5)
  })

  it('carries the source count whichever metric ranks it', () => {
    // So a region at the top of the mean ranking still shows how thin the
    // evidence behind that average is.
    const ranked = rankConvergence(MATRIX, 'mean')
    expect(ranked[0]!.acronym).toBe('STRONG')
    expect(ranked[0]!.sourceCount).toBe(2)
  })
})

describe('formatting', () => {
  it('shows a count as an integer and a mean as a density', () => {
    expect(formatConvergence('count', 5)).toBe('5')
    expect(formatConvergence('mean', 0.12345)).toBe('0.123')
  })

  it('labels both metrics', () => {
    for (const metric of ['count', 'mean'] as ConvergenceMetric[]) {
      expect(CONVERGENCE_METRIC_LABEL[metric]).toBeTruthy()
    }
  })
})

describe('loading', () => {
  it('fetches once and caches', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => MATRIX }) as Response)
    globalThis.fetch = spy as unknown as typeof fetch

    await loadConvergenceMatrix()
    await loadConvergenceMatrix()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('points at the build step when the asset is missing', async () => {
    // A fresh clone has not run the fetch yet, and "HTTP 404" would send the
    // reader looking for a bug instead of a command.
    globalThis.fetch = (async () => ({ ok: false, status: 404 }) as Response) as never
    await expect(loadConvergenceMatrix()).rejects.toThrow(/connectivity:fetch/)
  })

  it('does not cache a failure', async () => {
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      return call === 1
        ? ({ ok: false, status: 500 } as Response)
        : ({ ok: true, json: async () => MATRIX } as Response)
    }) as unknown as typeof fetch

    await expect(loadConvergenceMatrix()).rejects.toThrow()
    await expect(loadConvergenceMatrix()).resolves.toBeTruthy()
    expect(call).toBe(2)
  })
})
