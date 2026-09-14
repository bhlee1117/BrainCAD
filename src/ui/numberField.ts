/**
 * Editing logic for a numeric text field.
 *
 * Binding a number straight to a controlled `<input type="number">` and
 * ignoring anything that fails to parse looks correct and is not: the states a
 * user passes *through* while typing are not themselves valid numbers.
 * Backspacing "-2" gives "-", then ""; typing a decimal passes through "1.";
 * starting a negative passes through "-". Rejecting those re-renders the old
 * number and puts the caret back, so the field cannot be cleared at all — which
 * is exactly how this was reported.
 *
 * The fix is to keep what the user typed as a string while the field is being
 * edited, and to treat the number as a separate thing that is updated whenever
 * the draft happens to parse. The draft is dropped on blur, so the field
 * re-syncs to the canonical value and "1." settles to "1".
 *
 * Kept pure and separate from the component so the transitions can be tested
 * without a DOM.
 */

export interface NumberFieldLimits {
  readonly min?: number
  readonly max?: number
  /** Round to a whole number before committing. */
  readonly integer?: boolean
}

export interface NumberFieldEdit {
  /** What the input should display. */
  readonly draft: string
  /** A value to propagate, or null when the draft is not (yet) a number. */
  readonly commit: number | null
}

/** Clamp and round according to the field's limits. */
export function applyLimits(value: number, limits: NumberFieldLimits = {}): number {
  let out = limits.integer ? Math.round(value) : value
  if (limits.min !== undefined) out = Math.max(limits.min, out)
  if (limits.max !== undefined) out = Math.min(limits.max, out)
  return out
}

/**
 * Interpret a keystroke.
 *
 * Anything is allowed to stand as a draft — including the empty string and a
 * lone minus sign — because refusing to display them is the bug. Only a draft
 * that parses to a finite number is propagated.
 */
export function editNumberField(
  text: string,
  limits: NumberFieldLimits = {},
): NumberFieldEdit {
  const trimmed = text.trim()
  if (trimmed === '') return { draft: text, commit: null }

  // Reject trailing-garbage input like "1.2.3" or "5px" rather than taking
  // parseFloat's prefix, which would silently change what the user typed.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) {
    return { draft: text, commit: null }
  }

  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) return { draft: text, commit: null }

  return { draft: text, commit: applyLimits(parsed, limits) }
}

/**
 * How a value should read when the field is not being edited.
 *
 * Rounded rather than printed raw: a tilt stored as 2.0000000000000004 after a
 * rotation should show as "2", not as a number nobody typed.
 */
export function formatNumberField(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return '0'
  return String(Number(value.toFixed(decimals)))
}
