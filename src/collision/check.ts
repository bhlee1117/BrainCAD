/**
 * Mesh collision and clearance.
 *
 * Built on three-mesh-bvh: `intersectsGeometry` answers the boolean, and
 * `closestPointToGeometry` gives the minimum separation when there is no
 * overlap. Those two calls cover everything the blueprint's tri-state display
 * needs, and the same pair backs the objective-angle sweep later.
 *
 * Everything here is a pure function over geometry and matrices — no React, no
 * store, no scene graph. That keeps it testable in Node, and means moving the
 * work to a Web Worker later is a change of caller, not a rewrite.
 */

import { Box3, Matrix4, Vector3, type BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

/**
 * Collision state, matching the blueprint's four display states (§11).
 *
 * `unknown` exists because a result that could not be computed must never be
 * shown as "safe" — an empty geometry or a failed query is not evidence of
 * clearance.
 */
export type CollisionState = 'safe' | 'near' | 'collision' | 'unknown'

export interface CollisionSettings {
  /**
   * Clearance below which a pair is reported as `near`, in millimetres.
   *
   * Atlas surfaces are averaged, marching-cubes reconstructions and object
   * dimensions are nominal, so a non-zero threshold is not padding — it is an
   * honest acknowledgement that sub-tolerance numbers are not meaningful.
   */
  warnClearanceMm: number
  /** Treat overlaps shallower than this as contact rather than collision. */
  toleranceMm: number
  /**
   * Only pairs whose bounding boxes come within this distance get an exact
   * surface query; beyond it the pair is reported safe with a lower bound.
   *
   * The cheap box test is a pruning device, not a measurement: a bounding box
   * encloses its mesh, so the box gap is always an under-estimate of the true
   * surface clearance. Reporting it as the clearance would put a number in
   * front of the user that is quietly wrong, so distant pairs report no exact
   * figure at all and close pairs — the ones that actually matter — are always
   * measured properly.
   */
  exactQueryWindowMm: number
}

export const DEFAULT_COLLISION_SETTINGS: CollisionSettings = {
  warnClearanceMm: 0.25,
  toleranceMm: 0.0,
  exactQueryWindowMm: 5,
}

export interface PairResult {
  readonly state: CollisionState
  /**
   * Minimum distance between the two surfaces, in millimetres.
   *
   * Null when the meshes overlap (there is no positive separation to report)
   * or when the query could not run.
   */
  readonly clearanceMm: number | null
  /**
   * A guaranteed-minimum separation, in millimetres, for pairs too far apart
   * to be worth an exact query. Never presented as the clearance itself.
   */
  readonly lowerBoundMm?: number
  /** Closest point on each surface, in world space, when available. */
  readonly pointA: Vector3 | null
  readonly pointB: Vector3 | null
  /** Why the result is `unknown`, for display. */
  readonly reason?: string
}

const UNKNOWN = (reason: string): PairResult => ({
  state: 'unknown',
  clearanceMm: null,
  pointA: null,
  pointB: null,
  reason,
})

/**
 * A mesh prepared for collision queries: geometry, its BVH, and where it sits.
 *
 * BVH construction is the expensive part (tens of milliseconds for the brain
 * surface), so callers cache these across frames and rebuild only when the
 * geometry itself changes — not when an object merely moves.
 */
export interface CollisionMesh {
  readonly id: string
  readonly label: string
  readonly geometry: BufferGeometry
  readonly bvh: MeshBVH
  /** Object-to-world transform. */
  readonly matrixWorld: Matrix4
  /** Anatomy is reported differently from hardware in the UI. */
  readonly kind: 'anatomy' | 'hardware'
  /**
   * Skip pairs between this hardware and anatomy.
   *
   * Insertion instruments cross the brain surface by design — that is what
   * inserting one means — so checking them against it would flag every
   * correctly-placed pipette as a collision and bury the results that matter.
   */
  readonly ignoreAnatomy?: boolean
}

/**
 * Build a BVH for a geometry, or null when the geometry is unusable.
 *
 * The tree is also attached as `geometry.boundsTree`, which is how
 * three-mesh-bvh discovers it for the *other* operand of a query. Without it,
 * a geometry-to-geometry query walks one tree but brute-forces the other
 * side's triangles — the difference between a few milliseconds and a second on
 * meshes this size.
 */
export function buildBvh(geometry: BufferGeometry): MeshBVH | null {
  const position = geometry.getAttribute('position')
  if (!position || position.count < 3) return null
  try {
    const bvh = new MeshBVH(geometry)
    ;(geometry as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = bvh
    return bvh
  } catch {
    return null
  }
}

/** World-space axis-aligned bounds of a prepared mesh. */
export function worldBounds(mesh: CollisionMesh): Box3 {
  const box = mesh.geometry.boundingBox ?? mesh.geometry.computeBoundingBox() ?? null
  const source = mesh.geometry.boundingBox ?? box ?? new Box3()
  return source.clone().applyMatrix4(mesh.matrixWorld)
}

/**
 * Check one pair of meshes.
 *
 * A bounding-box rejection runs first. It is not merely an optimisation: most
 * pairs in a surgical scene are nowhere near each other, and skipping the BVH
 * descent for those is what keeps an interactive drag responsive.
 */
export function checkPair(
  a: CollisionMesh,
  b: CollisionMesh,
  settings: CollisionSettings = DEFAULT_COLLISION_SETTINGS,
): PairResult {
  // Transform from b's local space into a's local space.
  const aToB = new Matrix4().copy(a.matrixWorld).invert().multiply(b.matrixWorld)

  const boxA = worldBounds(a)
  const boxB = worldBounds(b)
  const gap = boxDistance(boxA, boxB)

  // Far apart by bounding box alone. The true surface clearance is at least
  // this large, but it is not equal to it, so it is reported as a bound rather
  // than as a measurement.
  if (gap > settings.exactQueryWindowMm) {
    return { state: 'safe', clearanceMm: null, lowerBoundMm: gap, pointA: null, pointB: null }
  }

  let overlaps: boolean
  try {
    overlaps = a.bvh.intersectsGeometry(b.geometry, aToB)
  } catch (error) {
    return UNKNOWN(error instanceof Error ? error.message : 'Intersection test failed')
  }

  if (overlaps) {
    return { state: 'collision', clearanceMm: null, pointA: null, pointB: null }
  }

  const pointA = { point: new Vector3(), distance: 0, faceIndex: 0 }
  const pointB = { point: new Vector3(), distance: 0, faceIndex: 0 }

  let distance: number | null = null
  try {
    // maxThreshold lets the search prune whole subtrees once it knows nothing
    // closer than the window can be found. Everything beyond the window is
    // reported as a bound anyway, so the extra precision would be discarded.
    const hit = a.bvh.closestPointToGeometry(
      b.geometry,
      aToB,
      pointA,
      pointB,
      0,
      settings.exactQueryWindowMm,
    )
    distance = typeof hit === 'number' ? hit : hit ? pointA.distance : null
  } catch (error) {
    return UNKNOWN(error instanceof Error ? error.message : 'Clearance query failed')
  }

  if (distance === null || !Number.isFinite(distance)) {
    // Nothing within the window: the surfaces are further apart than the box
    // test suggested, which is a bound rather than a failure.
    return {
      state: 'safe',
      clearanceMm: null,
      lowerBoundMm: settings.exactQueryWindowMm,
      pointA: null,
      pointB: null,
    }
  }

  // Closest points come back in each mesh's own local space.
  const worldA = pointA.point.clone().applyMatrix4(a.matrixWorld)
  const worldB = pointB.point.clone().applyMatrix4(b.matrixWorld)

  return {
    state: distance <= settings.warnClearanceMm ? 'near' : 'safe',
    clearanceMm: distance,
    pointA: worldA,
    pointB: worldB,
  }
}

/** Shortest distance between two axis-aligned boxes; 0 when they overlap. */
export function boxDistance(a: Box3, b: Box3): number {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x))
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y))
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z))
  return Math.hypot(dx, dy, dz)
}

