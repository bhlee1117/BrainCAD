/**
 * Rendering the expected view through an objective.
 *
 * Answers the question an optical-access plan actually turns on: *from where
 * the objective sits, looking down its own axis, what is in the way?* A
 * clearance number says the barrel fits; this says whether the light path is
 * occluded by a headbar, a cannula, or the edge of a craniotomy.
 *
 * The camera is orthographic, not perspective. A microscope objective images a
 * focal plane at fixed magnification, so an orthographic frustum sized to the
 * field of view is the honest model; a perspective camera would introduce
 * convergence the real instrument does not have.
 */

import {
  OrthographicCamera,
  Vector3,
  WebGLRenderTarget,
  type Scene,
  type WebGLRenderer,
} from 'three'

import { effectivePivot, resolveGeometry, type SceneObject } from '../objects/model.ts'
import { localToWorld, solvePlacement, worldAxis } from '../objects/placement.ts'
import type { ObjectiveParams } from '../objects/primitives.ts'

/** Square edge of the rendered image, in pixels. */
const RENDER_SIZE = 512

/**
 * Where the objective's camera sits and what it looks at.
 *
 * Separated from the rendering so the geometry — the part that can be silently
 * wrong — is testable without a WebGL context or a DOM.
 */
export interface ObjectiveViewGeometry {
  /** Camera position: the front element, one working distance from focus. */
  readonly eye: Vector3
  /** Point the camera aims at, beyond the focal plane. */
  readonly lookAt: Vector3
  /** The focal point itself. */
  readonly focal: Vector3
  /** Unit optical axis, pointing from objective toward sample. */
  readonly axis: Vector3
  readonly fieldOfViewMm: number
  readonly workingDistanceMm: number
}

/**
 * Compute the objective's view geometry, or null when it cannot be resolved.
 *
 * Disposes any geometry it derived, so callers need not.
 */
export function objectiveViewGeometry(
  objective: SceneObject,
): ObjectiveViewGeometry | null {
  const built = resolveGeometry(objective)
  if (!built) return null

  const params = objective.spec?.params as ObjectiveParams | undefined
  if (!params) {
    if (objective.kind !== 'custom') built.geometry.dispose()
    return null
  }

  const fieldOfViewMm = Math.max(0.05, params.fieldOfViewMm ?? 1)
  const workingDistanceMm = params.workingDistanceMm

  // Through the same placement solve the rendered geometry used, so the view
  // can never describe a pose different from the one on screen.
  const pivot = effectivePivot(objective, built)
  const placement = solvePlacement(built.anchor, pivot, objective.orientation, objective.target)
  const focal = localToWorld(built.anchor, placement, pivot)
  const axis = worldAxis(built.axis, objective.orientation).normalize()

  if (objective.kind !== 'custom') built.geometry.dispose()

  return {
    // The front element sits one working distance back along the axis.
    eye: focal.clone().sub(axis.clone().multiplyScalar(workingDistanceMm)),
    // Aiming beyond the focal plane keeps it inside the frustum rather than
    // clipped at its far edge.
    lookAt: focal.clone().add(axis.clone().multiplyScalar(workingDistanceMm)),
    focal,
    axis,
    fieldOfViewMm,
    workingDistanceMm,
  }
}

export interface ObjectiveViewResult {
  /** PNG data URL of the circular field of view. */
  readonly dataUrl: string
  /** Field diameter actually rendered, in millimetres. */
  readonly fieldOfViewMm: number
  /** Working distance used to place the camera. */
  readonly workingDistanceMm: number
}

/**
 * Render the scene as the objective would see it.
 *
 * Returns null when the objective has no resolvable geometry or the renderer
 * is unavailable — the caller must treat that as "no view", never as "clear
 * view".
 */
