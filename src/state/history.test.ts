/**
 * Undo history tests.
 *
 * Driven through the real store rather than the pure helpers alone, because the
 * parts most likely to break are the interactions: that undo does not record
 * itself, that redo is dropped once the plan diverges, and that a delete is
 * never folded into the edit before it.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from './store.ts'
import {
  COALESCE_MS,
  documentSnapshot,
  isSameDocument,
  recordHistory,
  type HistoryEntry,
} from './history.ts'

const initial = useAppStore.getState()

function reset() {
  useAppStore.setState({
    targets: initial.targets,
    selectedTargetId: initial.selectedTargetId,
    objects: [],
    selection: initial.selection,
    measurements: [],
    overlays: [],
  })
  // The write above is a document change, so the subscriber records it like any
  // other edit. Clear the history afterwards — this second write changes no
  // document collection, so it records nothing itself.
  useAppStore.setState({ past: [], future: [] })
}

describe('recording edits', () => {
  beforeEach(reset)

  it('records adding a target, and undoes it', () => {
    const before = useAppStore.getState().targets.length
    useAppStore.getState().addTarget({ ap: 1, ml: 2, dv: -3 })
    expect(useAppStore.getState().targets).toHaveLength(before + 1)
    expect(useAppStore.getState().past.length).toBeGreaterThan(0)

    useAppStore.getState().undo()
    expect(useAppStore.getState().targets).toHaveLength(before)
  })

  it('redoes what it undid', () => {
    useAppStore.getState().addTarget({ ap: 1, ml: 2, dv: -3 })
    const after = useAppStore.getState().targets.length

    useAppStore.getState().undo()
    useAppStore.getState().redo()
    expect(useAppStore.getState().targets).toHaveLength(after)
  })

  it('does not record the undo itself', () => {
    // The subscriber sees undo's own write like any other change. If it
    // recorded it, undo would push the state it just left and a second undo
    // would bounce between two states forever.
    useAppStore.getState().addTarget({ ap: 1, ml: 2, dv: -3 })
    useAppStore.getState().addTarget({ ap: 4, ml: 5, dv: -6 })
    const depth = useAppStore.getState().past.length

    useAppStore.getState().undo()
    expect(useAppStore.getState().past.length).toBe(depth - 1)

    useAppStore.getState().undo()
    expect(useAppStore.getState().past.length).toBe(depth - 2)
  })

  it('walks all the way back through several edits', () => {
    const start = useAppStore.getState().targets.length
    for (const ap of [1, 2, 3]) {
      useAppStore.getState().addTarget({ ap, ml: 0, dv: 0 })
    }
    expect(useAppStore.getState().targets).toHaveLength(start + 3)

    for (let i = 0; i < 3; i++) useAppStore.getState().undo()
    expect(useAppStore.getState().targets).toHaveLength(start)
  })

  it('does nothing when there is nothing to undo', () => {
    const before = documentSnapshot(useAppStore.getState())
    useAppStore.getState().undo()
    expect(isSameDocument(documentSnapshot(useAppStore.getState()), before)).toBe(true)
  })

  it('drops the redo stack once a new edit diverges', () => {
    // The undone states were reached from a document that no longer exists;
    // reapplying them would graft an edit onto a different plan.
    useAppStore.getState().addTarget({ ap: 1, ml: 0, dv: 0 })
    useAppStore.getState().undo()
    expect(useAppStore.getState().future.length).toBe(1)

    useAppStore.getState().addTarget({ ap: 9, ml: 0, dv: 0 })
    expect(useAppStore.getState().future.length).toBe(0)
  })

  it('ignores selection changes', () => {
    const id = useAppStore.getState().addTarget({ ap: 1, ml: 0, dv: 0 })
    const depth = useAppStore.getState().past.length

    useAppStore.getState().select({ kind: 'target', id })
    useAppStore.getState().selectTarget(null)
    expect(useAppStore.getState().past.length).toBe(depth)
  })

  it('ignores view-only changes', () => {
    const depth = useAppStore.getState().past.length
    useAppStore.getState().setAnatomy({ brainOpacity: 0.5 })
    useAppStore.getState().setSlices({ visible: false })
    useAppStore.getState().setGizmoMode('rotate')
    expect(useAppStore.getState().past.length).toBe(depth)
  })

  it('restores a removed object', () => {
    const id = useAppStore.getState().addObject('cannula')
    expect(useAppStore.getState().objects).toHaveLength(1)

    useAppStore.getState().removeObject(id)
    expect(useAppStore.getState().objects).toHaveLength(0)

    useAppStore.getState().undo()
    expect(useAppStore.getState().objects).toHaveLength(1)
    expect(useAppStore.getState().objects[0]!.id).toBe(id)
  })
})

describe('coalescing', () => {
  // Snapshots are compared by reference, so each distinct document must be a
  // stable object — building a fresh one per call would read as a change even
  // when nothing moved.
  const docs = new Map<string, ReturnType<typeof makeDoc>>()
  function makeDoc(ids: string[]) {
    return {
      targets: ids.map((id) => ({ id })),
      objects: [],
      measurements: [],
      overlays: [],
      selectedTargetId: null,
      selection: null,
    } as never as HistoryEntry['snapshot']
  }
  const doc = (key: string, ids: string[] = key.split(',').filter(Boolean)) => {
    if (!docs.has(key)) docs.set(key, makeDoc(ids))
    return docs.get(key)!
  }
  const entry = (key: string, at: number): HistoryEntry => ({ at, snapshot: doc(key) })

  it('records nothing when the document did not change', () => {
    expect(recordHistory([], doc('a'), doc('a'), 0)).toHaveLength(0)
  })

  it('folds a run of edits to the same items into one step', () => {
    // Dragging fires a change per frame; sixty undo steps to reverse one drag
    // is not an undo history anyone can use.
    let past = recordHistory([], doc('a'), doc('a-moved', ['a']), 1000)
    expect(past).toHaveLength(1)

    past = recordHistory(past, doc('a-moved', ['a']), doc('a-moved2', ['a']), 1100)
    expect(past).toHaveLength(1)

    past = recordHistory(past, doc('a-moved2', ['a']), doc('a-moved3', ['a']), 1200)
    expect(past).toHaveLength(1)
  })

  it('starts a new step once the pause is long enough', () => {
    const past = recordHistory(
      [entry('a', 1000)],
      doc('a'),
      doc('a-later', ['a']),
      1000 + COALESCE_MS + 1,
    )
    expect(past).toHaveLength(2)
  })

  it('never folds a deletion into the edit before it', () => {
    // Deleting changes the id set, so it always begins its own step even mid-
    // drag. Undoing a deletion is where getting this wrong costs the most.
    const past = recordHistory([entry('a,b', 1000)], doc('a,b'), doc('a'), 1010)
    expect(past).toHaveLength(2)
  })

  it('keeps the state between an add and an immediate delete', () => {
    // Add then delete leaves the id set matching the step already recorded. A
    // coalescing rule that compared against that entry folded the two together
    // and lost the document that had the object in it.
    let past = recordHistory([], doc(''), doc('a'), 1000)
    past = recordHistory(past, doc('a'), doc(''), 1010)
    expect(past).toHaveLength(2)
    expect(past[1]!.snapshot).toBe(doc('a'))
  })

  it('never folds an addition into the edit before it', () => {
    const past = recordHistory([entry('a', 1000)], doc('a'), doc('a,b'), 1010)
    expect(past).toHaveLength(2)
  })

  it('keeps the oldest snapshot of a coalesced run', () => {
    // The run should undo to where it started, not to its second frame.
    const first = entry('a', 1000)
    const past = recordHistory([first], doc('a'), doc('a-moved', ['a']), 1100)
    expect(past[past.length - 1]!.snapshot).toBe(first.snapshot)
  })
})
