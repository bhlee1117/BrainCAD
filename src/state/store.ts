/**
 * Application state.
 *
 * The shape here deliberately mirrors the project data model from the BrainCAD
 * blueprint (§16), so that saving a project at M4 is a serialisation of this
 * store rather than a separate parallel model that can drift out of sync.
 */

import { create } from 'zustand'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { DEFAULT_PROFILE_ID, getProfile } from '../atlas/profile.ts'
import type { Orientation } from '../objects/placement.ts'
import type { SceneObject } from '../objects/model.ts'
import { makeObject, releaseCustomGeometry } from '../objects/model.ts'
import type { ObjectKind, PrimitiveParams } from '../objects/primitives.ts'

export interface Target {
  readonly id: string
  name: string
  coord: Stereotaxic
  notes: string
  visible: boolean
}

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
export type Selection =
  | { kind: 'target'; id: string }
  | { kind: 'object'; id: string }
  | null

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
}

let targetCounter = 0
function nextTargetId(): string {
  targetCounter += 1
  return `target-${targetCounter}`
}

let objectCounter = 0
function nextObjectId(): string {
  objectCounter += 1
  return `object-${objectCounter}`
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
