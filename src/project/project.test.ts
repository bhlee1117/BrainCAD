/**
 * Project file tests.
 *
 * A plan may be reopened months later or handed to a collaborator, so these
 * cover the two things that matter beyond round-tripping: that a damaged file
 * fails loudly, and that a plan cannot be silently reinterpreted under a
 * coordinate profile that does not describe the loaded atlas.
 */

import { describe, expect, it } from 'vitest'

import { ALLEN_CCFV3_50UM, PERENS_STEREOTAXIC_MRI } from '../atlas/profile.ts'
import { DEFAULT_COLLISION_SETTINGS } from '../collision/check.ts'
import { makeObject } from '../objects/model.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import {
  PROJECT_FORMAT_VERSION,
  parseProject,
  projectFilename,
  projectSchema,
} from './schema.ts'
import { restoreProject, serialiseProject, type ProjectSnapshot } from './project.ts'

/** Minimal stand-in for a loaded atlas; only these fields are serialised. */
function fakeAtlas(shape: [number, number, number] = [264, 160, 228]): LoadedAtlas {
  return {
    manifest: {
      generatedAt: '2026-09-13T00:00:00.000Z',
      annotation: {
        file: 'annotation_50.nrrd',
        bytes: 880845,
        sha256: 'd125bdafc359f78de4248392c3b0c63972855445',
        resolutionUm: 50,
        orientation: 'asr',
        source: 'https://example.invalid/annotation_50.nrrd',
      },
      ontology: { file: 'structures.json', count: 1327, source: 'https://example.invalid' },
      meshes: [],
      lazyMeshBaseUrl: 'https://example.invalid',
      citation: 'Allen CCFv3; Wang et al. (2020).',
    },
    volume: null as never,
    space: { shape, resolutionUm: 50, axes: ALLEN_CCFV3_50UM.space.axes },
    structures: [],
    index: null as never,
    colors: new Map(),
  }
}

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const cannula = makeObject('object-1', 'cannula', { ap: -2, ml: 1.5, dv: -1.35 })
  cannula.orientation = { apTiltDeg: 12, mlTiltDeg: -5, rollDeg: 0 }

  return {
    name: 'CA1 prism implant',
    notes: 'Pilot animal',
    created: '2026-09-13T12:00:00.000Z',
    profile: ALLEN_CCFV3_50UM,
    atlas: fakeAtlas(),
    anatomy: { showBrain: true, brainOpacity: 0.2, visibleStructureIds: [382, 672] },
    targets: [
      {
        id: 'target-1',
        name: 'Dorsal CA1',
        coord: { ap: -2, ml: 1.5, dv: -1.35 },
        notes: '',
        visible: true,
      },
    ],
    objects: [cannula],
    measurements: [
      {
        id: 'measurement-1',
        name: 'Tip to surface',
        a: { coord: { ap: -2, ml: 1.5, dv: -1.35 }, snap: 'target', snappedTo: 'Dorsal CA1' },
        b: { coord: { ap: -2, ml: 1.5, dv: 0.4 }, snap: 'mesh-surface', snappedTo: 'Brain' },
        kind: 'euclidean',
        visible: true,
      },
    ],
    collisionSettings: { ...DEFAULT_COLLISION_SETTINGS },
    ...overrides,
  }
}

describe('serialising', () => {
  it('produces a file that validates against the schema', () => {
    const file = serialiseProject(snapshot())
    expect(projectSchema.safeParse(file).success).toBe(true)
  })

  it('stamps the format, version and software', () => {
    const file = serialiseProject(snapshot())
    expect(file.format).toBe('braincad')
    expect(file.version).toBe(PROJECT_FORMAT_VERSION)
    expect(file.metadata.software).toContain('BrainCAD')
  })

  it('records the coordinate profile by value, not just by name', () => {
    // A profile referenced only by id could resolve to different numbers on
    // another machine; the plan has to be self-describing.
    const file = serialiseProject(snapshot())
    expect(file.coordinateProfile.bregma).toEqual({ i0: 108, i1: 6.64, i2: 114 })
    expect(file.coordinateProfile.spaceShape).toEqual([264, 160, 228])
    expect(file.coordinateProfile.citation).toContain('Allen')
    expect(file.coordinateProfile.confidence).toBe('community-convention')
  })

  it('updates the modified timestamp but keeps created', () => {
    const file = serialiseProject(snapshot())
    expect(file.metadata.created).toBe('2026-09-13T12:00:00.000Z')
    expect(new Date(file.metadata.modified).getTime()).toBeGreaterThan(
      new Date(file.metadata.created).getTime(),
    )
  })

  it('deep-copies parameters so later edits do not mutate the saved file', () => {
    const snap = snapshot()
    const file = serialiseProject(snap)
    const params = snap.objects[0]!.spec!.params as unknown as Record<string, number>
    const original = { ...params }
    params.lengthMm = 999
    expect(file.objects[0]!.spec!.params).toEqual(original)
  })
})

