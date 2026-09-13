/**
 * The annotation volume: one 880 KB asset that answers most of BrainCAD's
 * anatomical questions.
 *
 * Every voxel carries the id of the structure containing it, so this single
 * volume delivers region lookup at a target, the coronal/sagittal/horizontal
 * slice images, the list of structures a trajectory crosses, and brain-surface
 * entry detection — without loading any additional geometry.
 */

import type { Stereotaxic } from './coords.ts'
import { stereotaxicToVoxel, voxelToStereotaxic } from './coords.ts'
import type { ColorTable } from './ontology.ts'
import type { CoordinateProfile } from './profile.ts'
import type { AnatomicalAxis, VolumeSpace } from './space.ts'
import { arrayAxisFor, flatIndex, indexIncreasesPositively } from './space.ts'

/** Label id used for voxels outside any annotated structure. */
export const UNLABELLED = 0

export interface SliceImage {
  readonly width: number
  readonly height: number
  /** Structure id per pixel, row-major from the top-left of the image. */
  readonly labels: Uint32Array
  /** Anatomical axis running left-to-right across the image. */
  readonly horizontalAxis: AnatomicalAxis
  /** Anatomical axis running top-to-bottom down the image. */
  readonly verticalAxis: AnatomicalAxis
}

/**
 * In-plane axis assignment for each slice orientation, chosen to match how
 * these views are conventionally read at a rig:
 *
 *   coronal    (fixed AP) — ML across, DV down, dorsal at the top
 *   sagittal   (fixed ML) — AP across, DV down, anterior to the right
 *   horizontal (fixed DV) — ML across, AP down, anterior at the top
 */
const SLICE_PLANES: Record<
  AnatomicalAxis,
  { horizontal: AnatomicalAxis; vertical: AnatomicalAxis }
> = {
  AP: { horizontal: 'ML', vertical: 'DV' },
  ML: { horizontal: 'AP', vertical: 'DV' },
  DV: { horizontal: 'ML', vertical: 'AP' },
}

/**
 * Whether the image's horizontal/vertical direction runs along *increasing*
 * stereotaxic value. DV is inverted for coronal and sagittal views so dorsal
 * appears at the top; AP is inverted for horizontal views so anterior is at
 * the top.
 */
const AXIS_DISPLAY_ASCENDING: Record<AnatomicalAxis, boolean> = {
  AP: true, // +AP (anterior) to the right / toward the top
  ML: true, // +ML (right hemisphere) to the right
  DV: false, // +DV (dorsal) toward the top, so image rows descend in DV
}

/**
 * Where a voxel lands in a slice image, in pixel coordinates.
 *
 * Exported so overlays (crosshairs, trajectory lines, measurement endpoints)
 * position themselves through exactly the same flip rules `extractSlice` used
 * to build the image. Re-deriving those rules at each call site is how a
 * crosshair silently drifts off its own anatomy.
 */
export function voxelToSlicePixel(
  space: VolumeSpace,
  slice: SliceImage,
  voxel: { i0: number; i1: number; i2: number },
): { x: number; y: number } {
  const byArrayAxis = [voxel.i0, voxel.i1, voxel.i2] as const

  const place = (axis: AnatomicalAxis, span: number) => {
    const arrayAxis = arrayAxisFor(space, axis)
    const raw = byArrayAxis[arrayAxis]!
    const flip =
      indexIncreasesPositively(space.axes[arrayAxis]!) !== AXIS_DISPLAY_ASCENDING[axis]
    return flip ? span - 1 - raw : raw
  }

  return {
    x: place(slice.horizontalAxis, slice.width),
    y: place(slice.verticalAxis, slice.height),
  }
}

export class AnnotationVolume {
  readonly space: VolumeSpace
  private readonly labels: Uint32Array

  constructor(space: VolumeSpace, labels: Uint32Array) {
    const expected = space.shape[0] * space.shape[1] * space.shape[2]
    if (labels.length !== expected) {
      throw new Error(
        `Annotation volume size mismatch: space ${space.shape.join('x')} expects ` +
          `${expected} voxels, got ${labels.length}`,
      )
    }
    this.space = space
    this.labels = labels
  }

  /** Structure id at integer voxel indices; `UNLABELLED` when out of bounds. */
  labelAtVoxel(i0: number, i1: number, i2: number): number {
    const index = flatIndex(this.space, Math.round(i0), Math.round(i1), Math.round(i2))
    return index < 0 ? UNLABELLED : this.labels[index]!
  }

  /** Structure id at a stereotaxic coordinate. */
  labelAt(profile: CoordinateProfile, coord: Stereotaxic): number {
    const voxel = stereotaxicToVoxel(profile, coord)
    return this.labelAtVoxel(voxel.i0, voxel.i1, voxel.i2)
  }

