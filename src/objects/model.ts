/**
 * The scene-object model.
 *
 * Objects are stored as plain, serialisable descriptions — parameters, target,
 * orientation, display settings — never as three.js geometry. The geometry is
 * derived from the description on demand, which is what lets a project file be
 * a JSON document and lets editing a diameter rebuild the part without any
 * separate update path.
 *
 * Imported custom geometry is the one thing that cannot be re-derived from
 * numbers, so it lives in a side registry keyed by object id, and the project
 * file records where it came from.
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
   * Defaults to false for insertion instruments, which are meant to enter the
   * brain, and true for objectives, headplates and other hardware that must
   * stay outside it.
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

/** Default display colours, chosen to stay distinguishable over grey anatomy. */
export const KIND_COLOR: Record<ObjectKind, string> = {
  pipette: '#7fd4ff',
  cannula: '#ffd166',
  prism: '#c792ea',
  objective: '#8fa9c4',
  custom: '#7ee0b8',
}

export const KIND_LABEL: Record<ObjectKind, string> = {
  pipette: 'Glass pipette',
  cannula: 'Cannula',
  prism: 'Prism',
  objective: 'Objective',
  custom: 'Custom geometry',
}

/** Objects that describe an insertion, and so have a meaningful trajectory. */
export function isInsertionKind(kind: ObjectKind): boolean {
  return kind === 'pipette' || kind === 'cannula' || kind === 'prism'
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
    spec: kind === 'custom' ? null : defaultParamsFor(kind),
    source: null,
    target,
    orientation: { ...NO_ROTATION },
    pivotMode: 'default',
    pivotCustom: [0, 0, 0],
    color: KIND_COLOR[kind],
    opacity: kind === 'objective' ? 0.45 : 0.9,
    visible: true,
    collision: true,
    anatomyCollision: !isInsertionKind(kind),
    notes: '',
  }
}

/**
 * Resolve an object's geometry, anchor, pivot and axis.
 *
 * Returns null for a custom object whose geometry has not been registered —
 * which happens when a project is reopened without its source file, and must
 * be reported to the user rather than rendered as an empty space.
 */
export function resolveGeometry(object: SceneObject): BuiltPrimitive | null {
  if (object.kind === 'custom') return customGeometry.get(object.id) ?? null
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
  // Custom geometry is owned by the registry and reused across renders;
  // primitive geometry is rebuilt per call and must be released.
  if (object.kind !== 'custom') geometry.dispose()
}