describe('round-tripping', () => {
  it('restores targets, objects and measurements unchanged', () => {
    const original = snapshot()
    const text = JSON.stringify(serialiseProject(original))
    const parsed = parseProject(text)

    expect(parsed.ok).toBe(true)
    const restored = restoreProject(parsed.project!, fakeAtlas())

    expect(restored.targets).toEqual(original.targets)
    expect(restored.measurements).toEqual(original.measurements)
    expect(restored.objects[0]!.orientation).toEqual({
      apTiltDeg: 12,
      mlTiltDeg: -5,
      rollDeg: 0,
    })
    expect(restored.objects[0]!.target).toEqual({ ap: -2, ml: 1.5, dv: -1.35 })
    expect(restored.anatomy.visibleStructureIds).toEqual([382, 672])
  })

  it('survives a second round trip unchanged', () => {
    const once = serialiseProject(snapshot())
    const twice = parseProject(JSON.stringify(once)).project!
    // Everything but the modified stamp must be identical.
    expect({ ...twice, metadata: { ...twice.metadata, modified: '' } }).toEqual({
      ...once,
      metadata: { ...once.metadata, modified: '' },
    })
  })
})

describe('validation', () => {
  it('rejects text that is not JSON', () => {
    const result = parseProject('{ not json')
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/not valid json/i)
  })

  it('rejects a file that is not a BrainCAD project', () => {
    const result = parseProject(JSON.stringify({ hello: 'world' }))
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('names the offending field rather than failing opaquely', () => {
    const file = serialiseProject(snapshot()) as unknown as Record<string, unknown>
    ;(file.targets as { coord: { ap: unknown } }[])[0]!.coord.ap = 'not a number'

    const result = parseProject(JSON.stringify(file))
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain('targets.0.coord.ap')
  })

  it('rejects a non-finite coordinate rather than loading NaN', () => {
    // JSON has no NaN, but a hand-edited file can carry a string that parses to
    // one, and a target at NaN would render nowhere while reading as valid.
    const file = serialiseProject(snapshot()) as unknown as Record<string, unknown>
    ;(file.targets as { coord: { dv: unknown } }[])[0]!.coord.dv = null

    expect(parseProject(JSON.stringify(file)).ok).toBe(false)
  })

  it('warns, but still loads, when the file is from a newer format', () => {
    const file = serialiseProject(snapshot())
    const result = parseProject(JSON.stringify({ ...file, version: 99 }))

    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/newer version/i)
  })

  it('warns that imported geometry is not stored in the file', () => {
    const custom = makeObject('object-2', 'custom', { ap: 0, ml: 0, dv: 0 })
    custom.source = {
      filename: 'headplate.stl',
      format: 'stl',
      unit: 'mm',
      scale: 1,
      origin: 'file',
      triangleCount: 2048,
    }
    const file = serialiseProject(snapshot({ objects: [custom] }))
    const result = parseProject(JSON.stringify(file))

    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toContain('headplate.stl')
  })

  it('warns when a plan uses a convention-based bregma', () => {
    const result = parseProject(JSON.stringify(serialiseProject(snapshot())))
    expect(result.warnings.join(' ')).toMatch(/community convention/i)
  })
})

describe('coordinate profile safety on load', () => {
  it('accepts a profile that matches the loaded atlas', () => {
    const file = parseProject(JSON.stringify(serialiseProject(snapshot()))).project!
    const restored = restoreProject(file, fakeAtlas())

    expect(restored.profileId).toBe(ALLEN_CCFV3_50UM.id)
    expect(restored.warnings.filter((w) => /volume/i.test(w))).toHaveLength(0)
  })

  it('refuses to apply a profile that describes a different volume', () => {
    // Exactly the template-space mismatch the guard exists to prevent: the
    // coordinates would look plausible and be wrong by millimetres.
    const file = parseProject(
      JSON.stringify(serialiseProject(snapshot({ profile: PERENS_STEREOTAXIC_MRI }))),
    ).project!

    const restored = restoreProject(file, fakeAtlas([264, 160, 228]))
    expect(restored.profileId).toBe('')
    expect(restored.warnings.join(' ')).toMatch(/do not.*trust/i)
  })

  it('warns when a saved bregma differs from the current profile', () => {
    const file = parseProject(JSON.stringify(serialiseProject(snapshot()))).project!
    file.coordinateProfile.bregma.i0 = 120 // lab-calibrated elsewhere

    const restored = restoreProject(file, fakeAtlas())
    expect(restored.warnings.join(' ')).toMatch(/differs from the current/i)
  })

  it('handles a profile id this build has never heard of', () => {
    const file = parseProject(JSON.stringify(serialiseProject(snapshot()))).project!
    file.coordinateProfile.id = 'some-lab-custom-profile'

    const restored = restoreProject(file, fakeAtlas())
    expect(restored.profileId).toBe('')
    expect(restored.warnings.join(' ')).toMatch(/unknown coordinate profile/i)
  })
})

describe('projectFilename', () => {
  it('slugs a plan name', () => {
    expect(projectFilename('CA1 prism implant')).toBe('ca1-prism-implant.braincad.json')
  })

  it('falls back when a name has nothing usable in it', () => {
    expect(projectFilename('  ***  ')).toBe('plan.braincad.json')
  })
})
