/**
 * Anatomical volume space: how a 3D voxel array maps onto anatomical axes.
 *
 * Volumetric brain atlases ship as plain 3D arrays with no reliable, universal
 * statement of which array axis is which anatomical axis. (The Allen CCF NRRD
 * header nominally declares `space: left-posterior-superior`, but its
 * `space directions` do not agree with its `sizes` under that reading — the
 * de-facto interpretation used across the community is AP/DV/ML.) BrainGlobe
 * packages instead use a three-letter orientation code.
 *
 * So rather than trusting any single header field, BrainCAD models the mapping
 * explicitly and validates it against physical extents, which are unambiguous:
 * the mouse brain is ~13 mm anterior-posterior, ~11 mm medial-lateral and
 * ~8 mm dorsal-ventral, so no two axes are confusable by length.
 */

/** Anatomical axis of a voxel array axis. */
export type AnatomicalAxis = 'AP' | 'DV' | 'ML'

/**
 * The anatomical side a voxel axis *starts* at — i.e. the direction of
 * travel as the index increases is away from this side.
 *
 * This follows the BrainGlobe orientation-code convention, where `asr` means
 * axis 0 starts Anterior, axis 1 starts Superior, axis 2 starts Right.
 */
export type AxisOrigin = 'a' | 'p' | 's' | 'i' | 'l' | 'r'

const AXIS_OF_ORIGIN: Record<AxisOrigin, AnatomicalAxis> = {
  a: 'AP',
  p: 'AP',
  s: 'DV',
  i: 'DV',
  l: 'ML',
  r: 'ML',
}

/** Voxel array axis index (0, 1 or 2). */
export type ArrayAxis = 0 | 1 | 2

export interface AxisMapping {
  /** Which anatomical axis this array axis represents. */
  readonly axis: AnatomicalAxis
  /** Anatomical side the axis starts from (index 0). */
  readonly origin: AxisOrigin
}

export interface VolumeSpace {
  /** Voxel counts along array axes 0, 1, 2. */
  readonly shape: readonly [number, number, number]
  /** Isotropic voxel size in micrometres. */
  readonly resolutionUm: number
  /** Per-array-axis anatomical mapping, index-aligned with `shape`. */
  readonly axes: readonly [AxisMapping, AxisMapping, AxisMapping]
}

/**
 * Parse a BrainGlobe-style three-letter orientation code (e.g. `"asr"`) into
 * axis mappings.
 *
 * @throws if the code is not three letters naming three distinct anatomical axes.
 */
export function parseOrientation(
  code: string,
): readonly [AxisMapping, AxisMapping, AxisMapping] {
  const letters = code.toLowerCase().split('')
  if (letters.length !== 3) {
    throw new Error(
      `Orientation code must be exactly 3 letters, got ${JSON.stringify(code)}`,
    )
  }

  const mappings = letters.map((letter) => {
    if (!(letter in AXIS_OF_ORIGIN)) {
      throw new Error(
        `Invalid orientation letter ${JSON.stringify(letter)} in ${JSON.stringify(code)}; ` +
          `expected one of a, p, s, i, l, r`,
      )
    }
    const origin = letter as AxisOrigin
    return { axis: AXIS_OF_ORIGIN[origin], origin }
  })

  const distinct = new Set(mappings.map((m) => m.axis))
  if (distinct.size !== 3) {
    throw new Error(
      `Orientation code ${JSON.stringify(code)} does not name three distinct anatomical axes`,
    )
  }

  return mappings as unknown as readonly [AxisMapping, AxisMapping, AxisMapping]
}

/** Build a `VolumeSpace` from a shape, resolution and orientation code. */
export function makeVolumeSpace(
  shape: readonly [number, number, number],
  resolutionUm: number,
  orientationCode: string,
): VolumeSpace {
  if (!Number.isFinite(resolutionUm) || resolutionUm <= 0) {
    throw new Error(`resolutionUm must be a positive number, got ${resolutionUm}`)
  }
  for (const n of shape) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`shape entries must be positive integers, got ${JSON.stringify(shape)}`)
    }
  }
  return { shape, resolutionUm, axes: parseOrientation(orientationCode) }
}

/** Find which array axis carries a given anatomical axis. */
export function arrayAxisFor(space: VolumeSpace, axis: AnatomicalAxis): ArrayAxis {
  const index = space.axes.findIndex((a) => a.axis === axis)
  if (index < 0) throw new Error(`Space has no ${axis} axis`)
  return index as ArrayAxis
}

/** Physical extent of the volume along an anatomical axis, in millimetres. */
export function extentMm(space: VolumeSpace, axis: AnatomicalAxis): number {
  const i = arrayAxisFor(space, axis)
  return (space.shape[i] * space.resolutionUm) / 1000
}

/**
 * Whether an increasing voxel index along this array axis moves in the
 * *positive stereotaxic* direction.
 *
 * BrainCAD's stereotaxic sign convention (Paxinos & Franklin):
 *   +AP = anterior, +ML = right of midline, +DV = dorsal (up).
 *
 * An axis whose origin is `'a'` starts anterior and increases posteriorly, so
 * increasing index moves in the *negative* AP direction.
 */
export function indexIncreasesPositively(mapping: AxisMapping): boolean {
  switch (mapping.origin) {
    case 'p':
      return true // starts posterior, increases anterior → +AP
    case 'a':
      return false
    case 'i':
      return true // starts inferior, increases dorsal → +DV
    case 's':
      return false
    case 'l':
      return true // starts left, increases rightward → +ML
    case 'r':
      return false
  }
}

/** Total voxel count. */
export function voxelCount(space: VolumeSpace): number {
  return space.shape[0] * space.shape[1] * space.shape[2]
}

/**
 * Flat index into the voxel array.
 *
 * NRRD arrays are stored with the FIRST axis varying fastest (column-major),
 * which is the opposite of C order. Getting this backwards does not crash and
 * does not look obviously wrong — it silently scrambles anatomy, which is how
 * it was caught here: olfactory bulb voxels appeared spread across the entire
 * volume instead of sitting at the anterior pole.
 *
 * Returns `-1` when any component is out of bounds.
 */
export function flatIndex(
  space: VolumeSpace,
  i0: number,
  i1: number,
  i2: number,
): number {
  const [n0, n1, n2] = space.shape
  if (i0 < 0 || i0 >= n0 || i1 < 0 || i1 >= n1 || i2 < 0 || i2 >= n2) return -1
  return i0 + n0 * (i1 + n1 * i2)
}
