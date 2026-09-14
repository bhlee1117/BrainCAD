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
  DirectionalLight,
  OrthographicCamera,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three'

import { HELPER_FLAG } from '../scene/Helper.tsx'
import { effectivePivot, resolveGeometry, type SceneObject } from '../objects/model.ts'
import { localToWorld, solvePlacement, worldAxis } from '../objects/placement.ts'
import type { ObjectiveParams } from '../objects/primitives.ts'

/** Square edge of the rendered image, in pixels. */
const RENDER_SIZE = 900

/**
 * Side of the region rendered, in millimetres.
 *
 * Deliberately wider than any objective's field. A frame cropped to the field
 * itself shows the target and almost nothing else, which answers "what is at
 * the focus" but not the question the view is for: *what surrounds it, and what
 * is in the way*. The field boundary is drawn inside this wider context
 * instead, so both readings are available at once.
 */
export const VIEW_EXTENT_MM = 5

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
  /** Side of the rendered region, in millimetres. */
  readonly extentMm: number
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
    extentMm: VIEW_EXTENT_MM,
  }
}

export interface ObjectiveViewResult {
  /** PNG data URL of the circular field of view. */
  readonly dataUrl: string
  /** The objective's own field diameter, marked on the image. */
  readonly fieldOfViewMm: number
  /** Working distance used to place the camera. */
  readonly workingDistanceMm: number
  /** Side of the region rendered, in millimetres. */
  readonly extentMm: number
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

  const half = view.extentMm / 2
  const camera = new OrthographicCamera(
    -half,
    half,
    half,
    -half,
    0.01,
    // Far enough to cover the whole brain from outside it, so anatomy and
    // overlays behind the focal plane are part of the picture rather than
    // clipped away.
    view.workingDistanceMm + 30,
  )
  camera.position.copy(view.eye)
  camera.up.set(0, 1, 0)
  camera.lookAt(view.lookAt)
  camera.updateProjectionMatrix()

  // Hide helper decoration — target markers, the axis triad, measurement lines
  // and the transform gizmo. None of it can occlude light, and it sits exactly
  // on the focal point the reader is trying to assess, so leaving it in would
  // show an obstruction that is not there.
  //
  // The gizmo is matched by type rather than by the userData flag because
  // three.js attaches TransformControls' visual root to the scene itself, not
  // to the React element that declared it — so wrapping it is not enough.
  const hidden: Object3D[] = []
  scene.traverse((node) => {
    if (!node.visible) return
    const isFlagged = node.userData?.[HELPER_FLAG] === true
    const isGizmo =
      node.type.startsWith('TransformControls') ||
      node.constructor?.name?.startsWith('TransformControls') === true
    if (isFlagged || isGizmo) {
      node.visible = false
      hidden.push(node)
    }
  })

  // The viewport's lights come from above and behind the default camera, so
  // looking down the objective's own axis leaves the anatomy unlit and the
  // brain — already at low opacity — renders as near-black. A light travelling
  // with the objective is added for the capture only, and removed after, so the
  // scene the user is looking at is untouched.
  const headlight = new DirectionalLight(0xffffff, 2.6)
  headlight.position.copy(view.eye)
  headlight.target.position.copy(view.focal)
  scene.add(headlight)
  scene.add(headlight.target)

  const target = new WebGLRenderTarget(RENDER_SIZE, RENDER_SIZE)
  const previousTarget = gl.getRenderTarget()

  let pixels: Uint8Array
  try {
    gl.setRenderTarget(target)
    gl.render(scene, camera)
    pixels = new Uint8Array(RENDER_SIZE * RENDER_SIZE * 4)
    gl.readRenderTargetPixels(target, 0, 0, RENDER_SIZE, RENDER_SIZE, pixels)
  } catch (error) {
    // Say why. A silently-null view produces a planning sheet with no
    // objective figure and no explanation, which is indistinguishable from
    // "there was nothing to show".
    console.warn(`Objective view for "${objective.name}" failed to render`, error)
    return null
  } finally {
    gl.setRenderTarget(previousTarget)
    target.dispose()
    scene.remove(headlight)
    scene.remove(headlight.target)
    headlight.dispose()
    for (const node of hidden) node.visible = true
  }

