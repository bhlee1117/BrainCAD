/**
 * A handle onto the live three.js renderer and scene.
 *
 * Exists so code outside the React tree — the export panel, specifically —
 * can render an extra view of the scene that is already on screen, without
 * building a second scene graph that would inevitably drift from the first.
 *
 * Deliberately a single module-level slot rather than context: there is exactly
 * one viewport, and the consumers are imperative actions triggered by a button,
 * not components that need to re-render when it changes.
 */

import type { Scene, WebGLRenderer } from 'three'

interface SceneHandle {
  gl: WebGLRenderer
  scene: Scene
}

let handle: SceneHandle | null = null

export function setSceneHandle(next: SceneHandle | null): void {
  handle = next
}

export function getSceneHandle(): SceneHandle | null {
  return handle
}
