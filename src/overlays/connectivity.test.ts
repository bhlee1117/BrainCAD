/**
 * Connectivity client tests.
 *
 * The retry behaviour is the substance here. The Allen service intermittently
 * answers a valid query with `success: false` and "Informatics service request
 * failed", and the identical query succeeds moments later — so a single attempt
 * tells the user their region has no tracing data when it has hundreds of
 * experiments. These pin the distinction between a transient failure, a real
 * rejection, and a genuinely empty result.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RETRY_DELAYS_MS,
  TransientApiError,
  describeExperiment,
  experimentCitation,
  experimentUrl,
  projectionVolumeUrl,
  searchExperiments,
} from './connectivity.ts'

/** No real waiting in tests; the backoff itself is asserted separately. */
const FAST = [0, 0, 0]

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** Queue of canned responses, one per fetch call. */
function mockFetch(responses: unknown[]) {
  let call = 0
  const spy = vi.fn(async () => {
    const body = responses[Math.min(call, responses.length - 1)]
    call += 1
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response
  })
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

const transient = {
  success: false,
  msg: 'Error in query: service::mouse_connectivity_injection_structure, Informatics service request failed',
}

const oneExperiment = {
  success: true,
  msg: [
    {
      id: 180719293,
      'structure-name': 'Secondary motor area',
      'structure-abbrev': 'MOs',
      'transgenic-line': '',
      gender: 'M',
      strain: 'C57BL/6J',
      'injection-volume': 1.047,
      'injection-coordinates': [5400, 1200, 7000],
    },
  ],
}

describe('transient failures', () => {
  it('retries and succeeds when the service recovers', async () => {
    const spy = mockFetch([transient, oneExperiment])
    const results = await searchExperiments(993, { retryDelaysMs: FAST })

    expect(spy).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(1)
    expect(results[0]!.structureAbbrev).toBe('MOs')
  })

  it('survives several consecutive failures', async () => {
    const spy = mockFetch([transient, transient, transient, oneExperiment])
    const results = await searchExperiments(993, { retryDelaysMs: FAST })

    expect(spy).toHaveBeenCalledTimes(4)
    expect(results).toHaveLength(1)
  })

  it('gives up eventually rather than retrying forever', async () => {
    mockFetch([transient])
    await expect(searchExperiments(993, { retryDelaysMs: FAST })).rejects.toBeInstanceOf(TransientApiError)
  })

  it('reports the service detail so the cause is visible', async () => {
    mockFetch([transient])
    await expect(searchExperiments(993, { retryDelaysMs: FAST })).rejects.toThrow(/Informatics service request failed/)
  })
})

describe('permanent failures', () => {
  it('does not retry a genuine rejection', async () => {
    const spy = mockFetch([{ success: false, msg: 'Error in query: bad syntax' }])
    await expect(searchExperiments(1, { retryDelaysMs: FAST })).rejects.toThrow(/rejected the query/)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reports an HTTP failure', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 }) as Response) as typeof fetch
    await expect(searchExperiments(1, { retryDelaysMs: FAST })).rejects.toThrow(/HTTP 503/)
  })
})

describe('empty results', () => {
  it('handles the shape the API really returns for a structure with no data', async () => {
    // Verified against the live service for MOBipl (id 228):
    //   {"success": true, "id": 0, "start_row": 0, "num_rows": 0, "msg": {}}
    // An empty OBJECT, not an empty array. Requiring an array reported this as
    // a query failure — the opposite of what it means.
    mockFetch([{ success: true, id: 0, start_row: 0, num_rows: 0, msg: {} }])
    await expect(searchExperiments(228, { retryDelaysMs: FAST })).resolves.toEqual([])
  })

  it('also accepts an empty array', async () => {
    mockFetch([{ success: true, msg: [] }])
    await expect(searchExperiments(93, { retryDelaysMs: FAST })).resolves.toEqual([])
  })

  it('does not retry an empty result', async () => {
    // Retrying "no data" would make every dead-end search take seconds.
    const spy = mockFetch([{ success: true, num_rows: 0, msg: {} }])
    await searchExperiments(228, { retryDelaysMs: FAST })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('normalising rows', () => {
  it('maps the hyphenated fields the API returns', async () => {
    mockFetch([oneExperiment])
    const [experiment] = await searchExperiments(993, { retryDelaysMs: FAST })

    expect(experiment!.id).toBe(180719293)
    expect(experiment!.structureName).toBe('Secondary motor area')
    expect(experiment!.injectionVolumeMm3).toBeCloseTo(1.047, 6)
    expect(experiment!.injectionCoordinatesUm).toEqual([5400, 1200, 7000])
  })

  it('tolerates rows missing optional fields', async () => {
    mockFetch([{ success: true, msg: [{ id: 5 }] }])
    const [experiment] = await searchExperiments(1, { retryDelaysMs: FAST })

    expect(experiment!.structureAbbrev).toBe('—')
    expect(experiment!.injectionVolumeMm3).toBeNull()
    expect(experiment!.injectionCoordinatesUm).toBeNull()
  })

  it('drops rows with no id rather than emitting a broken entry', async () => {
    mockFetch([{ success: true, msg: [{ foo: 'bar' }, { id: 7 }] }])
    const results = await searchExperiments(1, { retryDelaysMs: FAST })
    expect(results.map((r) => r.id)).toEqual([7])
  })

  it('applies the limit client-side, since the service ignores num_rows', async () => {
    const many = { success: true, msg: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })) }
    mockFetch([many])
    const results = await searchExperiments(1, { limit: 10, retryDelaysMs: FAST })
    expect(results).toHaveLength(10)
  })
})

describe('backoff schedule', () => {
  it('waits progressively longer between real retries', () => {
    // Values, not behaviour: hammering a service that is already struggling
    // makes it worse.
    expect(RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
      expect(RETRY_DELAYS_MS[i]!).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]!)
    }
  })
})

describe('urls and labels', () => {
  it('builds a projection volume url at the requested resolution', () => {
    const url = projectionVolumeUrl(100141219, 100)
    expect(url).toContain('grid_data/download_file/100141219')
    expect(url).toContain('image=projection_density')
    expect(url).toContain('resolution=100')
    // Must be HTTPS: the app is served over HTTPS and mixed content is blocked.
    expect(url.startsWith('https://')).toBe(true)
  })

  it('describes an experiment with its line and volume', async () => {
    mockFetch([oneExperiment])
    const [experiment] = await searchExperiments(993, { retryDelaysMs: FAST })
    expect(describeExperiment(experiment!)).toBe('MOs · wild-type, 1.05 mm³')
  })

  it('cites the experiment and the source paper', async () => {
    mockFetch([oneExperiment])
    const [experiment] = await searchExperiments(993, { retryDelaysMs: FAST })
    const citation = experimentCitation(experiment!)
    expect(citation).toContain('180719293')
    expect(citation).toContain('Oh et al. (2014)')
  })

  it('links to the experiment page', () => {
    expect(experimentUrl(180719293)).toContain('/projection/experiment/180719293')
  })
})