  const dataUrl = composeFieldImage(pixels, view.extentMm, view.fieldOfViewMm)
  return dataUrl
    ? {
        dataUrl,
        fieldOfViewMm: view.fieldOfViewMm,
        workingDistanceMm: view.workingDistanceMm,
        extentMm: view.extentMm,
      }
    : null
}

/**
 * Compose the rendered pixels into the final figure.
 *
 * The whole 5 mm region is shown as a square frame, with the objective's actual
 * field drawn as a circle inside it. Cropping to the field instead would throw
 * away the surrounding context that makes the picture useful — you would see
 * the target and not the headbar about to occlude it.
 */
function composeFieldImage(
  pixels: Uint8Array,
  extentMm: number,
  fieldOfViewMm: number,
): string | null {
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

  context.fillStyle = '#05070a'
  context.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE)
  context.putImageData(image, 0, 0)

  drawFieldBoundary(context, extentMm, fieldOfViewMm)
  drawScaleBar(context, extentMm)

  // Frame edge, so the figure reads as a bounded region rather than bleeding
  // into the page.
  context.strokeStyle = 'rgba(255,255,255,0.25)'
  context.lineWidth = 2
  context.strokeRect(1, 1, RENDER_SIZE - 2, RENDER_SIZE - 2)

  return canvas.toDataURL('image/png')
}

/**
 * Mark the objective's actual field inside the wider frame.
 *
 * Drawn as a dashed circle with its diameter labelled, because the reader needs
 * to distinguish "what the objective images" from "what this figure shows" —
 * conflating them would overstate the instrument's coverage threefold.
 */
function drawFieldBoundary(
  context: CanvasRenderingContext2D,
  extentMm: number,
  fieldOfViewMm: number,
): void {
  const pixelsPerMm = RENDER_SIZE / extentMm
  const radius = (fieldOfViewMm / 2) * pixelsPerMm
  const centre = RENDER_SIZE / 2

  if (radius <= 2 || radius > RENDER_SIZE) return

  context.save()
  context.setLineDash([7, 6])
  context.strokeStyle = 'rgba(255,255,255,0.85)'
  context.lineWidth = 2
  context.beginPath()
  context.arc(centre, centre, radius, 0, Math.PI * 2)
  context.stroke()
  context.restore()

  // Crosshair at the focal point, kept short so it does not obscure the centre.
  context.strokeStyle = 'rgba(255,255,255,0.55)'
  context.lineWidth = 1
  const tick = Math.min(14, radius * 0.35)
  context.beginPath()
  context.moveTo(centre - tick, centre)
  context.lineTo(centre + tick, centre)
  context.moveTo(centre, centre - tick)
  context.lineTo(centre, centre + tick)
  context.stroke()

  const label = `field ${fieldOfViewMm.toFixed(2)} mm`
  context.font = '500 13px ui-sans-serif, system-ui, sans-serif'
  context.textAlign = 'center'

  const labelY = centre - radius - 9
  const width = context.measureText(label).width
  context.fillStyle = 'rgba(0,0,0,0.6)'
  context.fillRect(centre - width / 2 - 6, labelY - 13, width + 12, 18)
  context.fillStyle = '#fff'
  context.fillText(label, centre, labelY)
}

/**
 * Scale bar sized to a round number of micrometres.
 *
 * Picked from a 1-2-5 sequence so the bar is always a value someone can reason
 * with, rather than whatever fraction of the field happens to be convenient.
 */
function drawScaleBar(context: CanvasRenderingContext2D, extentMm: number): void {
  const fieldUm = extentMm * 1000
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
