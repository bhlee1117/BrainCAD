/**
 * Planning-sheet tests.
 *
 * The sheet is the artefact that leaves the application — printed, filed,
 * handed to someone else. So these check that the things which must never be
 * lost in translation survive: the safety notice, the coordinate provenance,
 * and an honest account of collision state.
 */

import { describe, expect, it } from 'vitest'

import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import { DEFAULT_COLLISION_SETTINGS, checkScene } from '../collision/check.ts'
import { makeObject } from '../objects/model.ts'
import type { SceneCollisionReport } from '../collision/check.ts'
import { renderPlanningSheet, sheetFilename, type SheetInput } from './sheet.ts'
import { serialiseProject } from './project.ts'
import type { LoadedAtlas } from '../atlas/load.ts'

function fakeAtlas(): LoadedAtlas {
  return {
    manifest: {
      generatedAt: '2026-09-13T00:00:00.000Z',
      annotation: {
        file: 'annotation_50.nrrd',
        bytes: 880845,
        sha256: 'abcdef0123456789',
        resolutionUm: 50,
        orientation: 'asr',
        source: 'https://example.invalid',
      },
      ontology: { file: 'structures.json', count: 1327, source: 'https://example.invalid' },
      meshes: [],
      lazyMeshBaseUrl: 'https://example.invalid',
      citation: 'Allen CCFv3; Wang et al. (2020).',
    },
    volume: null as never,
    space: ALLEN_CCFV3_50UM.space,
    structures: [],
    index: null as never,
    colors: new Map(),
  }
}

function sheetInput(overrides: Partial<SheetInput> = {}): SheetInput {
  const cannula = makeObject('object-1', 'cannula', { ap: -2, ml: 1.5, dv: -1.35 })
  cannula.orientation = { apTiltDeg: 12, mlTiltDeg: -5, rollDeg: 0 }

  const project = serialiseProject({
    name: 'CA1 prism implant',
    notes: 'Pilot animal 3',
    created: '2026-09-13T12:00:00.000Z',
    profile: ALLEN_CCFV3_50UM,
    atlas: fakeAtlas(),
    anatomy: { showBrain: true, brainOpacity: 0.2, visibleStructureIds: [] },
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
        id: 'm1',
        name: 'Tip to surface',
        a: { coord: { ap: -2, ml: 1.5, dv: -1.35 }, snap: 'target', snappedTo: 'Dorsal CA1' },
        b: { coord: { ap: -2, ml: 1.5, dv: 0.4 }, snap: 'mesh-surface', snappedTo: 'Brain' },
        kind: 'euclidean',
        visible: true,
      },
    ],
    collisionSettings: { ...DEFAULT_COLLISION_SETTINGS },
  })

  return {
    project,
    objects: [cannula],
    measurements: [
      {
        id: 'm1',
        name: 'Tip to surface',
        a: { coord: { ap: -2, ml: 1.5, dv: -1.35 }, snap: 'target', snappedTo: 'Dorsal CA1' },
        b: { coord: { ap: -2, ml: 1.5, dv: 0.4 }, snap: 'mesh-surface', snappedTo: 'Brain' },
        kind: 'euclidean',
        visible: true,
      },
    ],
    collision: checkScene([], DEFAULT_COLLISION_SETTINGS),
    screenshot: null,
    objectiveViews: [],
    targetRegions: { 'target-1': 'CA1' },
    ...overrides,
  }
}

