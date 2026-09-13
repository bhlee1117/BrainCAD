/**
 * Conversion between atlas voxel indices and stereotaxic AP/ML/DV millimetres.
 *
 * Sign convention throughout BrainCAD (Paxinos & Franklin):
 *   +AP = anterior of bregma
 *   +ML = right of midline
 *   +DV = dorsal (so structures inside the brain have negative DV)
 *
 * All conversions go through a `CoordinateProfile`, so no bregma position or
 * scaling factor is baked into this module.
 */

import type { CoordinateProfile } from './profile.ts'
import type { AnatomicalAxis, VolumeSpace } from './space.ts'
import { arrayAxisFor, flatIndex, indexIncreasesPositively } from './space.ts'

/** A stereotaxic coordinate in millimetres relative to the profile origin. */
export interface Stereotaxic {
  readonly ap: number
  readonly ml: number
  readonly dv: number
}

/** A (possibly fractional) voxel index triple in array-axis order. */
export interface VoxelIndex {
  readonly i0: number
  readonly i1: number
  readonly i2: number
}

const SCALE_INDEX: Record<AnatomicalAxis, 0 | 1 | 2> = { AP: 0, ML: 1, DV: 2 }

/**
 * Signed millimetre offset along one anatomical axis, from the profile origin
 * to a voxel index along that axis.
 */
function axisIndexToMm(
  profile: CoordinateProfile,
  axis: AnatomicalAxis,
  index: number,
): number {
  const space = profile.space
  const arrayAxis = arrayAxisFor(space, axis)
  const mapping = space.axes[arrayAxis]
  const originIndex = [profile.bregma.i0, profile.bregma.i1, profile.bregma.i2][arrayAxis]!

  const deltaVoxels = index - originIndex
  const signed = indexIncreasesPositively(mapping) ? deltaVoxels : -deltaVoxels
  const mm = (signed * space.resolutionUm) / 1000
  return mm * profile.scale[SCALE_INDEX[axis]]!
}

/** Inverse of {@link axisIndexToMm}. */
function axisMmToIndex(
  profile: CoordinateProfile,
  axis: AnatomicalAxis,
  mm: number,
): number {
  const space = profile.space
  const arrayAxis = arrayAxisFor(space, axis)
  const mapping = space.axes[arrayAxis]
  const originIndex = [profile.bregma.i0, profile.bregma.i1, profile.bregma.i2][arrayAxis]!

  const unscaled = mm / profile.scale[SCALE_INDEX[axis]]!
  const voxels = (unscaled * 1000) / space.resolutionUm
  const signed = indexIncreasesPositively(mapping) ? voxels : -voxels
  return originIndex + signed
}

/** Convert a voxel index triple to stereotaxic millimetres. */
export function voxelToStereotaxic(
  profile: CoordinateProfile,
  voxel: VoxelIndex,
): Stereotaxic {
  const byArrayAxis = [voxel.i0, voxel.i1, voxel.i2] as const
  const read = (axis: AnatomicalAxis) =>
    axisIndexToMm(profile, axis, byArrayAxis[arrayAxisFor(profile.space, axis)]!)

  return { ap: read('AP'), ml: read('ML'), dv: read('DV') }
}

/** Convert stereotaxic millimetres to a (fractional) voxel index triple. */
export function stereotaxicToVoxel(
  profile: CoordinateProfile,
  coord: Stereotaxic,
): VoxelIndex {
  const out: [number, number, number] = [0, 0, 0]
  const mmByAxis: Record<AnatomicalAxis, number> = {
    AP: coord.ap,
    ML: coord.ml,
    DV: coord.dv,
  }

  for (const axis of ['AP', 'ML', 'DV'] as const) {
    out[arrayAxisFor(profile.space, axis)] = axisMmToIndex(profile, axis, mmByAxis[axis])
  }

  return { i0: out[0], i1: out[1], i2: out[2] }
}

/** Round a fractional voxel index to the nearest integer sample. */
export function roundVoxel(voxel: VoxelIndex): VoxelIndex {
  return {
    i0: Math.round(voxel.i0),
    i1: Math.round(voxel.i1),
    i2: Math.round(voxel.i2),
  }
}

/** Whether a voxel index lies inside the volume. */
export function isInsideVolume(space: VolumeSpace, voxel: VoxelIndex): boolean {
  return flatIndex(space, Math.round(voxel.i0), Math.round(voxel.i1), Math.round(voxel.i2)) >= 0
}

/**
 * Distance in millimetres between two stereotaxic points.
 *
 * This is a straight-line Euclidean distance. BrainCAD deliberately keeps
 * surface, along-object and along-trajectory distances as separate functions so
 * the four kinds are never silently mixed in the UI.
 */
export function euclideanDistanceMm(a: Stereotaxic, b: Stereotaxic): number {
  const dAp = a.ap - b.ap
  const dMl = a.ml - b.ml
  const dDv = a.dv - b.dv
  return Math.sqrt(dAp * dAp + dMl * dMl + dDv * dDv)
}

/** Per-axis differences, as the MEASURE panel reports them. */
export function componentDifferences(a: Stereotaxic, b: Stereotaxic): Stereotaxic {
  return { ap: a.ap - b.ap, ml: a.ml - b.ml, dv: a.dv - b.dv }
}

/**
 * Distance between the profile's two skull landmarks, in millimetres.
 *
 * Useful as a calibration check: Perens et al. report 4.80 ± 0.15 mm, and a
 * user-calibrated profile that departs far from that is probably mis-entered.
 */
export function bregmaLambdaDistanceMm(profile: CoordinateProfile): number | null {
  if (!profile.lambda) return null
  const b = voxelToStereotaxic(profile, profile.bregma)
  const l = voxelToStereotaxic(profile, profile.lambda)
  return euclideanDistanceMm(b, l)
}

/**
 * Format a coordinate the way the UI and planning sheet should show it.
 *
 * Atlas coordinates are averaged references with landmark SDs on the order of
 * 100 µm, so BrainCAD reports 2 decimal places (10 µm) and never more — showing
 * more digits would imply precision the underlying data does not have.
 */
export function formatStereotaxic(coord: Stereotaxic): string {
  const f = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2)
  return `AP ${f(coord.ap)}  ML ${f(coord.ml)}  DV ${f(coord.dv)} mm`
}
