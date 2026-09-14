/**
 * Application state.
 *
 * The shape here deliberately mirrors the project data model from the BrainCAD
 * blueprint (§16), so that saving a project at M4 is a serialisation of this
 * store rather than a separate parallel model that can drift out of sync.
 */

import { create } from 'zustand'

import {
  documentSnapshot,
  recordHistory,
  type HistoryEntry,
} from './history.ts'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { DEFAULT_PROFILE_ID, getProfile } from '../atlas/profile.ts'
import type { Orientation } from '../objects/placement.ts'
import type { SceneObject } from '../objects/model.ts'
import { makeObject, releaseCustomGeometry } from '../objects/model.ts'
import type { ObjectKind, PrimitiveParams } from '../objects/primitives.ts'
import type { CollisionSettings, SceneCollisionReport } from '../collision/check.ts'
import { DEFAULT_COLLISION_SETTINGS } from '../collision/check.ts'
import type { Measurement } from '../measure/measure.ts'
import {
  DEFAULT_SECTION,
  type SectionAxis,
  type SectionPlaneState,
  type SectionState,
} from '../scene/section.ts'
import type { Selection, Target } from './model.ts'

// Re-exported so existing importers keep working; the types live in model.ts
// so the history module can name them without importing the store.
export type { Selection, Target }
import type { Overlay, OverlayPatch } from '../overlays/model.ts'

export type AtlasStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'ready'; atlas: LoadedAtlas }
  | { kind: 'error'; message: string }

export interface AnatomyVisibility {
  showBrain: boolean
  brainOpacity: number
  /** Region meshes toggled on in the ATLAS tab, by structure id. */
  visibleStructureIds: readonly number[]
}

export interface SliceState {
  /** Whether slice panels are shown at all. */
  visible: boolean
  /** When true, slice positions follow the selected target. */
  followTarget: boolean
}

/**
 * What the properties panel and gizmo are currently acting on.
 *
 * Targets and objects share one selection, because the right-hand panel shows
 * whichever is selected and only one thing can be edited at a time.
 */
export interface AppState {
  atlasStatus: AtlasStatus
  profileId: string
  targets: Target[]
  selectedTargetId: string | null
  objects: SceneObject[]
  selection: Selection
  /** Which transform the 3D gizmo applies. */
  gizmoMode: 'translate' | 'rotate'
  anatomy: AnatomyVisibility
  slices: SliceState
  /**
   * Section planes cutting the 3D view open.
   *
   * View state, like `slices` and unlike anything in the document snapshot:
   * it changes what is drawn, never what is planned, and is deliberately
   * outside undo for the reason history.ts gives.
   */
  section: SectionState

  collisionEnabled: boolean
  collisionSettings: CollisionSettings
  /** Latest report, published by the collision hook for panels to read. */
  collisionReport: SceneCollisionReport | null

  measurements: Measurement[]
  /** Loaded data overlays, drawn over the anatomy. */
  overlays: Overlay[]
  /** Which endpoint the next click in measure mode sets, or null when idle. */
  measuring: 'a' | 'b' | null
  /** Endpoint A while a measurement is being placed. */
  pendingA: Measurement['a'] | null

  setAtlasStatus: (status: AtlasStatus) => void
  setProfileId: (id: string) => void

  addObject: (kind: ObjectKind, target?: Stereotaxic, name?: string) => string
  updateObject: (id: string, patch: Partial<Omit<SceneObject, 'id'>>) => void
  updateObjectParams: (id: string, params: Partial<PrimitiveParams['params']>) => void
  setObjectOrientation: (id: string, patch: Partial<Orientation>) => void
  removeObject: (id: string) => void
  select: (selection: Selection) => void
  setGizmoMode: (mode: 'translate' | 'rotate') => void

  addTarget: (coord: Stereotaxic, name?: string) => string
  updateTarget: (id: string, patch: Partial<Omit<Target, 'id'>>) => void
  removeTarget: (id: string) => void
  selectTarget: (id: string | null) => void