describe('planning sheet', () => {
  it('is a complete standalone HTML document', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
    // No external resources: it must still render years from now, offline.
    expect(html).not.toMatch(/<script|<link[^>]+href=/i)
  })

  it('carries the safety notice', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html).toContain('Research planning tool')
    expect(html).toContain('averaged reference brain')
    expect(html).toContain('not a guarantee of surgical success')
  })

  it('states the coordinate provenance and its confidence', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html).toContain('Allen CCFv3 (50 µm, community bregma)')
    expect(html).toContain('community-convention')
    expect(html).toContain('bregma plane')
  })

  it('lists targets with coordinates and region', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html).toContain('Dorsal CA1')
    expect(html).toContain('-2.00')
    expect(html).toContain('+1.50')
    expect(html).toContain('>CA1<')
  })

  it('lists objects with their angles and obliquity', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html).toContain('Cannula')
    expect(html).toContain('+12.0')
    expect(html).toContain('-5.0')
    // sqrt-combined tilt of 12 and -5 degrees.
    expect(html).toContain('13.0°')
  })

  it('reports measurements in both units with their kind', () => {
    const html = renderPlanningSheet(sheetInput())
    expect(html).toContain('Tip to surface')
    expect(html).toContain('1.750') // mm
    expect(html).toContain('1750') // µm
    expect(html).toContain('Straight line')
  })

  it('says plainly when collision checking was not run', () => {
    // Silence here would read as "no collisions", which is not what it means.
    const html = renderPlanningSheet(sheetInput({ collision: null }))
    expect(html).toContain('was not run')
    expect(html).toContain('not a statement that the plan is clear')
  })

  it('shouts when there is a collision', () => {
    const collision = {
      pairs: [
        {
          aId: 'a',
          bId: 'b',
          aLabel: 'Objective',
          bLabel: 'Headbar',
          involvesAnatomy: false,
          state: 'collision' as const,
          clearanceMm: null,
          pointA: null,
          pointB: null,
        },
      ],
      worst: 'collision' as const,
      minClearanceMm: null,
      limiting: null,
      checkedPairs: 1,
      elapsedMs: 1,
    } satisfies SceneCollisionReport

    const html = renderPlanningSheet(sheetInput({ collision }))
    expect(html).toContain('COLLISION DETECTED')
    expect(html).toContain('Objective ↔ Headbar')
  })

  it('escapes user text rather than injecting it as markup', () => {
    const input = sheetInput()
    const html = renderPlanningSheet({
      ...input,
      project: {
        ...input.project,
        metadata: { ...input.project.metadata, name: '<img src=x onerror=alert(1)>' },
      },
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('embeds a screenshot when one was captured', () => {
    const html = renderPlanningSheet(
      sheetInput({ screenshot: 'data:image/png;base64,iVBORw0KGgo=' }),
    )
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(html).toContain('class="capture"')
  })

  it('omits the scene section entirely when there is no screenshot', () => {
    expect(renderPlanningSheet(sheetInput())).not.toContain('class="capture"')
  })

  it('omits the objective-view section when there are no objectives', () => {
    expect(renderPlanningSheet(sheetInput())).not.toContain('View through the objective')
  })

  it('renders a view for each objective, with its field and working distance', () => {
    const html = renderPlanningSheet(
      sheetInput({
        objectiveViews: [
          {
            name: '16x Nikon',
            dataUrl: 'data:image/png;base64,AAAA',
            fieldOfViewMm: 0.85,
            workingDistanceMm: 3,
          },
        ],
      }),
    )
    expect(html).toContain('View through the objective')
    expect(html).toContain('16x Nikon')
    expect(html).toContain('0.85 mm field')
    expect(html).toContain('3.0 mm working distance')
    expect(html).toContain('data:image/png;base64,AAAA')
  })

  it('states plainly that the objective view is not an optical simulation', () => {
    // The image looks like a micrograph. Without this it would be read as one.
    const html = renderPlanningSheet(
      sheetInput({
        objectiveViews: [
          {
            name: 'Objective',
            dataUrl: 'data:image/png;base64,AAAA',
            fieldOfViewMm: 1,
            workingDistanceMm: 3,
          },
        ],
      }),
    )
    expect(html).toContain('Geometric occlusion only')
    expect(html).toContain('Not an optical simulation')
    expect(html).toMatch(/scattering, aberration, depth of field/)
  })
})

describe('sheetFilename', () => {
  it('slugs the plan name', () => {
    expect(sheetFilename('CA1 prism implant')).toBe('ca1-prism-implant-planning-sheet.html')
  })

  it('falls back for an unusable name', () => {
    expect(sheetFilename('///')).toBe('plan-planning-sheet.html')
  })
})
