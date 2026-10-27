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

import { makeVolumeSpace } from '../atlas/space.ts'
import { VOXEL_CAVEATS } from './voxelConvergence.ts'
import {
  CONVERGENCE_CAVEATS,
  CONVERGENCE_METRIC_LABEL,
  DEFAULT_CONNECTION_THRESHOLD,
  clearConvergenceCache,
  convergenceStrengths,
  formatConvergence,
  loadConvergenceMatrix,
  SIDE_LABEL,
  flipHemisphere,
  rankConvergence,
  sectionSides,
  type ConvergenceMatrix,
  voxelSide,
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
  products: [5],
  experiments: 3,
  corpus: 'test',
  note: 'test',
  convergence: {
    1: {
      acronym: 'HUB',
      sources: [
        [10, 0.05, 0.02],
        [11, 0.04, 0.001],
        [12, 0.03, 0.03],
        [13, 0.02, 0.001],
        [14, 0.011, 0.001],
      ],
    },
    2: {
      acronym: 'STRONG',
      sources: [
        [10, 0.9, 0.1],
        [11, 0.5, 0.004],
      ],
    },
    3: { acronym: 'QUIET', sources: [[10, 0.004, 0.001]] },
  },
}

describe('convergenceStrengths', () => {
  it('counts the sources that clear the threshold', () => {
    const { ipsi } = convergenceStrengths(MATRIX, 'count')
    expect(ipsi.get(1)).toBe(5)
    expect(ipsi.get(2)).toBe(2)
  })

  it('averages only the sources that clear it', () => {
    // Dividing by every structure in the atlas instead would turn the mean
    // back into a count wearing a different name.
    const { ipsi } = convergenceStrengths(MATRIX, 'mean')
    expect(ipsi.get(2)).toBeCloseTo(0.7, 6)
    expect(ipsi.get(1)).toBeCloseTo((0.05 + 0.04 + 0.03 + 0.02 + 0.011) / 5, 6)
  })

  it('keeps the two sides apart', () => {
    // The whole point of refetching per hemisphere. Pooled, every structure
    // took one number on both halves and the map was symmetric by
    // construction rather than by anatomy.
    const { ipsi, contra } = convergenceStrengths(MATRIX, 'count')
    expect(ipsi.get(1)).toBe(5)
    expect(contra.get(1)).toBe(2)
    expect(contra.get(2)).toBe(1)
  })

  it('ranks the two metrics differently, which is why both exist', () => {
    // HUB is the region many places aim at; STRONG is the one the places that
    // do aim at it aim at hard. Neither number says both.
    const byCount = convergenceStrengths(MATRIX, 'count').ipsi
    const byMean = convergenceStrengths(MATRIX, 'mean').ipsi

    expect(byCount.get(1)!).toBeGreaterThan(byCount.get(2)!)
    expect(byMean.get(2)!).toBeGreaterThan(byMean.get(1)!)
  })

  it('drops a structure with nothing above the threshold', () => {
    // Absent from the map rather than painted black at zero: no sources that
    // clear the bar is not the same claim as a measured zero.
    expect(convergenceStrengths(MATRIX, 'count').ipsi.has(3)).toBe(false)
  })

  it('moves the answer when the threshold moves', () => {
    expect(convergenceStrengths(MATRIX, 'count', 0.001).ipsi.get(3)).toBe(1)
    expect(convergenceStrengths(MATRIX, 'count', 0.025).ipsi.get(1)).toBe(3)
  })

  it('defaults to a threshold above the file is own fetch floor', () => {
    // The floor keeps the asset small; the threshold is the claim about what
    // counts as a connection, and it has to be the stricter of the two or the
    // stored noise floor would be making that claim instead.
    expect(DEFAULT_CONNECTION_THRESHOLD).toBeGreaterThan(MATRIX.fetchFloor)
  })
})

