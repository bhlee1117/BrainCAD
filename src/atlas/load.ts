/**
 * Atlas asset loading.
 *
 * Everything here is fetched from the app's own static `public/atlas/` output,
 * so BrainCAD runs with no backend and no runtime dependency on the Allen
 * servers — apart from lazily-loaded region meshes, which are optional.
 */

import { AnnotationVolume } from './annotation.ts'
import { parseNrrdAsync } from './nrrd.ts'
import type { Structure, StructureIndex } from './ontology.ts'
import { buildColorTable, buildIndex, type ColorTable } from './ontology.ts'
import { makeVolumeSpace, type VolumeSpace } from './space.ts'

export interface AtlasManifest {
  readonly generatedAt: string
  readonly annotation: {
    readonly file: string
    readonly bytes: number
    readonly sha256: string
    readonly resolutionUm: number
    readonly orientation: string
    readonly source: string
  }
  readonly ontology: { readonly file: string; readonly count: number; readonly source: string }
  readonly meshes: readonly {
    readonly id: number
    readonly name: string
    readonly triangles: number
    readonly bytes: number
    readonly file: string
  }[]
  readonly lazyMeshBaseUrl: string
  readonly citation: string
}

export interface LoadedAtlas {
  readonly manifest: AtlasManifest
  readonly volume: AnnotationVolume
  readonly space: VolumeSpace
  readonly structures: readonly Structure[]
  readonly index: StructureIndex
  readonly colors: ColorTable
}

/** Resolve a path inside the atlas asset directory, honouring Vite's base URL. */
export function atlasUrl(path: string): string {
  return `${import.meta.env.BASE_URL}atlas/${path}`.replace(/([^:])\/{2,}/g, '$1/')
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
  return (await response.json()) as T
}

export interface LoadProgress {
  readonly stage: 'manifest' | 'ontology' | 'annotation' | 'ready'
  readonly message: string
}

/**
 * Load the atlas assets needed before the app can show anything anatomical.
 *
 * The annotation volume decodes to a ~38 MB typed array, so this is the one
 * genuinely heavy step. It is worth it: that array answers region lookup and
 * all three slice views for the rest of the session with no further fetches.
 */
/**
 * In-flight/completed load, shared across callers.
 *
 * The decoded volume is 38.5 MB. React StrictMode deliberately runs effects
 * twice in development, and without this the second run decodes a second copy
 * while the first is still live — enough to exhaust the tab's ArrayBuffer
 * budget. The atlas assets never change during a session, so one load is
 * always correct.
 */
let cachedLoad: Promise<LoadedAtlas> | null = null

/**
 * Deliberately takes no AbortSignal. The shared promise outlives whichever
 * caller happened to start it, so honouring one caller's cancellation would
 * abort the load for everyone — which is exactly what StrictMode's first
 * effect cleanup did before this was removed. Callers that no longer want the
 * result should discard it, not cancel the load.
 */
export function loadAtlas(
  onProgress?: (progress: LoadProgress) => void,
): Promise<LoadedAtlas> {
  cachedLoad ??= loadAtlasUncached(onProgress).catch((error: unknown) => {
    // Let a failed load be retried rather than caching the failure forever.
    cachedLoad = null
    throw error
  })
  return cachedLoad
}

async function loadAtlasUncached(
  onProgress?: (progress: LoadProgress) => void,
): Promise<LoadedAtlas> {
  onProgress?.({ stage: 'manifest', message: 'Reading atlas manifest' })
  const manifest = await fetchJson<AtlasManifest>(atlasUrl('manifest.json'))

  onProgress?.({ stage: 'ontology', message: 'Loading structure ontology' })
  const structures = await fetchJson<Structure[]>(atlasUrl(manifest.ontology.file))
  const index = buildIndex(structures)
  const colors = buildColorTable(index)

  onProgress?.({
    stage: 'annotation',
    message: `Decoding annotation volume (${(manifest.annotation.bytes / 1e6).toFixed(1)} MB)`,
  })
  const response = await fetch(atlasUrl(manifest.annotation.file))
  if (!response.ok) {
    throw new Error(`Failed to load annotation volume: HTTP ${response.status}`)
  }
  const nrrd = await parseNrrdAsync(await response.arrayBuffer())

  const space = makeVolumeSpace(
    nrrd.shape,
    manifest.annotation.resolutionUm,
    manifest.annotation.orientation,
  )

  // The annotation is uint32 on disk. Normalise to Uint32Array so the volume
  // has one concrete element type regardless of how a future asset is encoded.
  const labels =
    nrrd.data instanceof Uint32Array ? nrrd.data : Uint32Array.from(nrrd.data as ArrayLike<number>)

  const volume = new AnnotationVolume(space, labels)

  onProgress?.({ stage: 'ready', message: 'Atlas ready' })
  return { manifest, volume, space, structures, index, colors }
}