  setAnatomy: (patch: Partial<AnatomyVisibility>) => void
  toggleStructure: (id: number) => void
  setSlices: (patch: Partial<SliceState>) => void
  setSectionPlane: (axis: SectionAxis, patch: Partial<SectionPlaneState>) => void
  clearSection: () => void

  setCollisionEnabled: (enabled: boolean) => void
  setCollisionSettings: (patch: Partial<CollisionSettings>) => void
  setCollisionReport: (report: SceneCollisionReport | null) => void

  startMeasuring: () => void
  cancelMeasuring: () => void
  setPendingA: (point: Measurement['a']) => void
  addMeasurement: (b: Measurement['b']) => void
  updateMeasurement: (id: string, patch: Partial<Omit<Measurement, 'id'>>) => void
  removeMeasurement: (id: string) => void

  addOverlay: (overlay: Overlay) => void
  updateOverlay: (id: string, patch: OverlayPatch) => void
  removeOverlay: (id: string) => void

  /** States to step back to, oldest first. */
  past: readonly HistoryEntry[]
  /** States undone and available again, most recently undone last. */
  future: readonly HistoryEntry[]
  undo: () => void
  redo: () => void
}

/**
 * Whether the next store change should be recorded as an edit.
 *
 * Cleared by undo and redo just before they write, so the subscriber below
 * ignores the one change they cause. Module-level rather than store state
 * because it must not itself be part of a snapshot.
 */
let recording = true

let targetCounter = 0
function nextTargetId(): string {
  targetCounter += 1
  return `target-${targetCounter}`
}

let measurementCounter = 0

let objectCounter = 0
function nextObjectId(): string {
  objectCounter += 1
  return `object-${objectCounter}`
}

/**
 * Advance the id counter past every id in a restored plan.
 *
 * Object ids are also the keys of the mesh-geometry registry, so an id handed
 * out twice does not merely confuse the scene tree — the second object would
 * be drawn with the first one's imported STL. A freshly opened project starts
 * at `object-1` again, so without this the very next object added after
 * opening a plan collides with one already in it.
 */
export function adoptObjectIds(objects: readonly { id: string }[]): void {
  for (const object of objects) {
    const match = /^object-(\d+)$/.exec(object.id)
    if (match) objectCounter = Math.max(objectCounter, Number(match[1]))
  }
}

/** A dorsal CA1 coordinate, so the app opens on something anatomically real. */
const INITIAL_TARGET_COORD: Stereotaxic = { ap: -2.0, ml: 1.5, dv: -1.35 }