export interface PairReport extends PairResult {
  readonly aId: string
  readonly bId: string
  readonly aLabel: string
  readonly bLabel: string
  readonly involvesAnatomy: boolean
}

export interface SceneCollisionReport {
  readonly pairs: readonly PairReport[]
  /** Worst state present anywhere in the scene. */
  readonly worst: CollisionState
  /** Smallest positive clearance found, in millimetres. */
  readonly minClearanceMm: number | null
  /** The pair responsible for `minClearanceMm`, when there is one. */
  readonly limiting: PairReport | null
  readonly checkedPairs: number
  readonly elapsedMs: number
}

const SEVERITY: Record<CollisionState, number> = {
  safe: 0,
  near: 1,
  unknown: 2,
  collision: 3,
}

/** Combine two states, keeping the more serious one. */
export function worseOf(a: CollisionState, b: CollisionState): CollisionState {
  return SEVERITY[a] >= SEVERITY[b] ? a : b
}

/**
 * Check every meaningful pair in the scene.
 *
 * Anatomy-to-anatomy pairs are skipped: two atlas structures overlapping says
 * something about the atlas, not about the surgical plan, and reporting it
 * would bury the results that matter in noise.
 */
export function checkScene(
  meshes: readonly CollisionMesh[],
  settings: CollisionSettings = DEFAULT_COLLISION_SETTINGS,
): SceneCollisionReport {
  const started = Date.now()
  const pairs: PairReport[] = []

  for (let i = 0; i < meshes.length; i++) {
    for (let j = i + 1; j < meshes.length; j++) {
      const a = meshes[i]!
      const b = meshes[j]!
      if (a.kind === 'anatomy' && b.kind === 'anatomy') continue
      // One side opting out of anatomy checks removes the pair entirely.
      if (a.kind === 'anatomy' && b.ignoreAnatomy) continue
      if (b.kind === 'anatomy' && a.ignoreAnatomy) continue

      const result = checkPair(a, b, settings)
      pairs.push({
        ...result,
        aId: a.id,
        bId: b.id,
        aLabel: a.label,
        bLabel: b.label,
        involvesAnatomy: a.kind === 'anatomy' || b.kind === 'anatomy',
      })
    }
  }

  let worst: CollisionState = 'safe'
  let minClearanceMm: number | null = null
  let limiting: PairReport | null = null

  for (const pair of pairs) {
    worst = worseOf(worst, pair.state)
    if (pair.clearanceMm !== null) {
      if (minClearanceMm === null || pair.clearanceMm < minClearanceMm) {
        minClearanceMm = pair.clearanceMm
        limiting = pair
      }
    }
  }

  return {
    pairs,
    worst,
    minClearanceMm,
    limiting,
    checkedPairs: pairs.length,
    elapsedMs: Date.now() - started,
  }
}

