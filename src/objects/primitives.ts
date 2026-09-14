/**
 * Parametric hardware primitives.
 *
 * Each builder returns geometry in local millimetres *plus* the two points
 * that make the object placeable: where it rotates (pivot) and which point
 * must sit on the target (anchor). Declaring those alongside the geometry is
 * what lets a prism's imaging face and a pipette's tip be driven by the same
 * placement solve.
 *
 * Local convention: the instrument points down -Y, with its functional end
 * (tip, focal point, imaging face) at or near the local origin, so an
 * unrotated object inserted at a target reads the way an experimenter expects.
 */

import {
  BufferGeometry,
  CylinderGeometry,
  BoxGeometry,
  Vector3,
  type BufferAttribute,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type ObjectKind = 'pipette' | 'cannula' | 'prism' | 'objective' | 'custom'

export interface BuiltPrimitive {
  readonly geometry: BufferGeometry
  /** Point rotation happens about, in local millimetres. */
  readonly pivot: Vector3
  /** Point that must land on the AP/ML/DV target, in local millimetres. */
  readonly anchor: Vector3
  /** Insertion or optical axis in local space (unit, normally straight down). */
  readonly axis: Vector3
  /** How far the object extends back along its axis from the anchor. */
  readonly lengthMm: number
}

const DOWN = new Vector3(0, -1, 0)

/* ------------------------------------------------------------------ pipette */

export interface PipetteParams {
  /** Outer diameter of the shaft, mm. */
  shaftDiameterMm: number
  /** Shaft length above the taper, mm. */
  shaftLengthMm: number
  /** Diameter at the very tip, mm. */
  tipDiameterMm: number
  /** Length of the tapered region, mm. */
  taperLengthMm: number
}

export const DEFAULT_PIPETTE: PipetteParams = {
  shaftDiameterMm: 1.0,
  shaftLengthMm: 12,
  tipDiameterMm: 0.02,
  taperLengthMm: 5,
}

/**
 * Glass injection pipette: a tapered tip blending into a parallel shaft.
 *
 * Anchor is the tip — the point delivering virus, which is what an injection
 * coordinate refers to. Pivot is also the tip by default, because that is the
 * point an experimenter wants to hold fixed while adjusting approach angle.
 */
export function buildPipette(params: PipetteParams): BuiltPrimitive {
  const { shaftDiameterMm, shaftLengthMm, tipDiameterMm, taperLengthMm } = params

  const taper = new CylinderGeometry(
    shaftDiameterMm / 2,
    Math.max(tipDiameterMm / 2, 0.002),
    taperLengthMm,
    24,
    1,
    true,
  )
  taper.translate(0, taperLengthMm / 2, 0)

  const shaft = new CylinderGeometry(
    shaftDiameterMm / 2,
    shaftDiameterMm / 2,
    shaftLengthMm,
    24,
  )
  shaft.translate(0, taperLengthMm + shaftLengthMm / 2, 0)

  return {
    geometry: mergeGeometries([taper, shaft], false) ?? taper,
    pivot: new Vector3(0, 0, 0),
    anchor: new Vector3(0, 0, 0),
    axis: DOWN.clone(),
    lengthMm: taperLengthMm + shaftLengthMm,
  }
}

/* ------------------------------------------------------------------ cannula */

export interface CannulaParams {
  outerDiameterMm: number
  innerDiameterMm: number
  /** Length of the cannula below the ferrule, mm. */
  lengthMm: number
  ferruleDiameterMm: number
  ferruleLengthMm: number
}

export const DEFAULT_CANNULA: CannulaParams = {
  outerDiameterMm: 0.5,
  innerDiameterMm: 0.26,
  lengthMm: 5,
  ferruleDiameterMm: 2.5,
  ferruleLengthMm: 6,
}

/**
 * Guide cannula with a ferrule.
 *
 * Anchor is the tip (the delivery site). Pivot sits at the top of the cannula
 * shaft where it meets the ferrule — approximately the skull surface for an
 * implanted cannula, which is the point it actually rotates about when an
 * experimenter angles it.
 */
export function buildCannula(params: CannulaParams): BuiltPrimitive {
  const { outerDiameterMm, innerDiameterMm, lengthMm, ferruleDiameterMm, ferruleLengthMm } =
    params

  const shaft = new CylinderGeometry(
    outerDiameterMm / 2,
    outerDiameterMm / 2,
    lengthMm,
    20,
    1,
    true,
  )
  shaft.translate(0, lengthMm / 2, 0)

  // Lumen, drawn as a thin inner wall so the bore reads visually.
  const bore = new CylinderGeometry(
    Math.max(innerDiameterMm / 2, 0.01),
    Math.max(innerDiameterMm / 2, 0.01),
    lengthMm,
    16,
    1,
    true,
  )
  bore.translate(0, lengthMm / 2, 0)

  const ferrule = new CylinderGeometry(
    ferruleDiameterMm / 2,
    ferruleDiameterMm / 2,
    ferruleLengthMm,
    24,
  )
  ferrule.translate(0, lengthMm + ferruleLengthMm / 2, 0)

  return {
    geometry: mergeGeometries([shaft, bore, ferrule], false) ?? shaft,
    pivot: new Vector3(0, lengthMm, 0),
    anchor: new Vector3(0, 0, 0),
    axis: DOWN.clone(),
    lengthMm: lengthMm + ferruleLengthMm,
  }
}

/* -------------------------------------------------------------------- prism */

export interface PrismParams {
  /** Edge length of the square face, mm. */
  widthMm: number
  /** Height of the prism along the insertion axis, mm. */
  heightMm: number
  /** Depth front-to-back, mm. */
  depthMm: number
  /** How far below the imaging-face centre the prism extends, mm. */
  insertionDepthMm: number
}

export const DEFAULT_PRISM: PrismParams = {
  widthMm: 1.0,
  heightMm: 1.0,
  depthMm: 1.0,
  insertionDepthMm: 0.5,
}

/**
 * Right-angle microprism.
 *
 * The anchor is deliberately NOT the geometric centre but the centre of the
 * imaging face, because the biologically meaningful coordinate is the tissue
 * the prism images — typically a specific cortical layer or hippocampal
 * stratum — not where the STL's origin happens to be. This is the case the
 * blueprint calls out for a user-definable imaging face, and the reason the
 * anchor is a first-class concept rather than an afterthought.
 *
 * The imaging face is the +Z face; roll therefore aims it.
 */
export function buildPrism(params: PrismParams): BuiltPrimitive {
  const { widthMm, heightMm, depthMm, insertionDepthMm } = params

  const body = new BoxGeometry(widthMm, heightMm, depthMm)
  // Position so the imaging-face centre sits at the local origin.
  body.translate(0, heightMm / 2 - insertionDepthMm, -depthMm / 2)

  return {
    geometry: body,
    pivot: new Vector3(0, 0, 0),
    anchor: new Vector3(0, 0, 0),
    axis: DOWN.clone(),
    lengthMm: heightMm,
  }
}

/** Local-space centre and outward normal of a prism's imaging face. */
export function prismImagingFace(): {
  centre: Vector3
  normal: Vector3
} {
  return { centre: new Vector3(0, 0, 0), normal: new Vector3(0, 0, 1) }
}

/* ---------------------------------------------------------------- objective */

export interface ObjectiveParams {
  /** Working distance from the front element to the focal point, mm. */
  workingDistanceMm: number
  /** Main barrel diameter, mm. */
  barrelDiameterMm: number
  /** Diameter at the front of the nose cone, mm. */
  frontDiameterMm: number
  /** Length of the tapered nose, mm. */
  noseLengthMm: number
  /** Length of the parallel barrel above the nose, mm. */
  barrelLengthMm: number
  /** Extra clearance shell added around the body, mm. */
  safetyMarginMm: number
  /**
   * Diameter of the imaged field at the focal plane, mm.
   *
   * Not derivable from the other parameters without magnification and the
   * tube-lens focal length, so it is entered directly. Typical two-photon
   * fields are 0.5-1.5 mm.
   */
  fieldOfViewMm: number
}

export const DEFAULT_OBJECTIVE: ObjectiveParams = {
  workingDistanceMm: 3.0,
  barrelDiameterMm: 28,
  frontDiameterMm: 8,
  noseLengthMm: 12,
  barrelLengthMm: 40,
  safetyMarginMm: 0.5,
  fieldOfViewMm: 1.0,
}

/**
 * Microscope objective, simplified to the solid that actually limits access:
 * a tapered nose on a parallel barrel.
 *
 * The anchor is the focal point, sitting `workingDistance` *below* the front
 * element — so placing an objective on a target means its focal plane is on
 * that target, which is the question optical-access planning asks. Pivot is
 * also the focal point, so tilting the objective sweeps it around the sample
 * rather than swinging the focus away.
 */
export function buildObjective(params: ObjectiveParams): BuiltPrimitive {
  const {
    workingDistanceMm,
    barrelDiameterMm,
    frontDiameterMm,
    noseLengthMm,
    barrelLengthMm,
    safetyMarginMm,
  } = params

  const margin = Math.max(0, safetyMarginMm)

  const nose = new CylinderGeometry(
    barrelDiameterMm / 2 + margin,
    frontDiameterMm / 2 + margin,
    noseLengthMm,
    32,
    1,
    true,
  )
  nose.translate(0, workingDistanceMm + noseLengthMm / 2, 0)

  const barrel = new CylinderGeometry(
    barrelDiameterMm / 2 + margin,
    barrelDiameterMm / 2 + margin,
    barrelLengthMm,
    32,
  )
  barrel.translate(0, workingDistanceMm + noseLengthMm + barrelLengthMm / 2, 0)

  return {
    geometry: mergeGeometries([nose, barrel], false) ?? nose,
    pivot: new Vector3(0, 0, 0),
    anchor: new Vector3(0, 0, 0),
    axis: DOWN.clone(),
    lengthMm: workingDistanceMm + noseLengthMm + barrelLengthMm,
  }
}

/* ------------------------------------------------------------------ dispatch */

export type PrimitiveParams =
  | { kind: 'pipette'; params: PipetteParams }
  | { kind: 'cannula'; params: CannulaParams }
  | { kind: 'prism'; params: PrismParams }
  | { kind: 'objective'; params: ObjectiveParams }

export function buildPrimitive(spec: PrimitiveParams): BuiltPrimitive {
  switch (spec.kind) {
    case 'pipette':
      return buildPipette(spec.params)
    case 'cannula':
      return buildCannula(spec.params)
    case 'prism':
      return buildPrism(spec.params)
    case 'objective':
      return buildObjective(spec.params)
  }
}

export function defaultParamsFor(kind: Exclude<ObjectKind, 'custom'>): PrimitiveParams {
  switch (kind) {
    case 'pipette':
      return { kind: 'pipette', params: { ...DEFAULT_PIPETTE } }
    case 'cannula':
      return { kind: 'cannula', params: { ...DEFAULT_CANNULA } }
    case 'prism':
      return { kind: 'prism', params: { ...DEFAULT_PRISM } }
    case 'objective':
      return { kind: 'objective', params: { ...DEFAULT_OBJECTIVE } }
  }
}

/** Number of triangles in a built primitive, for the properties panel. */
export function triangleCount(geometry: BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return index.count / 3
  const position = geometry.getAttribute('position') as BufferAttribute | undefined
  return position ? position.count / 3 : 0
}
