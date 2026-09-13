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
const CROSSHAIR = 'rgba(255,107,74,0.9)'

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

    context.strokeStyle = CROSSHAIR
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(x + 0.5, 0)
    context.lineTo(x + 0.5, slice.height)
    context.moveTo(0, y + 0.5)
    context.lineTo(slice.width, y + 0.5)
    context.stroke()
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
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  coord: Stereotaxic
}) {
  return (
    <div className="slices">
      <SliceView
        label="Coronal"
        axis="AP"
        volume={atlas.volume}
        colors={atlas.colors}
        profile={profile}
        coord={coord}
      />
      <SliceView
        label="Sagittal"
        axis="ML"
        volume={atlas.volume}
        colors={atlas.colors}
        profile={profile}
        coord={coord}
      />
      <SliceView
        label="Horizontal"
        axis="DV"
        volume={atlas.volume}
        colors={atlas.colors}
        profile={profile}
        coord={coord}
      />
    </div>
  )
}