export const useAppStore = create<AppState>((set, get) => {
  const firstTargetId = nextTargetId()

  return {
    atlasStatus: { kind: 'idle' },
    profileId: DEFAULT_PROFILE_ID,
    targets: [
      {
        id: firstTargetId,
        name: 'Target 1',
        coord: INITIAL_TARGET_COORD,
        notes: '',
        visible: true,
      },
    ],
    selectedTargetId: firstTargetId,
    objects: [],
    selection: { kind: 'target', id: firstTargetId },
    gizmoMode: 'translate',
    anatomy: {
      showBrain: true,
      brainOpacity: 0.18,
      visibleStructureIds: [],
    },
    slices: { visible: true, followTarget: true },
    // Cloned, not shared: patches replace one axis at a time and a shared
    // default would accumulate them across reloads of the module.
    section: {
      ml: { ...DEFAULT_SECTION.ml },
      dv: { ...DEFAULT_SECTION.dv },
      ap: { ...DEFAULT_SECTION.ap },
    },

    collisionEnabled: true,
    collisionSettings: { ...DEFAULT_COLLISION_SETTINGS },
    collisionReport: null,

    measurements: [],
    overlays: [],
    measuring: null,
    pendingA: null,

    past: [],
    future: [],

    /**
     * Step back one edit.
     *
     * The current document moves onto `future` so redo can return to it. The
     * `recording` flag is what stops the subscriber below from treating this
     * very change as a new edit and immediately re-recording it.
     */
    undo: () =>
      set((state) => {
        const entry = state.past[state.past.length - 1]
        if (!entry) return {}
        recording = false
        return {
          ...entry.snapshot,
          past: state.past.slice(0, -1),
          future: [...state.future, { snapshot: documentSnapshot(state), at: Date.now() }],
        } as Partial<AppState>
      }),

    redo: () =>
      set((state) => {
        const entry = state.future[state.future.length - 1]
        if (!entry) return {}
        recording = false
        return {
          ...entry.snapshot,
          past: [...state.past, { snapshot: documentSnapshot(state), at: Date.now() }],
          future: state.future.slice(0, -1),
        } as Partial<AppState>
      }),

    setAtlasStatus: (atlasStatus) => set({ atlasStatus }),
    setProfileId: (profileId) => set({ profileId }),

    addTarget: (coord, name) => {
      const id = nextTargetId()
      set((state) => ({
        targets: [
          ...state.targets,
          {
            id,
            name: name ?? `Target ${state.targets.length + 1}`,
            coord,
            notes: '',
            visible: true,
          },
        ],
        selectedTargetId: id,
      }))
      return id
    },

    updateTarget: (id, patch) =>
      set((state) => ({
        targets: state.targets.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      })),

    removeTarget: (id) =>
      set((state) => {
        const targets = state.targets.filter((t) => t.id !== id)
        return {
          targets,
          selectedTargetId:
            state.selectedTargetId === id ? (targets[0]?.id ?? null) : state.selectedTargetId,
        }
      }),

    selectTarget: (selectedTargetId) =>
      set({
        selectedTargetId,
        selection: selectedTargetId ? { kind: 'target', id: selectedTargetId } : null,
      }),

    addObject: (kind, target, name) => {
      const id = nextObjectId()
      set((state) => {
        // New objects land on the selected target by default, which is almost
        // always what the user means: they picked a coordinate, now they want
        // something placed there.
        const at =
          target ??
          state.targets.find((t) => t.id === state.selectedTargetId)?.coord ??
          { ap: 0, ml: 0, dv: -2 }

        const existing = state.objects.filter((o) => o.kind === kind).length
        const object = makeObject(id, kind, at, name)
        if (existing > 0) object.name = `${object.name} ${existing + 1}`

        return { objects: [...state.objects, object], selection: { kind: 'object', id } }
      })
      return id
    },

    updateObject: (id, patch) =>
      set((state) => ({
        objects: state.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      })),

    updateObjectParams: (id, params) =>
      set((state) => ({
        objects: state.objects.map((o) => {
          if (o.id !== id || !o.spec) return o
          return {
            ...o,
            spec: { ...o.spec, params: { ...o.spec.params, ...params } } as typeof o.spec,
          }
        }),
      })),

    setObjectOrientation: (id, patch) =>
      set((state) => ({
        objects: state.objects.map((o) =>
          o.id === id ? { ...o, orientation: { ...o.orientation, ...patch } } : o,
        ),
      })),

    removeObject: (id) =>
      set((state) => {
        releaseCustomGeometry(id)
        return {
          objects: state.objects.filter((o) => o.id !== id),
          selection:
            state.selection?.kind === 'object' && state.selection.id === id
              ? null
              : state.selection,
        }
      }),

    select: (selection) =>
      set((state) => ({
        selection,
        selectedTargetId:
          selection?.kind === 'target' ? selection.id : state.selectedTargetId,
      })),

    setGizmoMode: (gizmoMode) => set({ gizmoMode }),

    setCollisionEnabled: (collisionEnabled) => set({ collisionEnabled }),

    setCollisionSettings: (patch) =>
      set((state) => ({ collisionSettings: { ...state.collisionSettings, ...patch } })),

    setCollisionReport: (collisionReport) => set({ collisionReport }),

    startMeasuring: () => set({ measuring: 'a', pendingA: null }),

    cancelMeasuring: () => set({ measuring: null, pendingA: null }),

    setPendingA: (pendingA) => set({ pendingA, measuring: 'b' }),

    addMeasurement: (b) =>
      set((state) => {
        if (!state.pendingA) return {}
        measurementCounter += 1
        return {
          measurements: [
            ...state.measurements,
            {
              id: `measurement-${measurementCounter}`,
              name: `Measurement ${state.measurements.length + 1}`,
              a: state.pendingA,
              b,
              kind: 'euclidean' as const,
              visible: true,
            },
          ],
          measuring: null,
          pendingA: null,
        }
      }),

    updateMeasurement: (id, patch) =>
      set((state) => ({
        measurements: state.measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      })),

    removeMeasurement: (id) =>
      set((state) => ({ measurements: state.measurements.filter((m) => m.id !== id) })),

    addOverlay: (overlay) => set((state) => ({ overlays: [...state.overlays, overlay] })),

    updateOverlay: (id, patch) =>
      set((state) => ({
        overlays: state.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      })),

    removeOverlay: (id) =>
      set((state) => ({ overlays: state.overlays.filter((o) => o.id !== id) })),

    setAnatomy: (patch) => set((state) => ({ anatomy: { ...state.anatomy, ...patch } })),

    toggleStructure: (id) =>
      set((state) => {
        const visible = state.anatomy.visibleStructureIds
        return {
          anatomy: {
            ...state.anatomy,
            visibleStructureIds: visible.includes(id)
              ? visible.filter((sid) => sid !== id)
              : [...visible, id],
          },
        }
      }),

    setSlices: (patch) => set((state) => ({ slices: { ...state.slices, ...patch } })),

    setSectionPlane: (axis, patch) =>
      set((state) => ({
        section: { ...state.section, [axis]: { ...state.section[axis], ...patch } },
      })),

    clearSection: () =>
      set({
        section: {
          ml: { ...DEFAULT_SECTION.ml },
          dv: { ...DEFAULT_SECTION.dv },
          ap: { ...DEFAULT_SECTION.ap },
        },
      }),
  }

  // `get` is part of the zustand signature; referenced here to keep it in scope
  // for actions added in later milestones.
  void get
})

