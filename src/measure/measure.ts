/**
 * Two-point measurement.
 *
 * The blueprint is emphatic (§14) that the four kinds of distance must not be
 * silently mixed, so every measurement records which kind it is and the UI
 * labels it. Only straight-line distance is computed at M3; the other kinds
 * exist in the type so that adding them later cannot quietly reuse the
 * Euclidean label.
 */

import { Vector3 } from 'three'

import type { Stereotaxic } from '../atlas/coords.ts'
import { euclideanDistanceMm } from '../atlas/coords.ts'
import { worldToStereotaxic } from '../scene/world.ts'

export type DistanceKind =
  | 'euclidean'
  | 'surface'
  | 'along-object'
  | 'along-trajectory'

export const DISTANCE_LABEL: Record<DistanceKind, string> = {
  euclidean: 'Straight line',
  surface: 'Along surface',
  'along-object': 'Along object',
  'along-trajectory': 'Along trajectory',
}

/** What a measurement endpoint was snapped to, recorded for provenance. */
export type SnapKind =
  | 'free'
  | 'mesh-surface'
  | 'target'
  | 'object-anchor'
  | 'object-pivot'

export const SNAP_LABEL: Record<SnapKind, string> = {
  free: 'free point',
  'mesh-surface': 'surface',
  target: 'target',
  'object-anchor': 'anchor',
  'object-pivot': 'pivot',
}

export interface MeasurePoint {
  readonly coord: Stereotaxic
  readonly snap: SnapKind
  /** What it snapped to, for the planning sheet ("CA1 surface", "Pipette tip"). */
  readonly snappedTo: string | null
}

export interface Measurement {
  readonly id: string
  name: string
  readonly a: MeasurePoint
  readonly b: MeasurePoint
  readonly kind: DistanceKind
  visible: boolean
}

/** Straight-line distance in millimetres. */
export function measurementDistanceMm(measurement: Measurement): number {
  return euclideanDistanceMm(measurement.a.coord, measurement.b.coord)
}

/** Per-axis differences, b − a, as the MEASURE panel reports them. */
export function measurementComponents(measurement: Measurement): Stereotaxic {
  return {
    ap: measurement.b.coord.ap - measurement.a.coord.ap,
    ml: measurement.b.coord.ml - measurement.a.coord.ml,
    dv: measurement.b.coord.dv - measurement.a.coord.dv,
  }
}

/**
 * Format a distance in both millimetres and micrometres.
 *
 * The blueprint asks for both because injection volumes and cortical layers are
 * discussed in micrometres while stereotaxic coordinates are in millimetres,
 * and forcing the reader to convert is where mistakes happen.
 */
export function formatDistance(mm: number): { mm: string; um: string } {
  return { mm: `${mm.toFixed(3)} mm`, um: `${Math.round(mm * 1000)} µm` }
}

/** A candidate snap target offered to the measurement tool. */
export interface SnapCandidate {
  readonly coord: Stereotaxic
  readonly kind: SnapKind
  readonly label: string
}

/**
 * Choose the best snap for a picked point.
 *
 * Named features (a target marker, an object's anchor) win over a raw surface
 * hit within the radius, because a measurement to "the pipette tip" is
 * reproducible and one to a point that happened to be under the cursor is not.
 */
export function resolveSnap(
  picked: Stereotaxic,
  candidates: readonly SnapCandidate[],
  radiusMm: number,
): MeasurePoint {
  let best: { candidate: SnapCandidate; distance: number } | null = null

  for (const candidate of candidates) {
    const distance = euclideanDistanceMm(picked, candidate.coord)
    if (distance > radiusMm) continue
    if (!best || distance < best.distance) best = { candidate, distance }
  }

  if (!best) return { coord: picked, snap: 'free', snappedTo: null }
  return {
    coord: best.candidate.coord,
    snap: best.candidate.kind,
    snappedTo: best.candidate.label,
  }
}

/** World-space midpoint of a measurement, for placing its label. */
export function measurementMidpoint(measurement: Measurement): Vector3 {
  const a = measurement.a.coord
  const b = measurement.b.coord
  return new Vector3(
    (a.ml + b.ml) / 2,
    (a.dv + b.dv) / 2,
    (a.ap + b.ap) / 2,
  )
}

/** Convert a world-space pick into a stereotaxic coordinate. */
export function pickToStereotaxic(point: Vector3): Stereotaxic {
  return worldToStereotaxic(point)
}

/** A concise one-line summary, used in the panel and the planning sheet. */
export function describeMeasurement(measurement: Measurement): string {
  const distance = measurementDistanceMm(measurement)
  const from = measurement.a.snappedTo ?? 'free point'
  const to = measurement.b.snappedTo ?? 'free point'
  return `${from} → ${to}: ${distance.toFixed(3)} mm (${DISTANCE_LABEL[measurement.kind].toLowerCase()})`
}
