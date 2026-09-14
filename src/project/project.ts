/**
 * Serialising the application state to and from a project file.
 *
 * The store was shaped to mirror the blueprint's project model, so this is
 * mostly a direct mapping — which is the point: a separate parallel model
 * would drift out of sync with what the app actually edits.
 */

import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { getProfile, profileMatchesSpace } from '../atlas/profile.ts'
import type { SceneObject } from '../objects/model.ts'
import type { Measurement } from '../measure/measure.ts'
import type { CollisionSettings } from '../collision/check.ts'
import type { AnatomyVisibility, Target } from '../state/store.ts'
import { PROJECT_FORMAT_VERSION, type ProjectFile } from './schema.ts'

export const SOFTWARE_VERSION = 'BrainCAD 0.1.0 (M4)'

export interface ProjectSnapshot {
  name: string
  notes: string
  created: string
  profile: CoordinateProfile
  atlas: LoadedAtlas
  anatomy: AnatomyVisibility
  targets: readonly Target[]
  objects: readonly SceneObject[]
  measurements: readonly Measurement[]
  collisionSettings: CollisionSettings
}

/** Build a project file from current state. */
export function serialiseProject(snapshot: ProjectSnapshot): ProjectFile {
  const { profile, atlas } = snapshot

  return {
    format: 'braincad',
    version: PROJECT_FORMAT_VERSION,
    metadata: {
      name: snapshot.name,
      notes: snapshot.notes,
      created: snapshot.created,
      modified: new Date().toISOString(),
      software: SOFTWARE_VERSION,
    },
    coordinateProfile: {
      id: profile.id,
      label: profile.label,
      bregma: {
        i0: profile.bregma.i0,
        i1: profile.bregma.i1,
        i2: profile.bregma.i2,
      },
      spaceShape: [
        profile.space.shape[0],
        profile.space.shape[1],
        profile.space.shape[2],
      ],
      resolutionUm: profile.space.resolutionUm,
      dvReference: profile.dvReference,
      citation: profile.provenance.citation,
      confidence: profile.provenance.confidence,
    },
    atlas: {
      id: atlas.manifest.annotation.sha256.slice(0, 16),
      resolutionUm: atlas.manifest.annotation.resolutionUm,
      orientation: atlas.manifest.annotation.orientation,
      citation: atlas.manifest.citation,
    },
    anatomyVisibility: {
      showBrain: snapshot.anatomy.showBrain,
      brainOpacity: snapshot.anatomy.brainOpacity,
      visibleStructureIds: [...snapshot.anatomy.visibleStructureIds],
    },
    targets: snapshot.targets.map((t) => ({
      id: t.id,
      name: t.name,
      coord: t.coord,
      notes: t.notes,
      visible: t.visible,
    })),
    objects: snapshot.objects.map((o) => ({
      id: o.id,
      kind: o.kind,
      name: o.name,
      spec: o.spec
        ? {
            kind: o.spec.kind,
            params: { ...o.spec.params } as unknown as Record<string, number>,
          }
        : null,
      source: o.source ? { ...o.source } : null,
      target: o.target,
      orientation: o.orientation,
      pivotMode: o.pivotMode,
      pivotCustom: [o.pivotCustom[0], o.pivotCustom[1], o.pivotCustom[2]] as [
        number,
        number,
        number,
      ],
      color: o.color,
      opacity: o.opacity,
      visible: o.visible,
      collision: o.collision,
      anatomyCollision: o.anatomyCollision,
      notes: o.notes,
    })),
    measurements: snapshot.measurements.map((m) => ({
      id: m.id,
      name: m.name,
      a: m.a,
      b: m.b,
      kind: m.kind,
      visible: m.visible,
    })),
    collisionSettings: { ...snapshot.collisionSettings },
    cameraState: null,
  }
}

export interface RestoreResult {
  readonly targets: Target[]
  readonly objects: SceneObject[]
  readonly measurements: Measurement[]
  readonly anatomy: AnatomyVisibility
  readonly collisionSettings: CollisionSettings
  readonly profileId: string
  readonly warnings: readonly string[]
}

/**
 * Turn a validated project file back into store state.
 *
 * The coordinate profile is the one field that needs real care. The file
 * carries a snapshot of the profile's values, but the app can only *use* a
 * profile that matches the loaded atlas volume. If the saved profile does not
 * describe the volume in this build, restoring it would reproduce exactly the
 * template-space mismatch the guard exists to prevent — so the mismatch is
 * reported and the profile is left alone rather than silently applied.
 */
export function restoreProject(project: ProjectFile, atlas: LoadedAtlas): RestoreResult {
  const warnings: string[] = []

  let profileId = project.coordinateProfile.id
  try {
    const candidate = getProfile(profileId)
    if (!profileMatchesSpace(candidate, atlas.space)) {
      warnings.push(
        `The plan's coordinate profile ("${project.coordinateProfile.label}") describes a ` +
          `${project.coordinateProfile.spaceShape.join('x')} volume, but the loaded atlas is ` +
          `${atlas.space.shape.join('x')}. Coordinates have been left as written; do not ` +
          `trust them until the matching atlas is loaded.`,
      )
      profileId = ''
    } else if (
      candidate.bregma.i0 !== project.coordinateProfile.bregma.i0 ||
      candidate.bregma.i1 !== project.coordinateProfile.bregma.i1 ||
      candidate.bregma.i2 !== project.coordinateProfile.bregma.i2
    ) {
      warnings.push(
        `The plan was saved with a bregma position that differs from the current ` +
          `"${candidate.label}" profile. The plan's own values are recorded in the file.`,
      )
    }
  } catch {
    warnings.push(
      `Unknown coordinate profile "${profileId}". Coordinates are shown as written but ` +
        `cannot be re-derived in this build.`,
    )
    profileId = ''
  }

  return {
    targets: project.targets.map((t) => ({
      id: t.id,
      name: t.name,
      coord: t.coord,
      notes: t.notes,
      visible: t.visible,
    })),
    objects: project.objects.map((o) => ({
      id: o.id,
      kind: o.kind,
      name: o.name,
      spec: o.spec
        ? ({ kind: o.spec.kind, params: { ...o.spec.params } } as unknown as SceneObject['spec'])
        : null,
      source: o.source ?? null,
      target: o.target,
      orientation: o.orientation,
      pivotMode: o.pivotMode,
      pivotCustom: o.pivotCustom,
      color: o.color,
      opacity: o.opacity,
      visible: o.visible,
      collision: o.collision,
      anatomyCollision: o.anatomyCollision,
      notes: o.notes,
    })),
    measurements: project.measurements.map((m) => ({
      id: m.id,
      name: m.name,
      a: m.a,
      b: m.b,
      kind: m.kind,
      visible: m.visible,
    })),
    anatomy: {
      showBrain: project.anatomyVisibility.showBrain,
      brainOpacity: project.anatomyVisibility.brainOpacity,
      visibleStructureIds: project.anatomyVisibility.visibleStructureIds,
    },
    collisionSettings: project.collisionSettings,
    profileId,
    warnings,
  }
}