/** The state affecting one particular object, for colouring it in the scene. */
export function stateForObject(
  report: SceneCollisionReport,
  objectId: string,
): CollisionState {
  let state: CollisionState = 'safe'
  for (const pair of report.pairs) {
    if (pair.aId !== objectId && pair.bId !== objectId) continue
    state = worseOf(state, pair.state)
  }
  return state
}

/** Display colours for each state, per the blueprint's table. */
export const STATE_COLOR: Record<CollisionState, string> = {
  safe: '#52b788',
  near: '#e0a84a',
  collision: '#e2574c',
  unknown: '#8b97a6',
}

export const STATE_LABEL: Record<CollisionState, string> = {
  safe: 'Clear',
  near: 'Near',
  collision: 'Collision',
  unknown: 'Unknown',
}

/**
 * Format a clearance for display.
 *
 * Rounded to 10 µm and never finer. The underlying meshes are decimated
 * reconstructions of an averaged brain, so more digits would assert a
 * precision the geometry does not carry.
 */
export function formatClearance(mm: number | null): string {
  if (mm === null) return '—'
  if (mm < 0.01) return '< 0.01 mm'
  return `${mm.toFixed(2)} mm`
}

/** Format a pair's separation, distinguishing a measurement from a bound. */
export function formatSeparation(result: PairResult): string {
  if (result.clearanceMm !== null) return formatClearance(result.clearanceMm)
  if (result.lowerBoundMm !== undefined) return `> ${result.lowerBoundMm.toFixed(1)} mm`
  return '—'
}
