/**
 * The scene-object model.
 *
 * Objects are stored as plain, serialisable descriptions — parameters, target,
 * orientation, display settings — never as three.js geometry. The geometry is
 * derived from the description on demand, which is what lets a project file be
 * a JSON document and lets editing a diameter rebuild the part without any
 * separate update path.
 *
 * Mesh geometry is the one thing that cannot be re-derived from numbers, so it
 * lives in a side registry keyed by object id, and the project file records
 * where it came from. That applies to a user's imported STL and equally to a
 * bundled hardware model: the difference between them is provenance, not
 * mechanism, so both take the same path.
 */

import { Vector3, type BufferGeometry } from 'three'

import type { Stereotaxic } from '../atlas/coords.ts'
import type { Orientation } from './placement.ts'
import { NO_ROTATION } from './placement.ts'
import {
  buildPrimitive,
  defaultParamsFor,
  type BuiltPrimitive,
  type ObjectKind,
  type PrimitiveParams,
} from './primitives.ts'
import type { ImportOptions, SourceUnit } from './import.ts'

/** Which point an object rotates about. */
export type PivotMode =
  /** The primitive's own natural pivot (cannula collar, objective focus…). */
  | 'default'
  /** Rotate about the anatomical anchor itself. */
  | 'anchor'
  /** A user-placed point, in local millimetres. */
  | 'custom'

export interface CustomSource {
  readonly filename: string
  readonly format: string
  readonly unit: SourceUnit
  readonly scale: number
  readonly origin: ImportOptions['origin']
  readonly triangleCount: number
  /**
   * Identifier of the bundled model this came from, or null for a user import.
   *
   * This is what lets a reopened project rebuild its geometry. An imported STL
   * lives on the user's disk and cannot be recovered from the project file; a
   * built-in ships with the app, so recording which one restores it exactly.
   */
  readonly builtinId: string | null
}

export interface SceneObject {
  readonly id: string
  kind: ObjectKind
  name: string
  /** Parametric description; absent for imported custom geometry. */
  spec: PrimitiveParams | null
  /** Provenance for imported geometry; absent for primitives. */
  source: CustomSource | null
  /** Stereotaxic position the anchor is placed at. */
  target: Stereotaxic
  orientation: Orientation
  pivotMode: PivotMode
  /** Local-space pivot, used when `pivotMode` is 'custom'. */
  pivotCustom: readonly [number, number, number]
  color: string
  opacity: number
  visible: boolean
  /** Whether this object participates in collision checking at all. */
  collision: boolean
  /**
   * Whether to check this object against anatomy.
   *
   * Off for every kind. Collision checking answers "will these two pieces of
   * hardware hit each other", and the atlas is not a piece of hardware: it is
   * an averaged reference brain whose surface is nowhere near a given
   * animal's skull to within the clearances being measured, so a hit against
   * it is not evidence of anything. Keeping it on for objectives and
   * headplates also buried the pairs that do matter under a permanent red
   * flag from the one object that was always going to touch tissue.
   *
   * Still a per-object switch rather than a deleted feature: an exclusion
   * volume drawn as an atlas structure is a legitimate thing to check against,
   * and turning it on for one object says so explicitly.
   */
  anatomyCollision: boolean
  notes: string
}

/**
 * Geometry for imported objects, keyed by object id.
 *
 * Deliberately outside the store: BufferGeometry is not serialisable, and
 * keeping it out means the store can be JSON-stringified straight into a
 * project file without a custom replacer.
 */
const customGeometry = new Map<string, BuiltPrimitive>()

export function registerCustomGeometry(id: string, built: BuiltPrimitive): void {
  customGeometry.get(id)?.geometry.dispose()
  customGeometry.set(id, built)
}

export function releaseCustomGeometry(id: string): void {
  customGeometry.get(id)?.geometry.dispose()
  customGeometry.delete(id)
}

export function hasCustomGeometry(id: string): boolean {
  return customGeometry.has(id)
}

/**
 * Drop every registered mesh.
 *
 * Opening a project replaces the object list wholesale, and object ids are
 * reused across plans — `object-1` in the new file is a different part from
 * `object-1` in the old one. Without this, geometry from the previous session
 * would still be keyed under a live id and would be rendered in place of the
 * part the file actually describes.
 */
export function releaseAllCustomGeometry(): void {
  for (const built of customGeometry.values()) built.geometry.dispose()
  customGeometry.clear()
}

/** Default display colours, chosen to stay distinguishable over grey anatomy. */
export const KIND_COLOR: Record<ObjectKind, string> = {
  pipette: '#7fd4ff',
  cannula: '#ffd166',
  prism: '#c792ea',
  objective: '#8fa9c4',
  headbar: '#d6dde6',
  custom: '#7ee0b8',
}

export const KIND_LABEL: Record<ObjectKind, string> = {
  pipette: 'Glass pipette',
  cannula: 'Cannula',
  prism: 'Prism',
  objective: 'Objective',
  headbar: 'Headbar',
  custom: 'Custom geometry',
}

export function makeObject(
  id: string,
  kind: ObjectKind,
  target: Stereotaxic,
  name?: string,
): SceneObject {
  return {
    id,
    kind,
    name: name ?? KIND_LABEL[kind],
    spec: defaultParamsFor(kind),
    source: null,
    target,
    orientation: { ...NO_ROTATION },
    pivotMode: 'default',
    pivotCustom: [0, 0, 0],
    color: KIND_COLOR[kind],
    opacity: kind === 'objective' ? 0.45 : 0.9,
    visible: true,
    collision: true,
    anatomyCollision: false,
    notes: '',
  }
}

/**
 * Whether this object's shape comes from a mesh rather than from its spec.
 *
 * Registered geometry wins over a spec, which is what lets a built-in model
 * keep its semantic kind — a bundled Nikon objective is an *objective*, so the
 * optics, the collision defaults and the planning sheet all still apply to it
 * — while drawing the real barrel instead of a cylinder.
 */
export function isMeshBacked(object: SceneObject): boolean {
  return customGeometry.has(object.id)
}

/**
 * Resolve an object's geometry, anchor, pivot and axis.
 *
 * Returns null for a mesh-backed object whose geometry has not been registered
 * — which happens when a project is reopened without its source file, and must
 * be reported to the user rather than rendered as an empty space.
 */
export function resolveGeometry(object: SceneObject): BuiltPrimitive | null {
  const mesh = customGeometry.get(object.id)
  if (mesh) return mesh
  if (object.kind === 'custom' || object.kind === 'headbar') return null
  return object.spec ? buildPrimitive(object.spec) : null
}

/** The pivot point actually in force, in local millimetres. */
export function effectivePivot(object: SceneObject, built: BuiltPrimitive): Vector3 {
  switch (object.pivotMode) {
    case 'anchor':
      return built.anchor.clone()
    case 'custom':
      return new Vector3(...object.pivotCustom)
    case 'default':
      return built.pivot.clone()
  }
}

/** Whether this object's natural pivot differs from its anchor. */
export function pivotDiffersFromAnchor(built: BuiltPrimitive): boolean {
  return built.pivot.distanceToSquared(built.anchor) > 1e-12
}

/** Dispose derived geometry that the caller owns. */
export function disposeIfDerived(object: SceneObject, geometry: BufferGeometry): void {
  // Mesh geometry is owned by the registry and reused across renders;
  // primitive geometry is rebuilt per call and must be released.
  if (!isMeshBacked(object)) geometry.dispose()
}
