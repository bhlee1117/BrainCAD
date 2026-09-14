/**
 * Coordinate profiles: the explicit, citable mapping between an atlas volume
 * and stereotaxic AP/ML/DV coordinates.
 *
 * BrainCAD never hard-codes a bregma position or an atlas-to-stereotaxic
 * scaling factor. Published values disagree with each other, and any given lab
 * may have its own calibration. Every number that converts atlas space into
 * surgical space lives in a `CoordinateProfile`, carries a `provenance` record,
 * and is editable by the user and stored in the project file.
 */

import type { VolumeSpace } from './space.ts'
import { makeVolumeSpace } from './space.ts'


/** How much a profile's numbers should be trusted. */
export type ProfileConfidence =
  /** Landmark positions taken from a peer-reviewed, published measurement. */
  | 'published'
  /** Widely used in the community but not from a single citable measurement. */
  | 'community-convention'
  /** Entered or calibrated by the user for their own rig or animal. */
  | 'user-calibrated'

export interface ProfileProvenance {
  readonly confidence: ProfileConfidence
  /** Human-readable citation, shown in the UI and in exported planning sheets. */
  readonly citation: string
  /** DOI or URL, when one exists. */
  readonly url?: string
  /** Anything the user must know before trusting these coordinates. */
  readonly caveats: readonly string[]
}

/** A landmark's position expressed in voxel indices of the profile's volume. */
export interface LandmarkVoxel {
  /** Voxel index along array axis 0. */
  readonly i0: number
  /** Voxel index along array axis 1. */
  readonly i1: number
  /** Voxel index along array axis 2. */
  readonly i2: number
  /** Reported standard deviation per axis, in voxels, when published. */
  readonly sdVoxels?: readonly [number, number, number]
}

/** What DV is measured from. */
export type DvReference =
  | 'bregma-plane'
  | 'skull-surface'
  | 'pial-surface'

export interface CoordinateProfile {
  readonly id: string
  readonly label: string
  /** The volume this profile's landmark voxel indices refer to. */
  readonly space: VolumeSpace
  /** Origin of the stereotaxic coordinate system. */
  readonly bregma: LandmarkVoxel
  /** Second landmark, used to validate scale and skull levelling. */
  readonly lambda?: LandmarkVoxel
  /**
   * Per-axis scale from atlas millimetres to stereotaxic millimetres,
   * ordered [AP, ML, DV]. `1` means the atlas is already in stereotaxic scale.
   */
  readonly scale: readonly [number, number, number]
  /** Skull pitch correction in degrees (positive = nose up). */
  readonly pitchCorrectionDeg: number
  readonly dvReference: DvReference
  readonly provenance: ProfileProvenance
  /** Free-text lab/strain/age calibration notes. */
  readonly notes?: string
}

/**
 * How BrainCAD knows which way is right.
 *
 * The template itself cannot answer this: CCFv3 is left-right symmetric, so no
 * amount of looking at the volume distinguishes a left hemisphere from a right
 * one. BrainCAD carried that as an open caveat until the Allen Connectivity
 * Atlas settled it from outside the volume — every tracing experiment records
 * the hemisphere its injection went into, as a label rather than as geometry.
 *
 * Measured over 36 experiments across VISp, SSp, CP, STR, HPF and VIS: every
 * injection Allen labels `hemisphere_id` 2 (right) has its voxels above the
 * midline on array axis 2, and both left-labelled injections fall below it.
 * 36 of 36, no exceptions. So axis 2 starts at the LEFT and increases
 * rightward, which is why these profiles are `asl` and not `asr`.
 */
export const ML_HANDEDNESS_NOTE =
  'Left/right is set from Allen connectivity injection hemispheres (36/36 ' +
  'agreement), not from the template, which is symmetric. Still confirm ' +
  'your own left/right at the rig.'

/**
 * Perens et al. 2023 skull-derived stereotaxic coordinate system, as
 * distributed by BrainGlobe (`perens_stereotaxic_mri_mouse_25um`).
 *
 * Landmark voxel positions are taken directly from the paper, which reports
 * them in the T2-weighted MRI template space using the Paxinos & Franklin
 * convention (x = ML, y = AP, z = DV):
 *
 *   bregma  x = 227.00 ± 4.73, y = 270.00 ± 5.80, z = 16.00 ± 1.85
 *   lambda  x = 227.00 ± 3.32, y = 462.00 ± 1.87, z = 16.00 ± 1.00
 *   Δ(bregma, lambda) = 192 ± 5.94 voxels = 4.80 ± 0.15 mm
 *
 * The BrainGlobe package is `asr`-oriented with shape (615, 297, 455), so the
 * paper's (x, y, z) map onto array axes (i1→DV is axis 1, etc.) as encoded
 * below. Two independent consistency checks hold: the reported ML index (227)
 * falls on the midline of the 455-voxel ML axis, and the AP index difference
 * (462 − 270 = 192 voxels at 25 µm) reproduces the published 4.80 mm
 * bregma-lambda distance exactly.
 */
