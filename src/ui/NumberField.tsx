/**
 * A numeric input that can actually be edited.
 *
 * See `numberField.ts` for why this is not just `value={number}`.
 */

import { useEffect, useRef, useState } from 'react'

import {
  editNumberField,
  formatNumberField,
  type NumberFieldLimits,
} from './numberField.ts'

export function NumberField({
  id,
  value,
  onChange,
  step,
  decimals,
  className,
  ariaLabel,
  inputMode,
  ...limits
}: {
  id?: string
  value: number
  onChange: (next: number) => void
  step?: number
  /** Digits kept when the field is not being edited. */
  decimals?: number
  className?: string
  ariaLabel?: string
  inputMode?: 'decimal' | 'numeric'
} & NumberFieldLimits) {
  // null means "not being edited" — the prop is the source of truth. A string
  // means the user is mid-edit and that text is, so an unparseable intermediate
  // state like "" or "-" survives instead of snapping back.
  const [draft, setDraft] = useState<string | null>(null)
  const editing = useRef(false)

  // If the value changes from elsewhere while the field is focused — a drag in
  // the 3D view, a Reset button — the draft is stale, so let it go.
  useEffect(() => {
    if (!editing.current) setDraft(null)
  }, [value])

  return (
    <input
      id={id}
      className={className}
      aria-label={ariaLabel}
      type="text"
      // A text input rather than type="number": the number type silently
      // reports an empty string for input the browser considers invalid (a
      // lone "-", a partial decimal in some locales), which hides exactly the
      // states this component exists to preserve. inputMode still brings up a
      // numeric keypad on a phone.
      inputMode={inputMode ?? 'decimal'}
      step={step}
      value={draft ?? formatNumberField(value, decimals)}
      onFocus={() => {
        editing.current = true
      }}
      onChange={(event) => {
        const edit = editNumberField(event.target.value, limits)
        setDraft(edit.draft)
        if (edit.commit !== null) onChange(edit.commit)
      }}
      onBlur={() => {
        editing.current = false
        // Drop the draft so the field re-syncs to the committed value: an
        // abandoned "" or "-" reverts rather than being read as zero.
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        // Arrow keys step the value, which a text input does not do for free
        // but users expect from a numeric field.
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const by = (step ?? 1) * (event.key === 'ArrowUp' ? 1 : -1)
          const next = editNumberField(String(value + by), limits)
          if (next.commit !== null) {
            onChange(next.commit)
            setDraft(null)
          }
        }
      }}
    />
  )
}
