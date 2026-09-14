/**
 * Collision tests.
 *
 * Built on boxes and spheres at known separations, so every expected clearance
 * is a number that can be worked out by hand rather than recorded from a
 * previous run. The blueprint's warning applies to the tests too: a
 * collision-free result is only as trustworthy as the geometry behind it, so
 * these check the geometry cases explicitly — overlapping, touching, near, and
 * far apart.
 */

import { Box3, BoxGeometry, Matrix4, SphereGeometry, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COLLISION_SETTINGS,
  boxDistance,
  buildBvh,
  checkPair,
  checkScene,
  formatClearance,
  stateForObject,
  worseOf,
  type CollisionMesh,
} from './check.ts'

/** Build a collision mesh from geometry at a world position. */
function meshAt(
  id: string,
  geometry: ReturnType<typeof makeBox>,
  position: [number, number, number],
  kind: 'anatomy' | 'hardware' = 'hardware',
): CollisionMesh {
  geometry.computeBoundingBox()
  const bvh = buildBvh(geometry)
  if (!bvh) throw new Error('failed to build BVH for test geometry')
  return {
    id,
    label: id,
    geometry,
    bvh,
    matrixWorld: new Matrix4().makeTranslation(...position),
    kind,
  }
}

function makeBox(size = 1) {
  return new BoxGeometry(size, size, size)
}

describe('boxDistance', () => {
  it('is zero for overlapping boxes', () => {
    const a = new Box3(new Vector3(0, 0, 0), new Vector3(2, 2, 2))
    const b = new Box3(new Vector3(1, 1, 1), new Vector3(3, 3, 3))
    expect(boxDistance(a, b)).toBe(0)
  })

  it('measures a gap along one axis', () => {
    const a = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1))
    const b = new Box3(new Vector3(3, 0, 0), new Vector3(4, 1, 1))
    expect(boxDistance(a, b)).toBeCloseTo(2, 9)
  })

  it('measures a diagonal gap', () => {
    const a = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1))
    const b = new Box3(new Vector3(4, 4, 1), new Vector3(5, 5, 2))
    expect(boxDistance(a, b)).toBeCloseTo(Math.hypot(3, 3, 0), 9)
  })
})

