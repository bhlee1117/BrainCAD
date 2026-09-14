import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  AXIS_LABEL,
  DEFAULT_SECTION,
  SECTION_AXES,
  describeSection,
  isSectioning,
  sectionPlanes,
  type SectionAxis,
  type SectionSide,
  type SectionState,
} from './section.ts'

function withPlane(
  axis: SectionAxis,
  positionMm: number,
  remove: SectionSide,
): SectionState {
  return {
    ...DEFAULT_SECTION,
    [axis]: { enabled: true, positionMm, remove },
  }
}

/** Whether a world point survives the section. */
function kept(state: SectionState, point: Vector3): boolean {
  return sectionPlanes(state).every((plane) => plane.distanceToPoint(point) >= 0)
}

describe('sectionPlanes', () => {
  it('cuts nothing by default', () => {
    expect(sectionPlanes(DEFAULT_SECTION)).toHaveLength(0)
    expect(isSectioning(DEFAULT_SECTION)).toBe(false)
    expect(describeSection(DEFAULT_SECTION)).toBeNull()
  })

  /**
   * The sign convention is the one thing here that can be silently wrong, and
   * it would be wrong in the most convincing possible way: the render still
   * looks like a clean section, just of the half the user wanted to keep. So
   * every axis is checked in both directions against a point on each side.
   */
  it.each(SECTION_AXES)('removes the requested side of %s', (axis) => {
    const positive = new Vector3()
    const negative = new Vector3()
    const component = axis === 'ml' ? 'x' : axis === 'dv' ? 'y' : 'z'
    positive[component] = 5
    negative[component] = -5

    const cutPositive = withPlane(axis, 0, 'positive')
    expect(kept(cutPositive, positive)).toBe(false)
    expect(kept(cutPositive, negative)).toBe(true)

    const cutNegative = withPlane(axis, 0, 'negative')
    expect(kept(cutNegative, positive)).toBe(true)
    expect(kept(cutNegative, negative)).toBe(false)
  })

  it.each(SECTION_AXES)('honours the plane position on %s', (axis) => {
    const component = axis === 'ml' ? 'x' : axis === 'dv' ? 'y' : 'z'
    const state = withPlane(axis, 2, 'positive')

    const inside = new Vector3()
    inside[component] = 1.9
    const outside = new Vector3()
    outside[component] = 2.1

    expect(kept(state, inside)).toBe(true)
    expect(kept(state, outside)).toBe(false)
  })

  it('cuts an eighth away when all three are enabled', () => {
    const state: SectionState = {
      ml: { enabled: true, positionMm: 0, remove: 'positive' },
      dv: { enabled: true, positionMm: 0, remove: 'positive' },
      ap: { enabled: true, positionMm: 0, remove: 'positive' },
    }
    expect(sectionPlanes(state)).toHaveLength(3)
    // Planes intersect, so a point survives only if it is on the kept side of
    // every one of them.
    expect(kept(state, new Vector3(-1, -1, -1))).toBe(true)
    expect(kept(state, new Vector3(-1, -1, 1))).toBe(false)
    expect(kept(state, new Vector3(1, 1, 1))).toBe(false)
  })
})

describe('describeSection', () => {
  it('names the side in anatomical terms', () => {
    // The description is what ends up labelling a capture, so it has to say
    // which half of the animal is missing, not which sign was negated.
    expect(describeSection(withPlane('dv', -1.5, 'positive'))).toBe(
      'DV -1.50 mm, dorsal removed',
    )
    expect(describeSection(withPlane('ap', 0, 'negative'))).toBe(
      'AP 0.00 mm, posterior removed',
    )
  })

  it('lists every active cut', () => {
    const state: SectionState = {
      ...withPlane('ml', 1, 'positive'),
      ap: { enabled: true, positionMm: -2, remove: 'negative' },
    }
    const described = describeSection(state)
    expect(described).toContain('ML 1.00 mm, right removed')
    expect(described).toContain('AP -2.00 mm, posterior removed')
  })

  it.each(SECTION_AXES)('labels both sides of %s', (axis) => {
    const label = AXIS_LABEL[axis]
    expect(label.positive).toBeTruthy()
    expect(label.negative).toBeTruthy()
    expect(label.positive).not.toBe(label.negative)
  })
})
