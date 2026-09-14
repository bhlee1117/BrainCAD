/**
 * Overview captures of the whole plan, for the planning sheet.
 *
 * The sheet used to embed `canvas.toDataURL()` of the live viewport, which is
 * why its Scene section came out empty: WebGL clears the drawing buffer after
 * every frame unless the context was created with `preserveDrawingBuffer`, so
 * by the time the export ran there was nothing left to read. Turning that flag
 * on would cost every frame of the interactive view to serve one button, so the
 * capture is rendered offscreen instead — the same approach the objective view
 * already uses, and it has the larger advantage that the sheet no longer
 * depends on wherever the user happened to leave the camera.
 *
 * Four fixed viewpoints, because a plan is read the way a drawing is: one
 * oblique to understand the arrangement, and three orthogonal views to judge
 * the angles, which an oblique alone makes impossible.
 */

import {
  Box3,
  DirectionalLight,
  type Mesh,
  OrthographicCamera,
  Object3D,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

import { ANATOMY_FLAG } from '../scene/Helper.tsx'

const RENDER_SIZE = 700

export interface OverviewView {
  readonly name: string
  readonly dataUrl: string
}

/**
 * The four viewpoints, in world space.
 *
 * World axes are +X to the animal's right, +Y dorsal, +Z anterior.
 *
 * `up` for the dorsal view is anterior rather than dorsal: looking straight
 * down, dorsal is the direction of view and cannot also be "up" on the page.
 * Anterior-up is how every atlas plate draws a horizontal section.
 */
const VIEWPOINTS: readonly {
  name: string
  direction: readonly [number, number, number]
  up: readonly [number, number, number]
}[] = [
  { name: 'Oblique 45°', direction: [1, 0.8, 1], up: [0, 1, 0] },
  { name: 'Front (anterior)', direction: [0, 0, 1], up: [0, 1, 0] },
  { name: 'Top (dorsal)', direction: [0, 1, 0], up: [0, 0, 1] },
  { name: 'Left', direction: [-1, 0, 0], up: [0, 1, 0] },
]

/**
 * Render the scene from each standard viewpoint.
 *
 * Helper decoration — target markers, labels, the axis triad — is deliberately
 * kept. Unlike the objective view, which must show only what can physically
 * block light, an overview is a drawing of the plan and the annotations are the
 * point of it. Only the transform gizmo is hidden, being an artifact of editing
 * rather than part of the plan.
 */
export function renderOverviewViews(gl: WebGLRenderer, scene: Scene): OverviewView[] {
  const hidden: Object3D[] = []
  scene.traverse((node) => {
    if (!node.visible) return
    // Matched by type because three.js attaches TransformControls' visual root
    // to the scene itself, not to the React element that declared it.
    const isGizmo =
      node.type.startsWith('TransformControls') ||
      node.constructor?.name?.startsWith('TransformControls') === true
    if (isGizmo) {
      node.visible = false
      hidden.push(node)
    }
  })

  const bounds = boundingSphere(scene)
  const headlight = new DirectionalLight(0xffffff, 2.2)
  scene.add(headlight)
  scene.add(headlight.target)

  const target = new WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE)
  const previousTarget = gl.getRenderTarget()
  const views: OverviewView[] = []

  try {
    for (const viewpoint of VIEWPOINTS) {
      const direction = new Vector3(...viewpoint.direction).normalize()
      // A little margin so nothing touches the frame edge.
      const half = bounds.radius * 1.12
      const camera = new OrthographicCamera(-half, half, half, -half, 0.01, bounds.radius * 8)
      const eye = bounds.center.clone().addScaledVector(direction, bounds.radius * 4)
      camera.position.copy(eye)
      camera.up.set(...viewpoint.up)
      camera.lookAt(bounds.center)
      camera.updateProjectionMatrix()

      // The viewport's lights sit behind the interactive camera, so three of
      // these four directions would render the anatomy unlit. A light that
      // travels with each capture keeps them comparable.
      headlight.position.copy(eye)
      headlight.target.position.copy(bounds.center)
      headlight.target.updateMatrixWorld()

      gl.setRenderTarget(target)
      gl.render(scene, camera)
      const pixels = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4)
      gl.readRenderTargetPixels(target, 0, 0, RENDER_SIZE, RENDER_SIZE, pixels)

      const dataUrl = toDataUrl(pixels)
      if (dataUrl) views.push({ name: viewpoint.name, dataUrl })
    }
  } catch (error) {
    // Say why. A silently missing Scene section is indistinguishable from
    // "there was nothing to show" — which is the bug this replaced.
    console.warn('Overview capture failed', error)
  } finally {
    gl.setRenderTarget(previousTarget)
    target.dispose()
    scene.remove(headlight)
    scene.remove(headlight.target)
    headlight.dispose()
    for (const node of hidden) node.visible = true
  }

  return views
}

