/**
 * Measurement tests.
 *
 * The distances themselves are simple; what needs pinning down is the snapping
 * priority and the insistence that a measurement always says what kind of
 * distance it is.
 */

import { describe, expect, it } from 'vitest'

import {
  DISTANCE_LABEL,
  SNAP_LABEL,
  describeMeasurement,
  formatDistance,
  measurementComponents,
  measurementDistanceMm,
  measurementMidpoint,
  resolveSnap,
  type Measurement,
  type SnapCandidate,
} from './measure.ts'

function measurement(
  a: { ap: number; ml: number; dv: number },
  b: { ap: number; ml: number; dv: number },
): Measurement {
  return {
    id: 'm1',
    name: 'Measurement 1',
    a: { coord: a, snap: 'free', snappedTo: null },
    b: { coord: b, snap: 'free', snappedTo: null },
    kind: 'euclidean',
    visible: true,
  }
}

describe('distance', () => {
  it('computes a straight-line distance', () => {
    const m = measurement({ ap: 0, ml: 0, dv: 0 }, { ap: 0, ml: 3, dv: -4 })
    expect(measurementDistanceMm(m)).toBeCloseTo(5, 9)
  })

  it('is zero for coincident points', () => {
    const m = measurement({ ap: 1, ml: 2, dv: -3 }, { ap: 1, ml: 2, dv: -3 })
    expect(measurementDistanceMm(m)).toBe(0)
  })

  it('reports per-axis components as b minus a', () => {
    const m = measurement({ ap: -1, ml: 0.5, dv: -2 }, { ap: 1, ml: -0.5, dv: -3 })
    expect(measurementComponents(m)).toEqual({ ap: 2, ml: -1, dv: -1 })
  })

  it('formats in both millimetres and micrometres', () => {
    // Cortical layers and injection spreads are discussed in µm; stereotaxic
    // coordinates in mm. Showing both removes a conversion step.
    const formatted = formatDistance(1.2345)
    expect(formatted.mm).toBe('1.234 mm')
    expect(formatted.um).toBe('1235 µm')
  })

  it('rounds micrometres rather than truncating', () => {
    expect(formatDistance(0.0006).um).toBe('1 µm')
  })
})

describe('midpoint', () => {
  it('sits halfway between the endpoints in world space', () => {
    const m = measurement({ ap: 0, ml: 0, dv: 0 }, { ap: 2, ml: 4, dv: -6 })
    const mid = measurementMidpoint(m)
    // World space is (ML, DV, AP).
    expect(mid.x).toBeCloseTo(2, 9)
    expect(mid.y).toBeCloseTo(-3, 9)
    expect(mid.z).toBeCloseTo(1, 9)
  })
})

describe('snapping', () => {
  const candidates: SnapCandidate[] = [
    { coord: { ap: 0, ml: 0, dv: 0 }, kind: 'target', label: 'Target 1' },
    { coord: { ap: 0.4, ml: 0, dv: 0 }, kind: 'object-anchor', label: 'Pipette tip' },
  ]

  it('snaps to the nearest candidate within the radius', () => {
    const point = resolveSnap({ ap: 0.35, ml: 0, dv: 0 }, candidates, 0.25)
    expect(point.snap).toBe('object-anchor')
    expect(point.snappedTo).toBe('Pipette tip')
    expect(point.coord.ap).toBeCloseTo(0.4, 9)
  })

  it('returns a free point when nothing is close enough', () => {
    const point = resolveSnap({ ap: 5, ml: 5, dv: 5 }, candidates, 0.25)
    expect(point.snap).toBe('free')
    expect(point.snappedTo).toBeNull()
    expect(point.coord).toEqual({ ap: 5, ml: 5, dv: 5 })
  })

  it('takes the coordinate of the snap target, not the click', () => {
    // The whole point of snapping: the measurement must be reproducible, so it
    // records the feature's exact position rather than wherever the cursor was.
    const point = resolveSnap({ ap: 0.05, ml: 0.02, dv: -0.01 }, candidates, 0.25)
    expect(point.coord).toEqual({ ap: 0, ml: 0, dv: 0 })
  })

  it('picks the closer of two candidates in range', () => {
    const point = resolveSnap({ ap: 0.21, ml: 0, dv: 0 }, candidates, 1.0)
    expect(point.snappedTo).toBe('Pipette tip')
  })

  it('handles an empty candidate list', () => {
    const point = resolveSnap({ ap: 1, ml: 1, dv: 1 }, [], 0.5)
    expect(point.snap).toBe('free')
  })
})

describe('distance kinds are never implicit', () => {
  it('labels every kind distinctly', () => {
    const labels = Object.values(DISTANCE_LABEL)
    expect(new Set(labels).size).toBe(labels.length)
    expect(DISTANCE_LABEL.euclidean).not.toBe(DISTANCE_LABEL['along-trajectory'])
  })

  it('labels every snap kind', () => {
    for (const label of Object.values(SNAP_LABEL)) {
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('states the distance kind in the summary', () => {
    const m = measurement({ ap: 0, ml: 0, dv: 0 }, { ap: 0, ml: 3, dv: -4 })
    expect(describeMeasurement(m)).toContain('straight line')
    expect(describeMeasurement(m)).toContain('5.000 mm')
  })

  it('names snapped endpoints in the summary', () => {
    const m: Measurement = {
      ...measurement({ ap: 0, ml: 0, dv: 0 }, { ap: 0, ml: 3, dv: -4 }),
      a: { coord: { ap: 0, ml: 0, dv: 0 }, snap: 'target', snappedTo: 'CA1 target' },
      b: { coord: { ap: 0, ml: 3, dv: -4 }, snap: 'object-anchor', snappedTo: 'Pipette tip' },
    }
    expect(describeMeasurement(m)).toBe(
      'CA1 target → Pipette tip: 5.000 mm (straight line)',
    )
  })
})
