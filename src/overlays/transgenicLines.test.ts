/**
 * Driver-line description tests.
 *
 * The descriptions themselves come from the Allen API, so what needs covering
 * is how they are condensed for a dense list and — more importantly — that a
 * missing description is never rendered as a confident claim about which cells
 * were labelled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearTransgenicLineCache,
  describeDriver,
  loadTransgenicLines,
  shortPopulation,
  type LineIndex,
  type TransgenicLine,
} from './transgenicLines.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  // The index is cached for the session; without clearing it, one test's
  // fixture leaks into the next and the assertions silently test the wrong data.
  clearTransgenicLineCache()
})

function line(overrides: Partial<TransgenicLine> = {}): TransgenicLine {
  return {
    id: 1,
    name: 'Oxtr-T2A-Cre',
    description:
      'Cre expression is enriched in restricted populations within hippocampal formation, ' +
      'cortical subplate, striatum, thalamus, hypothalamus, and medulla. Sparse, scattered ' +
      'expression in cortex.',
    stockNumber: '031303',
    sourceName: 'JAX',
    url: 'http://jaxmice.jax.org/strain/031303.html',
    originatingLab: 'Allen Institute for Brain Science',
    ...overrides,
  }
}

function index(entries: TransgenicLine[]): LineIndex {
  return new Map(entries.map((l) => [l.name, l]))
}

describe('shortPopulation', () => {
  it('drops the boilerplate opening and keeps the substance', () => {
    // Every Allen description starts "Cre expression is ..."; repeating that on
    // forty rows crowds out the part that differs between them.
    const short = shortPopulation(line())
    expect(short).not.toMatch(/^Cre expression is/)
    expect(short).toContain('hippocampal formation')
  })

  it('keeps only the first sentence', () => {
    expect(shortPopulation(line())).not.toContain('Sparse, scattered')
  })

  it('truncates a very long first sentence with an ellipsis', () => {
    const long = shortPopulation(
      line({ description: `Cre expression is enriched in ${'a region, '.repeat(20)}end.` }),
    )
    expect(long!.length).toBeLessThanOrEqual(90)
    expect(long!.endsWith('…')).toBe(true)
  })

  it('returns null when there is no description', () => {
    expect(shortPopulation(line({ description: null }))).toBeNull()
    expect(shortPopulation(undefined)).toBeNull()
  })

  it('handles the other opening phrasings Allen uses', () => {
    expect(shortPopulation(line({ description: 'Expression is enriched in layer 5.' }))).toBe(
      'enriched in layer 5',
    )
  })
})

describe('describeDriver', () => {
  it('names the labelled population for a known line', () => {
    const driver = describeDriver('Oxtr-T2A-Cre', index([line()]))
    expect(driver.label).toBe('Oxtr-T2A-Cre')
    expect(driver.population).toContain('hippocampal formation')
    expect(driver.line?.stockNumber).toBe('031303')
  })

  it('states wild-type explicitly rather than leaving it blank', () => {
    // An empty field reads as missing data, when it actually means every cell
    // type at the site was labelled — a real difference when interpreting a
    // projection.
    const driver = describeDriver('', index([]))
    expect(driver.label).toBe('wild-type')
    expect(driver.population).toBe('All cell types at the injection site')
    expect(driver.line).toBeNull()
  })

  it('never invents a population for a line it does not know', () => {
    // Guessing what an unfamiliar driver labels would be a fabricated
    // scientific claim; the UI shows the bare name instead.
    const driver = describeDriver('Gpr26-Cre_KO250', index([line()]))
    expect(driver.label).toBe('Gpr26-Cre_KO250')
    expect(driver.population).toBeNull()
    expect(driver.line).toBeNull()
  })

  it('reports no population when the line exists but has no description', () => {
    const driver = describeDriver(
      'Mystery-Cre',
      index([line({ name: 'Mystery-Cre', description: null })]),
    )
    expect(driver.population).toBeNull()
    expect(driver.line?.name).toBe('Mystery-Cre')
  })
})

describe('gene alias selection', () => {
  async function aliasFor(aliasTags: string) {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        success: true,
        msg: [{ acronym: 'X', name: 'a gene', alias_tags: aliasTags }],
      }),
    })) as unknown as typeof fetch
    const { loadGene } = await import('./transgenicLines.ts')
    return (await loadGene(`probe-${Math.random()}`))?.alias ?? null
  }

  it('picks the familiar protein name over an all-caps designation', async () => {
    // Kcnc2's real alias list. KShIIIA is a valid alias but nobody calls it
    // that; Kv3.2 is the name that makes the row informative.
    expect(await aliasFor('AW047325 B230117I07 KShIIIA Kv3.2')).toBe('Kv3.2')
  })

  it('picks Vglut1 out of Slc17a7 aliases', async () => {
    expect(await aliasFor('2900052E22Rik AI851913 Vglut1')).toBe('Vglut1')
  })

  it('drops accession-style identifiers', async () => {
    expect(await aliasFor('AI851913 AW047325')).toBeNull()
  })

  it('returns null when there is no alias at all', async () => {
    expect(await aliasFor('')).toBeNull()
  })
})

describe('repository labelling', () => {
  it('names the distributing repository rather than assuming JAX', async () => {
    // Many lines come from MMRRC; labelling a stock number "JAX" when the link
    // points at MMRRC states something false about where to obtain the animal.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        success: true,
        msg: [
          {
            id: 9,
            name: 'Syt17-Cre_NO14',
            description: 'Cre expression is enriched in layer 1 of frontal cortex.',
            stock_number: '034355',
            transgenic_line_source_name: 'MMRRC',
            url_prefix: 'http://www.mmrrc.org/catalog/getSDS.jsp?mmrrc_id=',
            url_suffix: '',
          },
        ],
      }),
    })) as unknown as typeof fetch

    const lines = await loadTransgenicLines()
    const found = lines.get('Syt17-Cre_NO14')
    expect(found?.sourceName).toBe('MMRRC')
    expect(found?.url).toContain('mmrrc.org')
  })
})

describe('loading', () => {
  it('indexes lines by name and builds repository links', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        success: true,
        msg: [
          {
            id: 7,
            name: 'Slc17a7-IRES2-Cre',
            description: 'Cre expression is enriched in cortical excitatory neurons.',
            stock_number: '023527',
            url_prefix: 'http://jaxmice.jax.org/strain/',
            url_suffix: '.html',
            transgenic_line_source_name: 'JAX',
            originating_lab: 'Allen Institute for Brain Science',
          },
        ],
      }),
    })) as unknown as typeof fetch

    const lines = await loadTransgenicLines()
    const found = lines.get('Slc17a7-IRES2-Cre')

    expect(found?.url).toBe('http://jaxmice.jax.org/strain/023527.html')
    expect(found?.description).toContain('cortical excitatory')
    expect(found?.sourceName).toBe('JAX')
  })

  it('degrades to an empty index instead of breaking the list', async () => {
    // Without descriptions the experiment list still works, just with bare line
    // names — so a failure here must not surface as an error.
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    await expect(loadTransgenicLines()).resolves.toBeInstanceOf(Map)
  })
})