export const PERENS_STEREOTAXIC_MRI: CoordinateProfile = {
  id: 'perens-stereotaxic-mri-25um',
  label: 'Perens 2023 stereotaxic MRI (25 µm)',
  space: makeVolumeSpace([615, 297, 455], 25, 'asl'),
  // asl → axis0 = AP (paper y), axis1 = DV (paper z), axis2 = ML (paper x)
  bregma: { i0: 270, i1: 16, i2: 227, sdVoxels: [5.8, 1.85, 4.73] },
  lambda: { i0: 462, i1: 16, i2: 227, sdVoxels: [1.87, 1.0, 3.32] },
  scale: [1, 1, 1], // already in stereotaxic scale by construction
  pitchCorrectionDeg: 0, // template rotated so bregma and lambda are level
  dvReference: 'bregma-plane',
  provenance: {
    confidence: 'published',
    citation:
      'Perens et al. (2023), Multimodal 3D Mouse Brain Atlas Framework with the ' +
      'Skull-Derived Coordinate System. Neuroinformatics 21(2):269-286.',
    url: 'https://doi.org/10.1007/s12021-023-09623-9',
    caveats: [
      'Landmarks are an average over 12 micro-CT-imaged C57BL/6J skulls (10 weeks, male).',
      'Bregma position carries a published SD of roughly 0.12 mm AP and 0.05 mm DV.',
      'Bregma-lambda distance varies between animals (4.80 ± 0.15 mm); verify on your animal.',
      ML_HANDEDNESS_NOTE,
    ],
  },
}

/**
 * Allen CCFv3 with a community-convention bregma position.
 *
 * Unlike the Perens profile, these landmark coordinates do NOT come from a
 * single published measurement — CCFv3 defines no bregma, and the values in
 * circulation differ between tools. This profile exists so the user can work
 * directly in the native Allen annotation volume, but its coordinates are
 * marked `community-convention` and the UI must surface that.
 */
export const ALLEN_CCFV3_50UM: CoordinateProfile = {
  id: 'allen-ccfv3-50um',
  label: 'Allen CCFv3 (50 µm, community bregma)',
  space: makeVolumeSpace([264, 160, 228], 50, 'asl'),
  // 5400 µm / 50 = 108 (AP), 332 µm / 50 ≈ 6.6 (DV), 5700 µm / 50 = 114 (ML midline)
  bregma: { i0: 108, i1: 6.64, i2: 114 },
  scale: [1, 1, 1],
  pitchCorrectionDeg: 0,
  dvReference: 'bregma-plane',
  provenance: {
    confidence: 'community-convention',
    citation:
      'Allen Mouse Brain Common Coordinate Framework v3 (CCFv3), ' +
      'Wang et al. (2020), Cell 181(4):936-953. Bregma placement is a community ' +
      'convention, not an Allen Institute definition.',
    url: 'https://doi.org/10.1016/j.cell.2020.04.007',
    caveats: [
      'CCFv3 does not define bregma. This position is a widely used convention, not a measurement.',
      'Published CCF-to-stereotaxic scaling factors disagree; this profile applies none.',
      'For coordinates you intend to use surgically, prefer the Perens stereotaxic profile.',
      ML_HANDEDNESS_NOTE,
    ],
  },
}

export const BUILT_IN_PROFILES: readonly CoordinateProfile[] = [
  PERENS_STEREOTAXIC_MRI,
  ALLEN_CCFV3_50UM,
]

/**
 * The profile the app opens with.
 *
 * This is the Allen CCFv3 profile, not the (better-provenanced) Perens one,
 * because the annotation volume BrainCAD ships is the Allen CCFv3 volume. A
 * profile's landmark indices are only meaningful in its own template space, so
 * the default must match the shipped data. Selecting the Perens profile
 * requires shipping the Perens volume alongside it.
 */
export const DEFAULT_PROFILE_ID = ALLEN_CCFV3_50UM.id

export function getProfile(id: string): CoordinateProfile {
  const found = BUILT_IN_PROFILES.find((p) => p.id === id)
  if (!found) throw new Error(`Unknown coordinate profile: ${id}`)
  return found
}

/**
 * Whether a profile can be used with a given annotation volume.
 *
 * Landmark voxel indices are expressed in one specific template space. Applying
 * the Perens bregma index to the Allen volume, or vice versa, produces
 * coordinates that look entirely plausible but are wrong by millimetres — the
 * most dangerous failure mode in the whole application, because nothing about
 * the 3D view would look amiss. So the pairing is checked explicitly rather
 * than left to convention.
 */
export function profileMatchesSpace(
  profile: CoordinateProfile,
  space: VolumeSpace,
): boolean {
  return (
    profile.space.resolutionUm === space.resolutionUm &&
    profile.space.shape[0] === space.shape[0] &&
    profile.space.shape[1] === space.shape[1] &&
    profile.space.shape[2] === space.shape[2] &&
    // Orientation too, and for the same reason as shape: the loaded volume's
    // code comes from the atlas manifest on disk while the profile's is
    // compiled in, so the two can disagree after a manifest is regenerated.
    // Matching shapes with opposite ML handedness is not a near miss — every
    // region lookup lands in the wrong hemisphere, silently.
    profile.space.axes.every((axis, i) => axis.origin === space.axes[i]!.origin)
  )
}

/** Profiles valid for a given loaded volume. */
export function profilesForSpace(space: VolumeSpace): readonly CoordinateProfile[] {
  return BUILT_IN_PROFILES.filter((p) => profileMatchesSpace(p, space))
}

/** @throws when a profile is paired with a volume it does not describe. */
export function assertProfileMatchesSpace(
  profile: CoordinateProfile,
  space: VolumeSpace,
): void {
  if (profileMatchesSpace(profile, space)) return
  throw new Error(
    `Coordinate profile "${profile.label}" describes a ` +
      `${profile.space.shape.join('x')} volume at ${profile.space.resolutionUm} µm, ` +
      `but the loaded annotation volume is ${space.shape.join('x')} at ` +
      `${space.resolutionUm} µm. Profile orientation is ` +
      `${profile.space.axes.map((a) => a.origin).join('')}, volume is ` +
      `${space.axes.map((a) => a.origin).join('')}. Refusing to mix template spaces.`,
  )
}
