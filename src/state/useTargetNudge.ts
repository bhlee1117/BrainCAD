/**
 * The window listener behind the number-pad target nudge.
 *
 * Two rules, both learned from the undo shortcut next door: while the caret is
 * in a field the keys belong to the field, and a modifier other than Shift
 * means the user is asking the browser or the OS for something, not us.
 */

import { useEffect } from 'react'

import { COARSE_FACTOR, NUDGE_KEYS, nudgeCoord } from './nudge.ts'
import { useAppStore } from './store.ts'

/** Whether the event came from somewhere that owns its own keystrokes. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useTargetNudge(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTextEntry(event.target)) return

      const direction = NUDGE_KEYS[event.code]
      if (!direction) return

      const state = useAppStore.getState()
      const target = state.targets.find((t) => t.id === state.selectedTargetId)
      if (!target) return

      event.preventDefault()

      const step = state.nudgeStepMm * (event.shiftKey ? COARSE_FACTOR : 1)
      state.updateTarget(target.id, { coord: nudgeCoord(target.coord, direction, step) })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
