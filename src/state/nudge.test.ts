/**
 * Target-nudge tests.
 *
 * Five of the six directions are a sign on one axis and could hardly be wrong.
 * Medial and lateral are the ones worth testing: they are defined against the
 * midline rather than against the sign of ML, so they reverse their arithmetic
 * between hemispheres — and a mapping that quietly did `ml + step` for
 * "lateral" would behave correctly on the right of the brain and back to front
 * on the left, which is the kind of error a user discovers after building a
 * plan on it.
 */

import { describe, expect, it } from 'vitest'

import {
  COARSE_FACTOR,
  DEFAULT_STEP_MM,
  NUDGE_KEYS,
  NUDGE_LEGEND,
  describeNudge,
  nudgeCoord,
  type NudgeDirection,
} from './nudge.ts'

const AT = { ap: -2, ml: 1.5, dv: -1.35 }

describe('nudgeCoord', () => {
  it('moves anterior and posterior along AP only', () => {
    expect(nudgeCoord(AT, 'anterior', 0.1)).toEqual({ ...AT, ap: -1.9 })
    expect(nudgeCoord(AT, 'posterior', 0.1)).toEqual({ ...AT, ap: -2.1 })
  })

  it('moves dorsal and ventral along DV only', () => {
    // +DV is dorsal, so a target inside the brain climbs toward zero.
    expect(nudgeCoord(AT, 'dorsal', 0.1).dv).toBeCloseTo(-1.25, 10)
    expect(nudgeCoord(AT, 'ventral', 0.1).dv).toBeCloseTo(-1.45, 10)
  })

  it('reads lateral as away from the midline in the right hemisphere', () => {
    expect(nudgeCoord({ ...AT, ml: 1.5 }, 'lateral', 0.1).ml).toBeCloseTo(1.6, 10)
    expect(nudgeCoord({ ...AT, ml: 1.5 }, 'medial', 0.1).ml).toBeCloseTo(1.4, 10)
  })

  it('reads lateral as away from the midline in the left hemisphere too', () => {
    // The whole point of the pair: at ML −1.5, "lateral" is more negative.
    expect(nudgeCoord({ ...AT, ml: -1.5 }, 'lateral', 0.1).ml).toBeCloseTo(-1.6, 10)
    expect(nudgeCoord({ ...AT, ml: -1.5 }, 'medial', 0.1).ml).toBeCloseTo(-1.4, 10)
  })

  it('stops medial travel at the midline instead of crossing it', () => {
    // Holding "medial" should park the target on the midline, not walk it out
    // through the opposite hemisphere.
    expect(nudgeCoord({ ...AT, ml: 0.05 }, 'medial', 0.1).ml).toBe(0)
    expect(nudgeCoord({ ...AT, ml: -0.05 }, 'medial', 0.1).ml).toBe(0)
  })

  it('picks a side for lateral when the target sits on the midline', () => {
    // There is no "away from the midline" at the midline, so the key moves to
    // the animal's right rather than reading as a dead key.
    expect(nudgeCoord({ ...AT, ml: 0 }, 'lateral', 0.1).ml).toBeCloseTo(0.1, 10)
  })

  it.each([
    'medial',
    'lateral',
    'anterior',
    'posterior',
    'dorsal',
    'ventral',
  ] as NudgeDirection[])('leaves the other two axes untouched for %s', (direction) => {
    const moved = nudgeCoord(AT, direction, 0.25)
    const changed = (['ap', 'ml', 'dv'] as const).filter((k) => moved[k] !== AT[k])
    expect(changed).toHaveLength(1)
  })

  it('is reversible by its opposite', () => {
    const pairs: [NudgeDirection, NudgeDirection][] = [
      ['anterior', 'posterior'],
      ['dorsal', 'ventral'],
      ['lateral', 'medial'],
    ]
    for (const [there, back] of pairs) {
      const moved = nudgeCoord(AT, there, 0.2)
      const returned = nudgeCoord(moved, back, 0.2)
      expect(returned.ap).toBeCloseTo(AT.ap, 10)
      expect(returned.ml).toBeCloseTo(AT.ml, 10)
      expect(returned.dv).toBeCloseTo(AT.dv, 10)
    }
  })
})

describe('key mapping', () => {
  it('binds the pad and the top row to the same directions', () => {
    // `code` is the physical key, so the pad works with Num Lock off — but a
    // laptop without a pad has to be able to drive this too.
    for (const digit of ['1', '2', '4', '6', '8', '9']) {
      expect(NUDGE_KEYS[`Numpad${digit}`]).toBe(NUDGE_KEYS[`Digit${digit}`])
      expect(NUDGE_KEYS[`Numpad${digit}`]).toBeDefined()
    }
  })

  it('maps the pad geometrically', () => {
    // Up is dorsal, down is ventral, left is medial, right is lateral. The
    // layout is the legend; if these drift the keys stop being guessable.
    expect(NUDGE_KEYS.Numpad8).toBe('dorsal')
    expect(NUDGE_KEYS.Numpad2).toBe('ventral')
    expect(NUDGE_KEYS.Numpad4).toBe('medial')
    expect(NUDGE_KEYS.Numpad6).toBe('lateral')
    expect(NUDGE_KEYS.Numpad1).toBe('anterior')
    expect(NUDGE_KEYS.Numpad9).toBe('posterior')
  })

  it('leaves keys with other jobs alone', () => {
    for (const code of ['Numpad5', 'Numpad0', 'Numpad3', 'Numpad7', 'KeyZ', 'Digit5']) {
      expect(NUDGE_KEYS[code]).toBeUndefined()
    }
  })

  it('shows every bound direction in the legend', () => {
    const bound = new Set(Object.values(NUDGE_KEYS))
    expect(new Set(NUDGE_LEGEND.map((e) => e.direction))).toEqual(bound)
  })
})

describe('step sizes', () => {
  it('defaults to a tenth of a millimetre', () => {
    expect(DEFAULT_STEP_MM).toBe(0.1)
  })

  it('crosses a millimetre in one coarse step', () => {
    // Shift exists so a long traverse does not take ten presses.
    expect(DEFAULT_STEP_MM * COARSE_FACTOR).toBeGreaterThanOrEqual(1)
  })

  it('describes a nudge in the units the panel shows', () => {
    expect(describeNudge('dorsal', 0.1)).toBe('dorsal 0.10 mm')
  })
})