export function renderObjectiveView(
  gl: WebGLRenderer,
  scene: Scene,
  objective: SceneObject,
): ObjectiveViewResult | null {
  const view = objectiveViewGeometry(objective)
  if (!view) return null

  const half = view.fieldOfViewMm / 2
  const camera = new OrthographicCamera(
    -half,
    half,
    half,
    -half,
    0.01,
    view.workingDistanceMm * 6,
  )
  camera.position.copy(view.eye)
  camera.up.set(0, 1, 0)
  camera.lookAt(view.lookAt)
  camera.updateProjectionMatrix()

  const target = new WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE)
  const previousTarget = gl.getRenderTarget()

  let pixels: Uint8Array
  try {
    gl.setRenderTarget(target)
    gl.render(scene, camera)
    pixels = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4)
    gl.readRenderTargetPixels(target, 0, 0, RENDER_SIZE, RENDER_SIZE, pixels)
  } catch {
    return null
  } finally {
    gl.setRenderTarget(previousTarget)
    target.dispose()
  }

  const dataUrl = composeFieldImage(pixels, view.fieldOfViewMm)
  return dataUrl
    ? {
        dataUrl,
        fieldOfViewMm: view.fieldOfViewMm,
        workingDistanceMm: view.workingDistanceMm,
      }
    : null
}

/**
 * Draw the raw pixels into a circular aperture with a scale bar.
 *
 * The circular mask is not decoration: a square frame would imply the objective
 * sees the corners, and someone judging occlusion from this image needs the
 * real aperture shape.
 */
function composeFieldImage(pixels: Uint8Array, fieldOfViewMm: number): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = RENDER_SIZE
  canvas.height = RENDER_SIZE
  const context = canvas.getContext('2d')
  if (!context) return null

  // WebGL reads bottom-up; canvas draws top-down.
  const image = context.createImageData(RENDER_SIZE, RENDER_SIZE)
  for (let y = 0; y < RENDER_SIZE; y++) {
    const source = (RENDER_SIZE - 1 - y) * RENDER_SIZE * 4
    const destination = y * RENDER_SIZE * 4
    image.data.set(pixels.subarray(source, source + RENDER_SIZE * 4), destination)
  }

  const scratch = document.createElement('canvas')
  scratch.width = RENDER_SIZE
  scratch.height = RENDER_SIZE
  scratch.getContext('2d')?.putImageData(image, 0, 0)

  // Outside the aperture is black, as it would be down a barrel.
  context.fillStyle = '#000'
  context.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE)

  context.save()
  context.beginPath()
  context.arc(RENDER_SIZE / 2, RENDER_SIZE / 2, RENDER_SIZE / 2 - 2, 0, Math.PI * 2)
  context.clip()
  context.drawImage(scratch, 0, 0)
  context.restore()

  // Aperture edge.
  context.strokeStyle = 'rgba(255,255,255,0.35)'
  context.lineWidth = 2
  context.beginPath()
  context.arc(RENDER_SIZE / 2, RENDER_SIZE / 2, RENDER_SIZE / 2 - 2, 0, Math.PI * 2)
  context.stroke()

  drawScaleBar(context, fieldOfViewMm)
  return canvas.toDataURL('image/png')
}

/**
 * Scale bar sized to a round number of micrometres.
 *
 * Picked from a 1-2-5 sequence so the bar is always a value someone can reason
 * with, rather than whatever fraction of the field happens to be convenient.
 */
function drawScaleBar(context: CanvasRenderingContext2D, fieldOfViewMm: number): void {
  const fieldUm = fieldOfViewMm * 1000
  const candidates = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
  const barUm =
    candidates.filter((c) => c <= fieldUm * 0.4).pop() ?? Math.round(fieldUm * 0.25)

  const pixelsPerUm = RENDER_SIZE / fieldUm
  const barPx = barUm * pixelsPerUm

  const x = RENDER_SIZE * 0.5 - barPx / 2
  const y = RENDER_SIZE - 34

  context.fillStyle = 'rgba(0,0,0,0.55)'
  context.fillRect(x - 10, y - 16, barPx + 20, 34)

  context.fillStyle = '#fff'
  context.fillRect(x, y, barPx, 3)

  context.font = '500 13px ui-sans-serif, system-ui, sans-serif'
  context.textAlign = 'center'
  context.fillText(
    barUm >= 1000 ? `${barUm / 1000} mm` : `${barUm} µm`,
    RENDER_SIZE / 2,
    y - 5,
  )
}
