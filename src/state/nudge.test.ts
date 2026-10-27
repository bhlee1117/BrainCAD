/**
 * Target-nudge tests.
 *
 * The arithmetic is a sign on one axis and could hardly be wrong, so what
 * these pin is the *mapping*: that W is away from you and S is toward you,
 * that A and D are the animal's left and right rather than the reader's, and
 * that E and Q take the axis WASD cannot reach. Those are conventions, not
 * derivations, and a convention that drifts is noticed only after someone has
 * planned on it.
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

  it('reads A and D as the left and right of the animal', () => {
    // +ML is the animal's right everywhere in BrainCAD, so these are a plain
    // sign and do not reverse when the target crosses the midline.
    expect(nudgeCoord({ ...AT, ml: 1.5 }, 'right', 0.1).ml).toBeCloseTo(1.6, 10)
    expect(nudgeCoord({ ...AT, ml: 1.5 }, 'left', 0.1).ml).toBeCloseTo(1.4, 10)
  })

  it('keeps that meaning in the left hemisphere', () => {
    expect(nudgeCoord({ ...AT, ml: -1.5 }, 'right', 0.1).ml).toBeCloseTo(-1.4, 10)
    expect(nudgeCoord({ ...AT, ml: -1.5 }, 'left', 0.1).ml).toBeCloseTo(-1.6, 10)
  })

  it('crosses the midline rather than stopping at it', () => {
    // An earlier version measured from the midline and parked there. A key
    // that stops halfway across the brain reads as broken.
    expect(nudgeCoord({ ...AT, ml: 0.05 }, 'left', 0.1).ml).toBeCloseTo(-0.05, 10)
  })

  it.each([
    'left',
    'right',
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
      ['right', 'left'],
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
  it('lays WASD out the way the hand expects', () => {
    // W away, S toward, A left, D right. If these drift the keys stop being
    // guessable, which is the only reason to have chosen WASD at all.
    expect(NUDGE_KEYS.KeyW).toBe('anterior')
    expect(NUDGE_KEYS.KeyS).toBe('posterior')
    expect(NUDGE_KEYS.KeyA).toBe('left')
    expect(NUDGE_KEYS.KeyD).toBe('right')
  })

  it('gives Q and E the axis WASD cannot reach', () => {
    // E up, Q down, as a 3D editor's fly mode does it.
    expect(NUDGE_KEYS.KeyE).toBe('dorsal')
    expect(NUDGE_KEYS.KeyQ).toBe('ventral')
  })

  it('binds by physical key, not by printed letter', () => {
    // `code`, so the layout survives AZERTY and Dvorak: KeyW is the key above
    // KeyS whatever is written on it.
    for (const code of Object.keys(NUDGE_KEYS)) {
      expect(code.startsWith('Key')).toBe(true)
    }
  })

  it('leaves keys with other jobs alone', () => {
    for (const code of ['KeyZ', 'KeyR', 'KeyX', 'Digit4', 'Numpad4', 'Space']) {
      expect(NUDGE_KEYS[code]).toBeUndefined()
    }
  })

  it('shows every bound direction in the legend', () => {
    const bound = new Set(Object.values(NUDGE_KEYS))
    expect(new Set(NUDGE_LEGEND.map((e) => e.direction))).toEqual(bound)
  })

  it('labels the legend with the key that is actually bound', () => {
    for (const entry of NUDGE_LEGEND) {
      expect(NUDGE_KEYS[`Key${entry.key}`]).toBe(entry.direction)
    }
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
