/**
 * Undo history.
 *
 * What is undoable here is the *plan* — targets, hardware, measurements and
 * loaded overlays — and deliberately not the view. Undo that reversed a camera
 * move, a checkbox or a slice toggle would spend the user's undo stack on
 * things they can trivially redo by hand, and would bury the edit they actually
 * wanted back. Selection is captured alongside the document so undo restores
 * the context an edit happened in, but a selection change on its own is not an
 * edit and records nothing.
 *
 * Snapshots hold references, not deep copies. Every store action replaces the
 * arrays it touches instead of mutating them, so a snapshot is a handful of
 * pointers — which is what makes it affordable to keep one per keystroke, even
 * with overlays carrying megabytes of geometry.
 */

import type { Measurement } from '../measure/measure.ts'
import type { SceneObject } from '../objects/model.ts'
import type { Overlay } from '../overlays/model.ts'
import type { Selection, Target } from './model.ts'

/** The part of the store that undo restores. */
export interface DocumentSnapshot {
  readonly targets: Target[]
  readonly objects: SceneObject[]
  readonly measurements: Measurement[]
  readonly overlays: Overlay[]
  readonly selectedTargetId: string | null
  readonly selection: Selection
}

export interface HistoryEntry {
  readonly snapshot: DocumentSnapshot
  /** When it was recorded, for coalescing. */
  readonly at: number
}

/**
 * How long a run of edits stays a single undo step.
 *
 * Dragging a cannula fires a change per frame and typing a coordinate fires one
 * per keystroke. Without coalescing, undo would step back through sixty
 * intermediate positions to reach the one the user actually wants.
 */
export const COALESCE_MS = 500

/** Deepest history kept. Older steps are dropped from the far end. */
export const HISTORY_LIMIT = 100

/** Take a snapshot of the undoable part of the state. */
export function documentSnapshot(state: DocumentSnapshot): DocumentSnapshot {
  return {
    targets: state.targets,
    objects: state.objects,
    measurements: state.measurements,
    overlays: state.overlays,
    selectedTargetId: state.selectedTargetId,
    selection: state.selection,
  }
}

/**
 * Whether two snapshots describe the same document.
 *
 * Reference equality on each collection, because the store never mutates in
 * place: an action that changed nothing hands back the identical array, and an
 * action that changed something hands back a new one.
 *
 * Selection is excluded on purpose. Clicking around is not an edit, and
 * recording it would fill the history with steps that undo to the same plan.
 */
export function isSameDocument(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  return (
    a.targets === b.targets &&
    a.objects === b.objects &&
    a.measurements === b.measurements &&
    a.overlays === b.overlays
  )
}

/** The ids present in a snapshot, used to tell an edit from a structural change. */
function shape(snapshot: DocumentSnapshot): string {
  const ids = (list: readonly unknown[]) =>
    list.map((item) => (item as { id?: string }).id ?? '?').join(',')
  return [
    ids(snapshot.targets),
    ids(snapshot.objects),
    ids(snapshot.measurements),
    ids(snapshot.overlays),
  ].join('|')
}

/**
 * Whether a change should fold into the previous history step.
 *
 * Only edits coalesce. Adding or deleting anything changes the set of ids and
 * always starts a new step, so a delete can never be swallowed into the drag
 * that preceded it — undoing a deletion is where getting this wrong costs the
 * most.
 *
 * The shapes compared are this change's own before and after, not the previous
 * entry's. Comparing against the entry was wrong in a way a test caught:
 * adding an object and immediately deleting it leaves the id set identical to
 * the step already recorded, so the two folded together and the state with the
 * object in it was lost — undo skipped straight past it.
 */
export function shouldCoalesce(
  previous: HistoryEntry,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  now: number,
): boolean {
  if (now - previous.at > COALESCE_MS) return false
  return shape(before) === shape(after)
}

/**
 * Record a change.
 *
 * `past` holds the states to go *back* to, so what gets pushed is the snapshot
 * taken before the change, not after it.
 */
export function recordHistory(
  past: readonly HistoryEntry[],
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  now: number,
): readonly HistoryEntry[] {
  if (isSameDocument(before, after)) return past

  const previous = past[past.length - 1]
  if (previous && shouldCoalesce(previous, before, after, now)) {
    // Keep the older snapshot — it is the state the whole run started from —
    // and only move the clock forward so the run can continue growing.
    return [...past.slice(0, -1), { snapshot: previous.snapshot, at: now }]
  }

  const grown = [...past, { snapshot: before, at: now }]
  return grown.length > HISTORY_LIMIT ? grown.slice(grown.length - HISTORY_LIMIT) : grown
}
