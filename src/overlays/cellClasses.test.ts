/**
 * Cell-class table tests.
 *
 * This table makes scientific claims, so what matters most is the boundary: it
 * must answer confidently where the marker-to-population relationship is
 * established, and say nothing at all where it is not. A fabricated cell class
 * on a surgical planning screen is worse than a blank.
 */

import { describe, expect, it } from 'vitest'

import {
  CELL_CLASSES,
  CELL_CLASS_CAVEAT,
  CONFIDENCE_LABEL,
  cellClassForLine,
  geneFromLineName,
} from './cellClasses.ts'

describe('geneFromLineName', () => {
  it.each([
    ['Kcnc2-Cre', 'Kcnc2'],
    ['Slc17a7-IRES2-Cre', 'Slc17a7'],
    ['Pvalb-T2A-FlpO', 'Pvalb'],
    ['Gpr26-Cre_KO250', 'Gpr26'],
    ['Syt17-Cre_NO14', 'Syt17'],
    ['Oxtr-T2A-Cre', 'Oxtr'],
  ])('reads %s as %s', (line, gene) => {
    expect(geneFromLineName(line)).toBe(gene)
  })

  it('returns null for a blank name', () => {
    expect(geneFromLineName('')).toBeNull()
  })

  it('rejects reporter lines, which name no driver gene', () => {
    expect(geneFromLineName('Ai14')).toBeNull()
    expect(geneFromLineName('CAG-tdTomato')).toBeNull()
  })
})

describe('the case that prompted this table', () => {
  it('identifies Kcnc2 as fast-spiking GABAergic interneurons', () => {
    // Allen's own description for Kcnc2-Cre lists anatomy — "piriform cortex,
    // thalamus, hippocampus" — and never says which cells. That the gene is
    // Kv3.2, and that Kv3.2 confers fast spiking in PV interneurons, is the
    // fact a reader needs.
    const found = cellClassForLine('Kcnc2-Cre')
    expect(found).not.toBeNull()
    expect(found!.population).toMatch(/fast-spiking/i)
    expect(found!.population).toMatch(/GABAergic/i)
    expect(found!.marker).toContain('Kv3.2')
  })

  it('flags that Kv3 channels are not exclusive to interneurons', () => {
    expect(cellClassForLine('Kcnc2-Cre')!.caveat).toBeTruthy()
    expect(cellClassForLine('Kcnc2-Cre')!.confidence).toBe('enriched')
  })
})

describe('refusing to guess', () => {
  it.each(['Gpr26-Cre_KO250', 'Ppp1r17-Cre_NL146', 'Syt17-Cre_NO14', 'Vipr2-Cre_KE2'])(
    'claims no cell class for %s',
    (line) => {
      // These appear in real result lists. Inventing a population for them
      // would fabricate a claim about which neurons were traced.
      expect(cellClassForLine(line)).toBeNull()
    },
  )

  it('claims nothing for a line with no driver gene', () => {
    expect(cellClassForLine('Ai14')).toBeNull()
  })
})

describe('table integrity', () => {
  const entries = Object.entries(CELL_CLASSES)

  it('is keyed by gene symbol in Allen’s capitalisation', () => {
    for (const [gene] of entries) {
      expect(gene).toMatch(/^[A-Z][A-Za-z0-9]*$/)
    }
  })

  it('gives every entry a population, a marker and a confidence', () => {
    for (const [gene, entry] of entries) {
      expect(entry.population.length, gene).toBeGreaterThan(5)
      expect(entry.marker.length, gene).toBeGreaterThan(3)
      expect(['established', 'enriched']).toContain(entry.confidence)
    }
  })

  it('explains the marker rather than restating the symbol', () => {
    // "Kcnc2 — Kcnc2" helps nobody; the point is to decode the symbol.
    for (const [gene, entry] of entries) {
      expect(entry.marker.toLowerCase(), gene).not.toBe(gene.toLowerCase())
    }
  })

  it('covers the neurotransmitter markers that define the basic classes', () => {
    for (const gene of ['Gad2', 'Slc32a1', 'Slc17a7', 'Slc17a6', 'Chat', 'Th', 'Slc6a4']) {
      expect(CELL_CLASSES[gene], gene).toBeDefined()
      expect(CELL_CLASSES[gene]!.confidence).toBe('established')
    }
  })

  it('covers the canonical interneuron subclasses', () => {
    for (const gene of ['Pvalb', 'Sst', 'Vip']) {
      expect(CELL_CLASSES[gene], gene).toBeDefined()
    }
  })

  it('marks broader markers as enriched rather than defining', () => {
    // Calbindin labels excitatory neurons too; claiming it defines a class
    // would overstate what the overlay shows.
    expect(CELL_CLASSES.Calb1!.confidence).toBe('enriched')
    expect(CELL_CLASSES.Calb1!.caveat).toBeTruthy()
    expect(CELL_CLASSES.Rbp4!.confidence).toBe('enriched')
  })
})

describe('attribution', () => {
  it('states that the summary is curated, not Allen data', () => {
    // The row places this beside Allen's own text; without this the curated
    // claim would read as though the atlas had made it.
    expect(CELL_CLASS_CAVEAT).toMatch(/not Allen data/i)
  })

  it('warns that a Cre line labels an expression pattern, not a clean class', () => {
    expect(CELL_CLASS_CAVEAT).toMatch(/expression pattern/i)
    expect(CELL_CLASS_CAVEAT).toMatch(/vary by region/i)
  })

  it('labels both confidence levels distinctly', () => {
    expect(CONFIDENCE_LABEL.established).not.toBe(CONFIDENCE_LABEL.enriched)
  })
})
