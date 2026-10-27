/**
 * Loading one atlas region mesh by structure id.
 *
 * Its own module because two canvases want it: the main viewport draws the
 * brain shell and whatever regions are toggled on, and the heat-map view draws
 * the same shell for context. Keeping one loader means they cannot end up
 * showing two different brains.
 */

import { useEffect, useState } from 'react'
import type { BufferGeometry } from 'three'

import { atlasUrl } from '../atlas/load.ts'
import { loadAtlasMesh } from '../atlas/mesh.ts'

/** Load one atlas mesh by structure id, returning null until it arrives. */
export function useAtlasMeshGeometry(structureId: number): BufferGeometry | null {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let loaded: BufferGeometry | null = null

    loadAtlasMesh(atlasUrl(`meshes/${structureId}.msh`), controller.signal)
      .then((mesh) => {
        if (disposed) {
          mesh.geometry.dispose()
          return
        }
        loaded = mesh.geometry
        setGeometry(mesh.geometry)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(`Could not load mesh ${structureId}`, error)
        }
      })

    return () => {
      disposed = true
      controller.abort()
      loaded?.dispose()
    }
  }, [structureId])

  return geometry
}
