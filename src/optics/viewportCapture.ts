/**
 * Capturing the view the user is actually looking at.
 *
 * `overviewViews.ts` renders four fixed viewpoints, deliberately: a plan is
 * read like a drawing, and standard views are comparable between plans. But
 * the four of them cannot show the one thing the user has often spent minutes
 * finding — the oblique angle at which the prism, the craniotomy and the
 * objective all read at once, usually with a section plane through the tissue.
 * That framing is a judgement about the plan, and it belongs in the record.
 *
 * The capture is rendered offscreen rather than read back from the canvas, for
 * the same reason the overviews are: the interactive context is created
 * without `preserveDrawingBuffer`, so by the time a button handler runs, the
 * drawing buffer has already been cleared. It reuses the live camera, so what
 * comes out is the framing on screen — at print resolution, and with the
 * editing gizmo taken out, which is the only thing deliberately not preserved.
 */

import {
  DirectionalLight,
  type Camera,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'

/**
 * Long edge of the capture, in pixels.
 *
 * Matches the overview captures so the two sit together in a sheet at one
 * scale. Clamped to the GPU's maximum texture size at runtime.
 */
const REQUESTED_LONG_EDGE = 1600

/** Multisampling, for the same reason the overviews use it: silhouette edges. */
const SAMPLES = 4

/** The viewport's own background, so transparent pixels do not print white. */
const BACKGROUND = '#0b0e13'

export interface ViewportCapture {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

/**
 * Render the current camera's view offscreen and return it as a PNG.
 *
 * Returns null when the capture could not be produced — the caller must report
 * that rather than silently embedding nothing, which is the failure mode the
 * planning sheet's empty Scene section used to have.
 */
export function captureViewport(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
): ViewportCapture | null {
  const canvas = gl.domElement
  const aspect = canvas.clientWidth > 0 && canvas.clientHeight > 0
    ? canvas.clientWidth / canvas.clientHeight
    : 1

  const maxSize = gl.capabilities.maxTextureSize
  const longEdge = Math.min(REQUESTED_LONG_EDGE, maxSize)
  const width = Math.max(1, Math.round(aspect >= 1 ? longEdge : longEdge * aspect))
  const height = Math.max(1, Math.round(aspect >= 1 ? longEdge / aspect : longEdge))

  // The gizmo is an artifact of editing, not part of the plan. Everything else
  // on screen — helper markers, labels, the axis triad, whatever the user has
  // toggled off — is left exactly as it is, because the point of this capture
  // is that it is the view they framed.
  const hidden: Object3D[] = []
  scene.traverse((node) => {
    if (!node.visible) return
    const isGizmo =
      node.type.startsWith('TransformControls') ||
      node.constructor?.name?.startsWith('TransformControls') === true
    if (isGizmo) {
      node.visible = false
      hidden.push(node)
    }
  })

  // The viewport's own lights are fixed in world space, so this is only a
  // headlight top-up rather than a replacement: without it, a camera the user
  // has orbited behind the preparation renders it in silhouette.
  const headlight = new DirectionalLight(0xffffff, 0.9)
  scene.add(headlight)
  scene.add(headlight.target)
  headlight.position.copy(camera.getWorldPosition(new Vector3()))
  headlight.target.position.copy(
    camera.getWorldDirection(new Vector3()).add(headlight.position),
  )
  headlight.target.updateMatrixWorld()

  const target = new WebGLRenderTarget(width, height, { samples: SAMPLES })
  const previousTarget = gl.getRenderTarget()

  // The offscreen buffer's aspect ratio is the canvas's, so the camera's own
  // projection is already correct and is restored untouched afterwards —
  // leaving a mutated live camera behind would distort the interactive view.
  const perspective = camera as PerspectiveCamera
  const previousAspect = perspective.isPerspectiveCamera ? perspective.aspect : null

  try {
    if (previousAspect !== null) {
      perspective.aspect = width / height
      perspective.updateProjectionMatrix()
    }

    gl.setRenderTarget(target)
    gl.render(scene, camera)

    const pixels = new Uint8Array(width * height * 4)
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels)

    const dataUrl = toDataUrl(pixels, width, height)
    return dataUrl ? { dataUrl, width, height } : null
  } catch (error) {
    console.warn('Viewport capture failed', error)
    return null
  } finally {
    if (previousAspect !== null) {
      perspective.aspect = previousAspect
      perspective.updateProjectionMatrix()
    }
    gl.setRenderTarget(previousTarget)
    target.dispose()
    scene.remove(headlight)
    scene.remove(headlight.target)
    headlight.dispose()
    for (const node of hidden) node.visible = true
  }
}

/** Flip the GL rows into image order, composite onto the ground, encode PNG. */
function toDataUrl(pixels: Uint8Array, width: number, height: number): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null

  const layer = document.createElement('canvas')
  layer.width = width
  layer.height = height
  const layerContext = layer.getContext('2d')
  if (!layerContext) return null

  const image = layerContext.createImageData(width, height)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    // GL reads bottom-up; canvas expects top-down.
    const source = (height - 1 - y) * rowBytes
    image.data.set(pixels.subarray(source, source + rowBytes), y * rowBytes)
  }
  layerContext.putImageData(image, 0, 0)

  context.fillStyle = BACKGROUND
  context.fillRect(0, 0, width, height)
  context.drawImage(layer, 0, 0)

  return canvas.toDataURL('image/png')
}
