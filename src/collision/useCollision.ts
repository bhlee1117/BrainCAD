/**
 * Collision checking wired into the React scene.
 *
 * Two caches matter here. BVHs are keyed by geometry, because building one for
 * the brain surface is expensive and moving an object does not change its
 * geometry. Results are recomputed on a short debounce, so dragging a gizmo
 * stays at frame rate and the report catches up when the drag pauses.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Matrix4, type BufferGeometry } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'

import { effectivePivot, resolveGeometry, type SceneObject } from '../objects/model.ts'
import { orientationToQuaternion, solvePlacement } from '../objects/placement.ts'
import { useAppStore } from '../state/store.ts'
import {
  buildBvh,
  checkScene,
  type CollisionMesh,
  type CollisionSettings,
  type SceneCollisionReport,
} from './check.ts'

/**
 * BVHs keyed by geometry identity.
 *
 * A WeakMap so a geometry that is disposed and dropped takes its tree with it;
 * an ordinary Map would keep decimated atlas meshes alive for the session.
 */
const bvhCache = new WeakMap<BufferGeometry, MeshBVH>()

export function cachedBvh(geometry: BufferGeometry): MeshBVH | null {
  const existing = bvhCache.get(geometry)
  if (existing) return existing
  const built = buildBvh(geometry)
  if (built) bvhCache.set(geometry, built)
  return built
}

/** Anatomy meshes contributed by the scene, registered as they load. */
export interface AnatomyMesh {
  id: string
  label: string
  geometry: BufferGeometry
  /** Atlas-to-world matrix for this mesh. */
  matrix: Matrix4
}

/**
 * Build the world matrix for an object, matching how SceneObjects renders it.
 *
 * Derived from the same placement solve rather than read back from the scene
 * graph, so a collision result can never describe a pose different from the
 * numbers in the properties panel.
 */
export function objectWorldMatrix(object: SceneObject): Matrix4 | null {
  const built = resolveGeometry(object)
  if (!built) return null

  const pivot = effectivePivot(object, built)
  const placement = solvePlacement(built.anchor, pivot, object.orientation, object.target)
  const quaternion = orientationToQuaternion(object.orientation)

  return new Matrix4()
    .makeRotationFromQuaternion(quaternion)
    .setPosition(placement.position)
}

export interface CollisionStatus {
  readonly report: SceneCollisionReport | null
  /** True while a recomputation is pending after a change. */
  readonly stale: boolean
}

/**
 * Run scene collision checking, debounced.
 *
 * @param anatomy Anatomy meshes currently visible and participating.
 * @param settings Tolerance and thresholds.
 * @param enabled Whether checking should run at all.
 */
export function useCollision(
  anatomy: readonly AnatomyMesh[],
  settings: CollisionSettings,
  enabled: boolean,
): CollisionStatus {
  const objects = useAppStore((s) => s.objects)
  const [report, setReport] = useState<SceneCollisionReport | null>(null)
  const [stale, setStale] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A cheap signature of everything that can change a result, so the effect
  // re-runs on a moved object but not on an unrelated UI change.
  const signature = useMemo(
    () =>
      JSON.stringify({
        enabled,
        settings,
        anatomy: anatomy.map((a) => a.id),
        objects: objects
          .filter((o) => o.collision && o.visible)
          .map((o) => [
            o.id,
            o.kind,
            o.target,
            o.orientation,
            o.pivotMode,
            o.anatomyCollision,
            o.spec?.params,
          ]),
      }),
    [enabled, settings, anatomy, objects],
  )

  useEffect(() => {
    if (!enabled) {
      setReport(null)
      setStale(false)
      return
    }

    setStale(true)
    if (timer.current) clearTimeout(timer.current)

    timer.current = setTimeout(() => {
      const meshes: CollisionMesh[] = []

      for (const item of anatomy) {
        const bvh = cachedBvh(item.geometry)
        if (!bvh) continue
        meshes.push({
          id: item.id,
          label: item.label,
          geometry: item.geometry,
          bvh,
          matrixWorld: item.matrix,
          kind: 'anatomy',
        })
      }

      for (const object of objects) {
        if (!object.collision || !object.visible) continue
        const built = resolveGeometry(object)
        const matrix = objectWorldMatrix(object)
        if (!built || !matrix) continue

        const bvh = cachedBvh(built.geometry)
        if (!bvh) continue

        meshes.push({
          id: object.id,
          label: object.name,
          geometry: built.geometry,
          bvh,
          matrixWorld: matrix,
          kind: 'hardware',
          ignoreAnatomy: !object.anatomyCollision,
        })
      }

      setReport(checkScene(meshes, settings))
      setStale(false)
    }, 120)

    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [signature, enabled, anatomy, objects, settings])

  return { report, stale }
}
