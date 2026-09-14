/**
 * Ctrl/Cmd+Z and its redo partners, bound at the window.
 *
 * The one rule that matters: while the caret is in a text field, the shortcut
 * belongs to the field. Stealing it would undo the user's plan instead of the
 * characters they just typed, which is both surprising and hard to recover
 * from — the typing is gone and a scene edit has been reversed.
 */

import { useEffect } from 'react'

import { useAppStore } from './store.ts'

/** Whether the event came from somewhere with its own undo. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useUndoShortcuts(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey) return
      if (isTextEntry(event.target)) return

      const key = event.key.toLowerCase()
      // Ctrl+Y is the Windows redo convention; Cmd/Ctrl+Shift+Z is everyone
      // else's. Both are cheap to accept.
      const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
      const undo = key === 'z' && !event.shiftKey

      if (!undo && !redo) return
      event.preventDefault()

      const state = useAppStore.getState()
      if (redo) state.redo()
      else state.undo()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
