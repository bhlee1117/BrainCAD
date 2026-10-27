/**
 * Synchronised coronal, sagittal and horizontal slice views.
 *
 * All three are painted straight from the annotation volume through the
 * structure colour LUT — the same data that answers "which region is my target
 * in", so the views and the readout can never disagree.
 */

import { useEffect, useMemo, useRef } from 'react'

import {
  colorizeSlice,
  voxelToSlicePixel,
  type AnnotationVolume,
} from '../atlas/annotation.ts'
import { stereotaxicToVoxel, type Stereotaxic } from '../atlas/coords.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { ColorTable } from '../atlas/ontology.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import type { AnatomicalAxis } from '../atlas/space.ts'

interface SliceViewProps {
  label: string
  axis: AnatomicalAxis
  volume: AnnotationVolume
  colors: ColorTable
  profile: CoordinateProfile
  coord: Stereotaxic
}

/** Crosshair colour; deliberately the same accent used for target markers. */
const CROSSHAIR = 'rgba(255,107,74,0.95)'

/**
 * Dark halo drawn under the crosshair.
 *
 * The accent reads well against the ontology's colours and vanished the moment
 * the sections could be painted with the heat ramp — whose bright end is the
 * same warm orange. A dark line underneath costs one extra stroke and makes
 * the target legible on any colouring, which matters more here than anywhere
 * else on screen: the crosshair *is* the coordinate.
 */
const CROSSHAIR_HALO = 'rgba(0,0,0,0.65)'

function SliceView({ label, axis, volume, colors, profile, coord }: SliceViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const voxel = useMemo(() => stereotaxicToVoxel(profile, coord), [profile, coord])
  const sliceIndex = axis === 'AP' ? voxel.i0 : axis === 'DV' ? voxel.i1 : voxel.i2

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const slice = volume.extractSlice(axis, sliceIndex)
    canvas.width = slice.width
    canvas.height = slice.height

    const pixels = colorizeSlice(slice, colors)
    // Built empty and filled, rather than passed to the ImageData constructor,
    // so the pixel buffer's backing store does not have to be a plain
    // ArrayBuffer to satisfy the DOM typings.
    const image = context.createImageData(slice.width, slice.height)
    image.data.set(pixels)
    context.putImageData(image, 0, 0)

    // Crosshair position comes from the same helper the image was built with,
    // so it cannot drift from the anatomy under a flipped axis.
    const { x, y } = voxelToSlicePixel(profile.space, slice, voxel)

    const crosshair = () => {
      context.beginPath()
      context.moveTo(x + 0.5, 0)
      context.lineTo(x + 0.5, slice.height)
      context.moveTo(0, y + 0.5)
      context.lineTo(slice.width, y + 0.5)
      context.stroke()
    }

    context.strokeStyle = CROSSHAIR_HALO
    context.lineWidth = 3
    crosshair()

    context.strokeStyle = CROSSHAIR
    context.lineWidth = 1
    crosshair()
  }, [volume, colors, axis, sliceIndex, voxel, profile])

  const readout =
    axis === 'AP'
      ? `AP ${coord.ap >= 0 ? '+' : ''}${coord.ap.toFixed(2)}`
      : axis === 'ML'
        ? `ML ${coord.ml >= 0 ? '+' : ''}${coord.ml.toFixed(2)}`
        : `DV ${coord.dv >= 0 ? '+' : ''}${coord.dv.toFixed(2)}`

  return (
    <div className="slice">
      <canvas ref={canvasRef} />
      <div className="slice__label">{label}</div>
      <div className="slice__coord">{readout}</div>
    </div>
  )
}

export function SlicePanel({
  atlas,
  profile,
  coord,
  colors,
  caption,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  coord: Stereotaxic
  /**
   * Override the structure colours.
   *
   * The sections are painted through a lookup keyed by structure id, so
   * showing something other than the ontology is a different table rather
   * than a different renderer — which is what keeps the crosshair, the slice
   * indices and the readouts identical between the two.
   */
  colors?: ColorTable
  /** Says what the colours mean, when they are not the ontology's. */
  caption?: string
}) {
  const table = colors ?? atlas.colors

  return (
    <div className={caption ? 'slices slices--captioned' : 'slices'}>
      <SliceView
        label="Coronal"
        axis="AP"
        volume={atlas.volume}
        colors={table}
        profile={profile}
        coord={coord}
      />
      <SliceView
        label="Sagittal"
        axis="ML"
        volume={atlas.volume}
        colors={table}
        profile={profile}
        coord={coord}
      />
      <SliceView
        label="Horizontal"
        axis="DV"
        volume={atlas.volume}
        colors={table}
        profile={profile}
        coord={coord}
      />
      {caption && <div className="slices__caption">{caption}</div>}
    </div>
  )
}