describe('checkPair', () => {
  it('reports a collision when two boxes overlap', () => {
    const a = meshAt('a', makeBox(2), [0, 0, 0])
    const b = meshAt('b', makeBox(2), [1, 0, 0])
    const result = checkPair(a, b)

    expect(result.state).toBe('collision')
    // There is no positive separation to report when surfaces interpenetrate.
    expect(result.clearanceMm).toBeNull()
  })

  it('reports the exact clearance between separated boxes', () => {
    // Unit cubes centred 5 mm apart have faces 4 mm apart.
    const a = meshAt('a', makeBox(1), [0, 0, 0])
    const b = meshAt('b', makeBox(1), [5, 0, 0])
    const result = checkPair(a, b)

    expect(result.state).toBe('safe')
    expect(result.clearanceMm).toBeCloseTo(4, 4)
  })

  it('flags a pair as near when the gap is under the threshold', () => {
    // Faces 0.1 mm apart, threshold 0.25 mm.
    const a = meshAt('a', makeBox(1), [0, 0, 0])
    const b = meshAt('b', makeBox(1), [1.1, 0, 0])
    const result = checkPair(a, b)

    expect(result.state).toBe('near')
    expect(result.clearanceMm).toBeCloseTo(0.1, 4)
  })

  it('honours a custom warning threshold', () => {
    const a = meshAt('a', makeBox(1), [0, 0, 0])
    const b = meshAt('b', makeBox(1), [2, 0, 0])

    // 1 mm gap: safe by default, near when the surgeon wants 2 mm of room.
    expect(checkPair(a, b).state).toBe('safe')
    expect(
      checkPair(a, b, { ...DEFAULT_COLLISION_SETTINGS, warnClearanceMm: 2 }).state,
    ).toBe('near')
  })

  it('returns world-space closest points on both surfaces', () => {
    const a = meshAt('a', makeBox(1), [0, 0, 0])
    const b = meshAt('b', makeBox(1), [5, 0, 0])
    const result = checkPair(a, b)

    expect(result.pointA).not.toBeNull()
    expect(result.pointB).not.toBeNull()
    // Facing surfaces sit at x = +0.5 and x = 4.5.
    expect(result.pointA!.x).toBeCloseTo(0.5, 4)
    expect(result.pointB!.x).toBeCloseTo(4.5, 4)
    expect(result.pointA!.distanceTo(result.pointB!)).toBeCloseTo(4, 4)
  })

  it('measures clearance between curved surfaces', () => {
    // Two unit-radius spheres 5 mm apart: surfaces 3 mm apart. Tessellation
    // makes the facets sit slightly inside the true sphere, so allow for that.
    const a = meshAt('a', new SphereGeometry(1, 32, 32) as never, [0, 0, 0])
    const b = meshAt('b', new SphereGeometry(1, 32, 32) as never, [5, 0, 0])
    const result = checkPair(a, b)

    expect(result.state).toBe('safe')
    expect(result.clearanceMm).toBeGreaterThan(2.95)
    expect(result.clearanceMm).toBeLessThan(3.05)
  })

  it('detects collision regardless of which mesh is asked first', () => {
    const a = meshAt('a', makeBox(2), [0, 0, 0])
    const b = meshAt('b', makeBox(2), [1.5, 0, 0])
    expect(checkPair(a, b).state).toBe(checkPair(b, a).state)
  })

  it('agrees on clearance regardless of argument order', () => {
    const a = meshAt('a', makeBox(1), [0, 0, 0])
    const b = meshAt('b', makeBox(1), [3, 0, 0])
    expect(checkPair(a, b).clearanceMm).toBeCloseTo(checkPair(b, a).clearanceMm!, 4)
  })
})

describe('buildBvh', () => {
  it('refuses geometry with no usable triangles', () => {
    const empty = new BoxGeometry(1, 1, 1)
    empty.deleteAttribute('position')
    expect(buildBvh(empty)).toBeNull()
  })

  it('attaches the tree to the geometry for the other side of a query', () => {
    // three-mesh-bvh only accelerates the second operand if it can find a
    // boundsTree on it. Without this the query brute-forces those triangles.
    const geometry = new BoxGeometry(1, 1, 1)
    const bvh = buildBvh(geometry)
    expect((geometry as { boundsTree?: unknown }).boundsTree).toBe(bvh)
  })
})

describe('query cost', () => {
  it('stays interactive against a brain-sized mesh', () => {
    // Guards the two things that made this 14x faster: attaching boundsTree to
    // both operands, and passing maxThreshold so the search can prune. The
    // budget is deliberately loose — it is meant to catch an order-of-magnitude
    // regression on a slow CI runner, not to benchmark.
    const brainish = new SphereGeometry(6, 160, 160) // ~50k triangles
    const probe = new BoxGeometry(0.5, 8, 0.5)

    const a = meshAt('brain', brainish as never, [0, 0, 0], 'anatomy')
    const b = meshAt('probe', probe as never, [9, 0, 0])

    const started = Date.now()
    const result = checkPair(a, b)
    const elapsed = Date.now() - started

    expect(result.state).toBe('safe')
    expect(elapsed).toBeLessThan(500)
  })
})