describe('voxelSide', () => {
  const space = makeVolumeSpace([264, 160, 228], 50, 'asl')

  it('calls the right half ipsilateral', () => {
    // Not arbitrary: Allen injects the right hemisphere, so normalising onto
    // it makes the aggregate agree with the raw anatomy and with the panel's
    // ipsi button, which sends the target right for the same reason.
    expect(voxelSide(space, { i0: 100, i1: 80, i2: 220 })).toBe('ipsi')
    expect(voxelSide(space, { i0: 100, i1: 80, i2: 10 })).toBe('contra')
  })

  it('follows the ML direction of the volume rather than the index', () => {
    // An 'asr' volume counts ML from the right, so the same index is the
    // other hemisphere. Hard-coding "high index is right" would silently swap
    // ipsi and contra for any atlas stored the other way round.
    const flipped = makeVolumeSpace([264, 160, 228], 50, 'asr')
    expect(voxelSide(flipped, { i0: 100, i1: 80, i2: 220 })).toBe('contra')
    expect(voxelSide(flipped, { i0: 100, i1: 80, i2: 10 })).toBe('ipsi')
  })

  it('splits at the ML axis midpoint', () => {
    expect(voxelSide(space, { i0: 0, i1: 0, i2: 113 })).toBe('contra')
    expect(voxelSide(space, { i0: 0, i1: 0, i2: 114 })).toBe('ipsi')
  })

  it('agrees with the bundled voxel map about which side is which', () => {
    // The two grains are drawn side by side and compared by eye, so a
    // disagreement here would be read as a difference in the data.
    expect(CONVERGENCE_CAVEATS.join(' ')).toMatch(/right is ipsilateral/i)
    expect(VOXEL_CAVEATS.join(' ')).toMatch(/right is ipsilateral/i)
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
    expect([...first.ipsi.entries()]).toEqual([...second.ipsi.entries()])
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

describe('sectionSides', () => {
  it('splits a coronal section into ipsi on the right', () => {
    // `extractSlice` always puts +ML to the right whatever the array order is,
    // so the animal's right — ipsilateral, by the mirroring the data was built
    // with — is always the right of the image.
    const sides = sectionSides('AP', { ml: 1.5 })
    expect(sides.right).toBe('ipsi')
    expect(sides.left).toBe('contra')
    expect(sides.whole).toBeNull()
  })

  it('splits a horizontal section the same way', () => {
    expect(sectionSides('DV', { ml: -2 }).right).toBe('ipsi')
  })

  it('does not depend on where a coronal slice was taken', () => {
    // Both halves are on screen whatever the ML readout says, so the labels
    // must not follow the crosshair.
    for (const ml of [-4, 0, 4]) {
      expect(sectionSides('AP', { ml }).right).toBe('ipsi')
    }
  })

  it('names a sagittal section by the hemisphere it is in', () => {
    // One hemisphere only, and which one is the whole question.
    expect(sectionSides('ML', { ml: 1.5 }).whole).toBe('ipsi')
    expect(sectionSides('ML', { ml: -1.5 }).whole).toBe('contra')
    expect(sectionSides('ML', { ml: 1.5 }).left).toBeNull()
  })

  it('refuses to name a sagittal section on the midline', () => {
    // Rounding to one side would be a quiet lie about which half the colours
    // came from.
    expect(sectionSides('ML', { ml: 0 }).whole).toBeNull()
  })

  it('labels both sides', () => {
    expect(SIDE_LABEL.ipsi).toBeTruthy()
    expect(SIDE_LABEL.contra).toBeTruthy()
    expect(SIDE_LABEL.ipsi).not.toBe(SIDE_LABEL.contra)
  })
})

describe('flipHemisphere', () => {
  const at = { ap: -2, ml: 1.5, dv: -1.35 }

  it('mirrors ML and nothing else', () => {
    // Reflecting anything else would move the target into a different
    // structure, and then the comparison is between two places rather than
    // between two sides of one.
    const moved = flipHemisphere(at)
    expect(moved.ml).toBe(-1.5)
    expect(moved.ap).toBe(at.ap)
    expect(moved.dv).toBe(at.dv)
  })

  it('is its own inverse', () => {
    expect(flipHemisphere(flipHemisphere(at))).toEqual(at)
  })

  it('cannot move a target off the midline', () => {
    // -0 is 0, so the button is disabled there rather than appearing to work.
    expect(flipHemisphere({ ...at, ml: 0 }).ml).toBe(0)
  })
})

describe('rankConvergence', () => {
  it('ranks hubs and names them', () => {
    const ranked = rankConvergence(MATRIX, 'count')
    expect(ranked.map((r) => r.acronym)).toEqual(['HUB', 'STRONG'])
    expect(ranked[0]!.sourceCount).toBe(5)
  })

  it('carries the contralateral value without averaging it in', () => {
    // A region fed almost equally from both sides is a different kind of hub
    // from one fed overwhelmingly from its own, and an average hides which.
    const ranked = rankConvergence(MATRIX, 'count')
    const hub = ranked.find((r) => r.acronym === 'HUB')!
    expect(hub.value).toBe(5)
    expect(hub.contra).toBe(2)
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