/** Whether a node sits inside the anatomy group. */
function isDescendantOfAnatomy(node: Object3D): boolean {
  for (let at: Object3D | null = node; at; at = at.parent) {
    if (at.userData?.[ANATOMY_FLAG] === true) return true
  }
  return false
}

/** Roughly the mouse brain, for framing when nothing measurable is present. */
const FALLBACK_CENTRE: readonly [number, number, number] = [0, -3, -1]
const FALLBACK_RADIUS = 9

/**
 * A sphere enclosing everything drawn, used to frame every view identically.
 *
 * One sphere for all four, rather than a per-view box, so the captures share a
 * scale and can be compared against each other.
 *
 * Built with `traverseVisible` rather than `Box3.setFromObject`, which ignores
 * visibility and walks hidden subtrees too. That difference was not academic:
 * TransformControls' invisible picker planes are tens of thousands of units
 * across, so the bounds came out vast and every capture rendered the whole
 * plan into a single pixel. The gizmo is hidden before this runs, so skipping
 * invisible subtrees excludes it.
 */
function boundingSphere(scene: Scene): Sphere {
  scene.updateMatrixWorld(true)

  const box = new Box3()
  const anatomyBox = new Box3()
  const nodeBox = new Box3()

  scene.traverseVisible((node) => {
    const geometry = (node as Mesh).geometry
    if (!geometry) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const local = geometry.boundingBox
    if (!local || local.isEmpty()) return

    nodeBox.copy(local).applyMatrix4(node.matrixWorld)
    // A single non-finite vertex would otherwise poison the whole frame.
    if (
      !Number.isFinite(nodeBox.min.x) ||
      !Number.isFinite(nodeBox.max.x) ||
      !Number.isFinite(nodeBox.min.y) ||
      !Number.isFinite(nodeBox.max.y) ||
      !Number.isFinite(nodeBox.min.z) ||
      !Number.isFinite(nodeBox.max.z)
    ) {
      return
    }
    box.union(nodeBox)
    if (isDescendantOfAnatomy(node)) anatomyBox.union(nodeBox)
  })

  // Prefer the anatomy, widened enough to carry the working end of nearby
  // hardware. Framing on everything is dominated by an objective barrel tens of
  // millimetres long, which renders the brain a few pixels across — the first
  // version of this did exactly that.
  if (!anatomyBox.isEmpty()) {
    const anatomy = new Sphere()
    anatomyBox.getBoundingSphere(anatomy)
    if (Number.isFinite(anatomy.radius) && anatomy.radius > 0) {
      anatomy.radius *= 1.45
      return anatomy
    }
  }

  const sphere = new Sphere()
  if (box.isEmpty()) {
    sphere.center.set(...FALLBACK_CENTRE)
    sphere.radius = FALLBACK_RADIUS
    return sphere
  }

  box.getBoundingSphere(sphere)
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    sphere.center.set(...FALLBACK_CENTRE)
    sphere.radius = FALLBACK_RADIUS
  }
  return sphere
}

/** Flip the GL rows into image order and encode as PNG. */
function toDataUrl(pixels: Uint8Array): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = RENDER_SIZE
  canvas.height = RENDER_SIZE
  const context = canvas.getContext('2d')
  if (!context) return null

  const image = context.createImageData(RENDER_SIZE, RENDER_SIZE)
  for (let y = 0; y < RENDER_SIZE; y++) {
    // GL reads bottom-up; canvas expects top-down.
    const source = (RENDER_SIZE - 1 - y) * RENDER_SIZE * 4
    const destination = y * RENDER_SIZE * 4
    image.data.set(pixels.subarray(source, source + RENDER_SIZE * 4), destination)
  }

  // Composite onto the viewport's own ground so transparent background pixels
  // do not print as white boxes around the brain.
  context.fillStyle = '#0b0e13'
  context.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE)
  const layer = document.createElement('canvas')
  layer.width = RENDER_SIZE
  layer.height = RENDER_SIZE
  layer.getContext('2d')?.putImageData(image, 0, 0)
  context.drawImage(layer, 0, 0)

  return canvas.toDataURL('image/png')
}
