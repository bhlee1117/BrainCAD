/**
 * Numeric-field editing tests.
 *
 * These are written around the states a user passes *through* while typing,
 * because that is where the reported bug lived: every one of these drafts is
 * not a number, and rejecting them is what made the field impossible to clear.
 */

import { describe, expect, it } from 'vitest'

import { applyLimits, editNumberField, formatNumberField } from './numberField.ts'

describe('the reported bug', () => {
  it('lets "-2" be backspaced away', () => {
    // "-2" → "-" → "". Neither intermediate is a number, and the old code
    // rejected both, re-rendered "-2" and left the caret stranded.
    const minus = editNumberField('-')
    expect(minus.draft).toBe('-')
    expect(minus.commit).toBeNull()

    const empty = editNumberField('')
    expect(empty.draft).toBe('')
    expect(empty.commit).toBeNull()
  })

  it('keeps an empty field empty instead of reading it as zero', () => {
    // Committing 0 for "" would silently move the object the moment the user
    // selected the text to retype it.
    expect(editNumberField('').commit).toBeNull()
  })
})

describe('typing a number', () => {
  it.each([
    ['0', 0],
    ['-2', -2],
    ['2.5', 2.5],
    ['-0.05', -0.05],
    ['.5', 0.5],
    ['+3', 3],
    ['1e2', 100],
  ])('commits %s as %s', (text, expected) => {
    expect(editNumberField(text).commit).toBe(expected)
  })

  it('carries a half-typed decimal without committing a different number', () => {
    // "1." parses as 1 under parseFloat, but echoing "1" back deletes the dot
    // the user just typed and they can never reach "1.5".
    const edit = editNumberField('1.')
    expect(edit.draft).toBe('1.')
    expect(edit.commit).toBe(1)
  })

  it('preserves a trailing zero being typed toward 0.05', () => {
    expect(editNumberField('0.0').draft).toBe('0.0')
  })

  it('refuses input with trailing garbage rather than taking its prefix', () => {
    // parseFloat("1.2.3") is 1.2, which is not what anyone typed.
    for (const text of ['1.2.3', '5px', '--1', 'abc', '1,5']) {
      expect(editNumberField(text).commit, text).toBeNull()
      expect(editNumberField(text).draft, text).toBe(text)
    }
  })
})

describe('limits', () => {
  it('clamps to a minimum', () => {
    expect(editNumberField('-5', { min: 0 }).commit).toBe(0)
  })

  it('clamps to a maximum', () => {
    expect(editNumberField('7', { max: 1 }).commit).toBe(1)
  })

  it('rounds when the field is integral', () => {
    expect(editNumberField('3.7', { integer: true }).commit).toBe(4)
  })

  it('does not clamp a draft that is still being typed', () => {
    // With min 1, clearing the box to retype must not snap the draft to "1"
    // mid-keystroke; the commit is what limits apply to.
    expect(editNumberField('', { min: 1 }).draft).toBe('')
  })

  it('leaves an unlimited value alone', () => {
    expect(applyLimits(-12.5)).toBe(-12.5)
  })
})

describe('display formatting', () => {
  it('hides floating-point noise from a rotation', () => {
    // A tilt stored as 2.0000000000000004 must read as "2", not as a number
    // nobody typed.
    expect(formatNumberField(2.0000000000000004)).toBe('2')
  })

  it('keeps genuine precision', () => {
    expect(formatNumberField(-1.35)).toBe('-1.35')
    expect(formatNumberField(0.0625)).toBe('0.0625')
  })

  it('falls back to zero for a non-finite value', () => {
    expect(formatNumberField(Number.NaN)).toBe('0')
    expect(formatNumberField(Number.POSITIVE_INFINITY)).toBe('0')
  })

  it('round-trips what it displays', () => {
    for (const value of [0, -2, 2.5, -0.05, 1234.5678]) {
      expect(editNumberField(formatNumberField(value)).commit).toBe(value)
    }
  })
})