/** The active coordinate profile. */
export function useProfile(): CoordinateProfile {
  return getProfile(useAppStore((s) => s.profileId))
}

/** The currently selected target, if any. */
export function useSelectedTarget(): Target | null {
  return useAppStore((s) => s.targets.find((t) => t.id === s.selectedTargetId) ?? null)
}

/** The loaded atlas, or null while loading or on error. */
export function useAtlas(): LoadedAtlas | null {
  return useAppStore((s) => (s.atlasStatus.kind === 'ready' ? s.atlasStatus.atlas : null))
}

/** The currently selected scene object, if an object is selected. */
export function useSelectedObject(): SceneObject | null {
  return useAppStore((s) =>
    s.selection?.kind === 'object'
      ? (s.objects.find((o) => o.id === s.selection!.id) ?? null)
      : null,
  )
}

/**
 * Record edits into the undo history.
 *
 * A subscriber rather than a change to every action: there are twenty-odd
 * mutating actions, and a rule applied in one place cannot be forgotten when
 * the twenty-first is added.
 *
 * Redo is cleared on any new edit — once the plan diverges, the states that
 * were undone are no longer reachable, and offering them would reapply an edit
 * to a document it was never made against.
 */
useAppStore.subscribe((state, previous) => {
  if (!recording) {
    recording = true
    return
  }

  const before = documentSnapshot(previous)
  const after = documentSnapshot(state)
  const past = recordHistory(state.past, before, after, Date.now())
  if (past === state.past) return

  useAppStore.setState({ past, future: [] })
  // setState above is itself a change; skip recording it.
  recording = true
})

/** Whether there is anything to step back to. */
export function useCanUndo(): boolean {
  return useAppStore((s) => s.past.length > 0)
}

/** Whether an undone edit is available again. */
export function useCanRedo(): boolean {
  return useAppStore((s) => s.future.length > 0)
}
