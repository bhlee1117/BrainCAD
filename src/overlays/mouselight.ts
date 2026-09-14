/**
 * MouseLight single-neuron reconstructions (Janelia).
 *
 * Where the Allen connectivity overlay answers "what does this region project
 * to, on average, across a bulk injection", this answers "where does one axon
 * actually go". Same atlas, two resolutions of the same question, which is why
 * it lives in the same panel rather than a tab of its own.
 *
 * 1,653 neurons, reconstructed end to end from whole-brain light microscopy and
 * registered to CCF. BrainCAD serves a curated subset from its own origin
 * rather than calling Janelia at runtime, for a reason worth recording: the
 * MouseLight search endpoint sends `Access-Control-Allow-Origin: *` and works
 * fine from a browser, but `/tracings/graphql` — the endpoint that actually
 * carries node coordinates — sends no CORS headers at all. The browser blocks
 * it in dev and on a static deploy alike. So `scripts/fetch-mouselight.mjs`
 * pulls the data at build time and this module reads the result, exactly as the
 * atlas meshes are handled.
 *
 * Three things about the source data are worth stating plainly, because each is
 * a silent wrong answer rather than an error:
 *
 *  - **MouseLight publishes (x=ML, y=DV, z=AP)** — the opposite order from the
 *    CCF voxel arrays this app uses everywhere else, and from Allen's own
 *    `cell_soma_locations`. Both are "CCF micrometres". Swapping them puts a
 *    brainstem neuron in the olfactory bulb. The fetch script reorders once, on
 *    the way in.
 *  - **`ccfVersion` must be sent explicitly.** Omitted, the tracings endpoint
 *    answers in CCFv2.5, whose coordinates differ from CCFv3 by tens of
 *    micrometres — close enough to look right and be wrong.
 *  - **`brainArea.atlasId` is not the Allen structure id.** Allen 385 is VISp;
 *    `atlasId` 385 is RHP. The real id is the last segment of
 *    `structureIdPath`, which is what the fetch script joins on.
 */


// ---------------------------------------------------------------------------
// The bundled set
// ---------------------------------------------------------------------------

/** Resolve a path inside the MouseLight asset directory, honouring Vite's base. */
export function mouselightUrl(path: string): string {
  return `${import.meta.env.BASE_URL}mouselight/${path}`.replace(/([^:])\/{2,}/g, '$1/')
}

export interface NeuronIndexEntry {
  readonly id: string
  readonly somaAcronym: string | null
  readonly somaName: string | null
  readonly somaStructureId: number | null
  /** Allen ancestor path, e.g. "/997/8/567/688/695/315/669/385/". */
  readonly somaStructureIdPath: string | null
  readonly soma: readonly [number, number, number] | null
  readonly axonSegments: number
  readonly dendriteSegments: number
}

export interface NeuronIndex {
  readonly generated: string
  readonly ccfVersion: string
  readonly source: string
  readonly neurons: readonly NeuronIndexEntry[]
}

let indexPromise: Promise<NeuronIndex> | null = null

/**
 * Load the bundled neuron index.
 *
 * Served same-origin rather than fetched from Janelia, because the endpoint
 * that carries node coordinates sends no CORS headers — see the module note.
 * A missing bundle is reported as such rather than as a network error, since
 * the fix is to run the fetch script, not to retry.
 */
export function loadNeuronIndex(): Promise<NeuronIndex> {
  indexPromise ??= (async () => {
    const response = await fetch(mouselightUrl('index.json'))
    if (!response.ok) {
      throw new Error(
        'No MouseLight neurons are bundled with this build. ' +
          'Run `npm run mouselight:fetch` to add them.',
      )
    }
    return (await response.json()) as NeuronIndex
  })()
  return indexPromise
}

/** Drop the cached index. Tests only. */
export function clearNeuronIndexCache(): void {
  indexPromise = null
}

/**
 * Bundled neurons whose soma lies in a structure, or anywhere below it.
 *
 * Matches on the Allen ancestor path rather than the structure id alone, so
 * asking for VISp finds the cells filed under VISp5 and VISp6a without needing
 * the caller to expand the subtree.
 */
export function neuronsInStructure(
  index: NeuronIndex,
  allenStructureId: number,
): NeuronIndexEntry[] {
  const needle = `/${allenStructureId}/`
  return index.neurons.filter(
    (n) =>
      n.somaStructureId === allenStructureId ||
      (n.somaStructureIdPath?.includes(needle) ?? false),
  )
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Magic bytes at the head of a packed neuron file. */
const MAGIC = 'MLN1'

/**
 * Decode a packed neuron.
 *
 * Coordinates were reordered to (AP, DV, ML) and rounded to int16 micrometres
 * when the file was written; this is the exact inverse, and the only place that
 * layout is understood on the client.
 */
export function decodeNeuron(buffer: ArrayBuffer): {
  axonUm: Float32Array | null
  dendriteUm: Float32Array | null
} {
  const view = new DataView(buffer)
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  )
  if (magic !== MAGIC) {
    throw new Error(`Not a MouseLight neuron file (magic ${JSON.stringify(magic)})`)
  }

  const axonSegments = view.getUint32(4, true)
  const dendriteSegments = view.getUint32(8, true)
  const values = new Int16Array(buffer, 12, (axonSegments + dendriteSegments) * 6)

  const take = (from: number, segments: number) =>
    segments === 0 ? null : Float32Array.from(values.subarray(from, from + segments * 6))

  return {
    axonUm: take(0, axonSegments),
    dendriteUm: take(axonSegments * 6, dendriteSegments),
  }
}

/** Fetch and decode one bundled neuron. */
export async function loadNeuronGeometry(idString: string): Promise<{
  axonUm: Float32Array | null
  dendriteUm: Float32Array | null
}> {
  const response = await fetch(mouselightUrl(`${idString}.bin`))
  if (!response.ok) {
    throw new Error(`${idString} is not in the bundled set (HTTP ${response.status}).`)
  }
  return decodeNeuron(await response.arrayBuffer())
}

/** Citation for a loaded neuron, shown in the UI and the planning sheet. */
export function neuronCitation(neuron: NeuronIndexEntry): string {
  return (
    `MouseLight ${neuron.id}` +
    (neuron.somaAcronym ? ` (soma in ${neuron.somaAcronym})` : '') +
    ' — Winnubst et al. (2019), Cell 179(1):268-281.'
  )
}

export function neuronUrl(idString: string): string {
  return `https://ml-neuronbrowser.janelia.org/?neuron=${encodeURIComponent(idString)}`
}

/** Things a reader must know before acting on a single reconstruction. */
export const MOUSELIGHT_CAVEATS: readonly string[] = [
  'One reconstructed neuron from one animal — not a population, and not a prediction for yours.',
  'Reconstructions are complete as traced; a missing branch means it was not traced, not that it does not exist.',
  'Registered to CCFv3, so it inherits the same averaged-brain caveats as the atlas.',
  'Soma region is MouseLight’s own assignment, which can differ from a lookup in this atlas near boundaries.',
  'Only a curated subset is bundled with this build, so an empty result is not evidence that no neuron projects there.',
]