describe('checkScene', () => {
  it('reports every hardware pair', () => {
    const report = checkScene([
      meshAt('a', makeBox(1), [0, 0, 0]),
      meshAt('b', makeBox(1), [5, 0, 0]),
      meshAt('c', makeBox(1), [10, 0, 0]),
    ])
    expect(report.checkedPairs).toBe(3)
    expect(report.worst).toBe('safe')
  })

  it('skips anatomy-to-anatomy pairs', () => {
    // Two overlapping atlas structures say something about the atlas, not the
    // surgical plan, and would otherwise drown out the real results.
    const report = checkScene([
      meshAt('brain', makeBox(4), [0, 0, 0], 'anatomy'),
      meshAt('region', makeBox(2), [0, 0, 0], 'anatomy'),
      meshAt('probe', makeBox(1), [20, 0, 0]),
    ])
    expect(report.checkedPairs).toBe(2)
    expect(report.pairs.every((p) => !(p.aId === 'brain' && p.bId === 'region'))).toBe(true)
    expect(report.worst).toBe('safe')
  })

  it('surfaces the worst state in the scene', () => {
    const report = checkScene([
      meshAt('a', makeBox(1), [0, 0, 0]),
      meshAt('b', makeBox(1), [0.5, 0, 0]), // overlapping
      meshAt('c', makeBox(1), [40, 0, 0]), // far away
    ])
    expect(report.worst).toBe('collision')
  })

  it('identifies the limiting pair by minimum clearance', () => {
    const report = checkScene([
      meshAt('probe', makeBox(1), [0, 0, 0]),
      meshAt('near', makeBox(1), [2, 0, 0]), // 1 mm gap
      meshAt('far', makeBox(1), [20, 0, 0]), // 18 mm gap
    ])
    expect(report.minClearanceMm).toBeCloseTo(1, 3)
    expect(report.limiting).not.toBeNull()
    const ids = [report.limiting!.aId, report.limiting!.bId]
    expect(ids).toContain('probe')
    expect(ids).toContain('near')
  })

  it('marks pairs that involve anatomy', () => {
    const report = checkScene([
      meshAt('brain', makeBox(4), [0, 0, 0], 'anatomy'),
      meshAt('probe', makeBox(1), [1, 0, 0]),
    ])
    expect(report.pairs[0]!.involvesAnatomy).toBe(true)
  })

  it('is empty and safe for a scene with nothing in it', () => {
    const report = checkScene([])
    expect(report.checkedPairs).toBe(0)
    expect(report.worst).toBe('safe')
    expect(report.minClearanceMm).toBeNull()
  })
})

describe('stateForObject', () => {
  it('reports the worst state affecting that object only', () => {
    const report = checkScene([
      meshAt('probe', makeBox(1), [0, 0, 0]),
      meshAt('hit', makeBox(1), [0.5, 0, 0]),
      meshAt('bystander', makeBox(1), [60, 0, 0]),
    ])
    expect(stateForObject(report, 'probe')).toBe('collision')
    expect(stateForObject(report, 'bystander')).toBe('safe')
  })

  it('is safe for an object that appears in no pair', () => {
    const report = checkScene([meshAt('only', makeBox(1), [0, 0, 0])])
    expect(stateForObject(report, 'absent')).toBe('safe')
  })
})

describe('severity ordering', () => {
  it('ranks collision above unknown above near above safe', () => {
    expect(worseOf('safe', 'near')).toBe('near')
    expect(worseOf('near', 'unknown')).toBe('unknown')
    expect(worseOf('unknown', 'collision')).toBe('collision')
    expect(worseOf('collision', 'safe')).toBe('collision')
  })

  it('never lets an unknown result read as safe', () => {
    // The blueprint is explicit: an uncomputable result is not evidence of
    // clearance.
    expect(worseOf('safe', 'unknown')).toBe('unknown')
  })
})

describe('formatClearance', () => {
  it('shows two decimals and no more', () => {
    expect(formatClearance(1.4249)).toBe('1.42 mm')
    expect(formatClearance(0.2)).toBe('0.20 mm')
  })

  it('does not pretend to sub-10-micrometre precision', () => {
    expect(formatClearance(0.0004)).toBe('< 0.01 mm')
  })

  it('shows a dash when there is no clearance to report', () => {
    expect(formatClearance(null)).toBe('—')
  })
})
