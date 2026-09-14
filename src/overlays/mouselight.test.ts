/**
 * MouseLight bundle tests.
 *
 * The whole risk here is coordinate handling. MouseLight publishes CCF
 * micrometres as (x=ML, y=DV, z=AP); BrainCAD orders every volume-derived
 * position (AP, DV, ML). Both are "CCF micrometres", both look plausible, and
 * getting it wrong does not throw — it puts a brainstem neuron in the olfactory
 * bulb.
 *
 * The reordering happens once, in `scripts/fetch-mouselight.mjs`, so these
 * tests check the artifact that script produced rather than a function that
 * mirrors it. A test of the mirror would pass while the shipped files were
 * wrong.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import { atlasToWorldMatrix } from '../scene/world.ts'
import { decodeNeuron, neuronsInStructure, type NeuronIndex } from './mouselight.ts'
import { positionsToWorld } from './pointCloud.ts'

const DIR = join(process.cwd(), 'public', 'mouselight')
const INDEX_PATH = join(DIR, 'index.json')
const bundled = existsSync(INDEX_PATH)

/** Build a packed neuron the way the fetch script does. */
function pack(axon: number[], dendrite: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(12 + (axon.length + dendrite.length) * 2)
  const view = new DataView(buffer)
  for (const [i, ch] of [...'MLN1'].entries()) view.setUint8(i, ch.charCodeAt(0))
  view.setUint32(4, axon.length / 6, true)
  view.setUint32(8, dendrite.length / 6, true)
  const values = new Int16Array(buffer, 12)
  values.set([...axon, ...dendrite])
  return buffer
}

describe('decodeNeuron', () => {
  it('splits axon from dendrite at the declared boundary', () => {
    const axon = [1, 2, 3, 4, 5, 6]
    const dendrite = [7, 8, 9, 10, 11, 12]
    const out = decodeNeuron(pack(axon, dendrite))
    expect(Array.from(out.axonUm!)).toEqual(axon)
    expect(Array.from(out.dendriteUm!)).toEqual(dendrite)
  })

  it('reports null rather than an empty array for a missing arbor', () => {
    // A neuron with no traced dendrite is common; the control that toggles it
    // must be able to tell "none traced" from "traced and hidden".
    const out = decodeNeuron(pack([1, 2, 3, 4, 5, 6], []))
    expect(out.dendriteUm).toBeNull()
    expect(out.axonUm).not.toBeNull()
  })

  it('refuses a file that is not a packed neuron', () => {
    const wrong = new ArrayBuffer(16)
    expect(() => decodeNeuron(wrong)).toThrow(/Not a MouseLight neuron file/)
  })
})

describe('neuronsInStructure', () => {
  const index: NeuronIndex = {
    generated: '',
    ccfVersion: 'CCFV30',
    source: '',
    neurons: [
      {
        id: 'A',
        somaAcronym: 'VISp5',
        somaName: '',
        somaStructureId: 778,
        somaStructureIdPath: '/997/8/567/688/695/315/669/385/778/',
        soma: null,
        axonSegments: 1,
        dendriteSegments: 0,
      },
      {
        id: 'B',
        somaAcronym: 'CP',
        somaName: '',
        somaStructureId: 672,
        somaStructureIdPath: '/997/8/567/623/477/672/',
        soma: null,
        axonSegments: 1,
        dendriteSegments: 0,
      },
    ],
  }

  it('finds a layer when asked for its parent area', () => {
    // Asking for VISp must return the cell filed under VISp5, or every search
    // for an area returns nothing while its layers hold all the neurons.
    expect(neuronsInStructure(index, 385).map((n) => n.id)).toEqual(['A'])
  })

  it('matches a structure by its own id', () => {
    expect(neuronsInStructure(index, 672).map((n) => n.id)).toEqual(['B'])
  })

  it('does not match on a substring of a longer id', () => {
    // "/385/" must not match inside "/1385/"; the delimiters are load-bearing.
    expect(neuronsInStructure(index, 38)).toEqual([])
    expect(neuronsInStructure(index, 85)).toEqual([])
  })
})

describe.skipIf(!bundled)('the bundled artifact', () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8')) as NeuronIndex

  it('is registered to CCFv3, not CCFv2.5', () => {
    // Omitting ccfVersion on the fetch silently yields v2.5 coordinates.
    expect(index.ccfVersion).toBe('CCFV30')
  })

  it('places every soma inside the atlas, in (AP, DV, ML) order', () => {
    // CCFv3 spans 13.2 x 8.0 x 11.4 mm. A transposed axis order puts AP values
    // up to 13200 into the 8000-wide DV slot, so this fails loudly.
    for (const neuron of index.neurons) {
      if (!neuron.soma) continue
      const [ap, dv, ml] = neuron.soma
      expect(ap, `${neuron.id} AP`).toBeGreaterThanOrEqual(0)
      expect(ap, `${neuron.id} AP`).toBeLessThan(13200)
      expect(dv, `${neuron.id} DV`).toBeLessThan(8000)
      expect(ml, `${neuron.id} ML`).toBeLessThan(11400)
    }
  })

  it('matches MouseLight’s published soma for AA0325', () => {
    // Janelia reports AA0325's soma as x=6948.0, y=3294.9, z=3275.7 in its own
    // (ML, DV, AP) order — so reordered and rounded it must be this triple.
    const neuron = index.neurons.find((n) => n.id === 'AA0325')
    if (!neuron) return // not in the curated set; the sweep above still applies
    expect(neuron.soma).toEqual([3276, 3295, 6948])
  })

  it('decodes a real neuron file into segments near its own soma', () => {
    const neuron = index.neurons.find((n) => n.soma && n.axonSegments > 100)!
    const file = readFileSync(join(DIR, `${neuron.id}.bin`))
    const out = decodeNeuron(
      file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
    )

    expect(out.axonUm).not.toBeNull()
    expect(out.axonUm!.length).toBe(neuron.axonSegments * 6)

    // The first segment starts at the soma end of the arbor, so it should be
    // within a few millimetres of the reported soma — a transposed or unscaled
    // file would be tens of millimetres away.
    const [ap, dv, ml] = [out.axonUm![0]!, out.axonUm![1]!, out.axonUm![2]!]
    const soma = neuron.soma!
    const distance = Math.hypot(ap - soma[0], dv - soma[1], ml - soma[2])
    expect(distance, `${neuron.id} first segment to soma`).toBeLessThan(6000)
  })

  it('puts a right-hemisphere soma at positive world ML', () => {
    const right = index.neurons.find((n) => n.soma && n.soma[2] > 6500)
    if (!right) return
    const world = positionsToWorld(
      Float32Array.from(right.soma!),
      atlasToWorldMatrix(ALLEN_CCFV3_50UM),
    )
    expect(world[0]).toBeGreaterThan(0)
  })
})