  /**
   * Extract one slice as a label image.
   *
   * @param axis Anatomical axis held constant (AP → coronal, ML → sagittal,
   *   DV → horizontal).
   * @param sliceIndex Voxel index along that axis.
   */
  extractSlice(axis: AnatomicalAxis, sliceIndex: number): SliceImage {
    const plane = SLICE_PLANES[axis]
    const fixedArrayAxis = arrayAxisFor(this.space, axis)
    const hArrayAxis = arrayAxisFor(this.space, plane.horizontal)
    const vArrayAxis = arrayAxisFor(this.space, plane.vertical)

    const width = this.space.shape[hArrayAxis]!
    const height = this.space.shape[vArrayAxis]!
    const labels = new Uint32Array(width * height)

    const fixed = Math.round(sliceIndex)
    if (fixed < 0 || fixed >= this.space.shape[fixedArrayAxis]!) {
      return {
        width,
        height,
        labels,
        horizontalAxis: plane.horizontal,
        verticalAxis: plane.vertical,
      }
    }

    // Whether a voxel index increasing along each in-plane axis moves in the
    // image's own direction, combining the volume's storage order with the
    // display convention above.
    const hFlip =
      indexIncreasesPositively(this.space.axes[hArrayAxis]!) !==
      AXIS_DISPLAY_ASCENDING[plane.horizontal]
    const vFlip =
      indexIncreasesPositively(this.space.axes[vArrayAxis]!) !==
      AXIS_DISPLAY_ASCENDING[plane.vertical]

    const voxel: [number, number, number] = [0, 0, 0]
    voxel[fixedArrayAxis] = fixed

    for (let row = 0; row < height; row++) {
      voxel[vArrayAxis] = vFlip ? height - 1 - row : row
      const rowOffset = row * width

      for (let column = 0; column < width; column++) {
        voxel[hArrayAxis] = hFlip ? width - 1 - column : column
        const index = flatIndex(this.space, voxel[0], voxel[1], voxel[2])
        labels[rowOffset + column] = index < 0 ? UNLABELLED : this.labels[index]!
      }
    }

    return {
      width,
      height,
      labels,
      horizontalAxis: plane.horizontal,
      verticalAxis: plane.vertical,
    }
  }

  /**
   * Structures encountered walking from `from` to `to`, in order.
   *
   * Backs the trajectory readout: which regions a pipette passes through on its
   * way to the target. Sampling is at half the voxel pitch, which is dense
   * enough not to skip a thin layer at 50 µm resolution.
   */
  structuresAlong(
    profile: CoordinateProfile,
    from: Stereotaxic,
    to: Stereotaxic,
  ): readonly { id: number; entryMm: number; exitMm: number }[] {
    const start = stereotaxicToVoxel(profile, from)
    const end = stereotaxicToVoxel(profile, to)

    const d0 = end.i0 - start.i0
    const d1 = end.i1 - start.i1
    const d2 = end.i2 - start.i2
    const lengthVoxels = Math.hypot(d0, d1, d2)
    if (lengthVoxels === 0) return []

    const steps = Math.max(1, Math.ceil(lengthVoxels * 2))
    const totalMm = Math.hypot(to.ap - from.ap, to.ml - from.ml, to.dv - from.dv)

    const runs: { id: number; entryMm: number; exitMm: number }[] = []
    let current: { id: number; entryMm: number; exitMm: number } | null = null

    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const label = this.labelAtVoxel(
        start.i0 + d0 * t,
        start.i1 + d1 * t,
        start.i2 + d2 * t,
      )
      const distanceMm = totalMm * t

      if (current && current.id === label) {
        current.exitMm = distanceMm
      } else {
        if (current) runs.push(current)
        current = { id: label, entryMm: distanceMm, exitMm: distanceMm }
      }
    }
    if (current) runs.push(current)

    return runs
  }

  /**
   * First labelled voxel along a ray, i.e. where a trajectory enters the brain.
   *
   * Returns `null` when the ray never enters annotated tissue, which the UI
   * must report rather than silently treating as a zero-length insertion.
   */
  firstLabelledPoint(
    profile: CoordinateProfile,
    from: Stereotaxic,
    to: Stereotaxic,
  ): { coord: Stereotaxic; id: number; distanceMm: number } | null {
    const start = stereotaxicToVoxel(profile, from)
    const end = stereotaxicToVoxel(profile, to)

    const d0 = end.i0 - start.i0
    const d1 = end.i1 - start.i1
    const d2 = end.i2 - start.i2
    const lengthVoxels = Math.hypot(d0, d1, d2)
    if (lengthVoxels === 0) return null

    const steps = Math.max(1, Math.ceil(lengthVoxels * 2))
    const totalMm = Math.hypot(to.ap - from.ap, to.ml - from.ml, to.dv - from.dv)

    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      const voxel = {
        i0: start.i0 + d0 * t,
        i1: start.i1 + d1 * t,
        i2: start.i2 + d2 * t,
      }
      const label = this.labelAtVoxel(voxel.i0, voxel.i1, voxel.i2)
      if (label !== UNLABELLED) {
        return {
          coord: voxelToStereotaxic(profile, voxel),
          id: label,
          distanceMm: totalMm * t,
        }
      }
    }

    return null
  }
}

/**
 * Paint a label image into RGBA pixels using a structure colour table.
 *
 * Writes one packed uint32 per pixel through a Uint32Array view, and caches the
 * previous label's colour: slices are dominated by long runs of one structure,
 * so the cache turns most pixels into a comparison rather than a Map lookup.
 */
export function colorizeSlice(
  slice: SliceImage,
  colors: ColorTable,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const pixels = out ?? new Uint8ClampedArray(slice.width * slice.height * 4)
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, slice.width * slice.height)

  let lastId = -1
  let lastColor = 0

  for (let i = 0; i < slice.labels.length; i++) {
    const id = slice.labels[i]!

    if (id !== lastId) {
      lastId = id
      lastColor = id === UNLABELLED ? 0 : (colors.get(id) ?? 0)
    }
    words[i] = lastColor
  }

  return pixels
}
