/**
 * End-to-end validation against the real Allen CCFv3 assets.
 *
 * The unit tests prove the arithmetic is self-consistent. This file proves the
 * arithmetic is pointed at the right anatomy: it loads the actual annotation
 * volume and ontology from `public/atlas/` and checks that published
 * stereotaxic coordinates land in the structures they are published for.
 *
 * This is the check that would catch an axis swap, a sign flip, or a wrong
 * bregma — none of which any self-consistency test can detect.
 *
 * Skips itself (rather than failing) when the assets have not been built, so a
 * fresh clone can run `npm test` before `npm run atlas:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AnnotationVolume, UNLABELLED } from './annotation.ts'
import { stereotaxicToVoxel, type Stereotaxic } from './coords.ts'
import { parseNrrd } from './nrrd.ts'
import { buildIndex, isDescendantOf, type Structure } from './ontology.ts'
import { ALLEN_CCFV3_50UM, assertProfileMatchesSpace } from './profile.ts'
import { makeVolumeSpace } from './space.ts'

const ATLAS_DIR = join(process.cwd(), 'public', 'atlas')
const ANNOTATION_PATH = join(ATLAS_DIR, 'annotation_50.nrrd')
const STRUCTURES_PATH = join(ATLAS_DIR, 'structures.json')

const assetsBuilt = existsSync(ANNOTATION_PATH) && existsSync(STRUCTURES_PATH)

describe.skipIf(!assetsBuilt)('real Allen CCFv3 assets', () => {
  const nrrd = parseNrrd(readFileSync(ANNOTATION_PATH))
  const space = makeVolumeSpace(nrrd.shape, 50, 'asr')
  const labels =
    nrrd.data instanceof Uint32Array
      ? nrrd.data
      : Uint32Array.from(nrrd.data as ArrayLike<number>)
  const volume = new AnnotationVolume(space, labels)

  const structures = JSON.parse(readFileSync(STRUCTURES_PATH, 'utf8')) as Structure[]
  const index = buildIndex(structures)
  const profile = ALLEN_CCFV3_50UM

  /** Resolve a stereotaxic coordinate to its structure acronym. */
  function regionAt(coord: Stereotaxic): { id: number; acronym: string } {
    const id = volume.labelAt(profile, coord)
    return { id, acronym: index.byId.get(id)?.acronym ?? '(unlabelled)' }
  }

  it('parses the published volume geometry', () => {
    expect(nrrd.shape).toEqual([264, 160, 228])
    expect(nrrd.type).toBe('uint32')
    expect(nrrd.spacing).toEqual([50, 50, 50])
  })

  it('pairs with the Allen coordinate profile', () => {
    expect(() => assertProfileMatchesSpace(profile, space)).not.toThrow()
  })

  it('loads the full structure ontology as a single-rooted tree', () => {
    expect(structures.length).toBeGreaterThan(1000)
    expect(structures.filter((s) => s.parentId === null)).toHaveLength(1)
    expect(index.root!.acronym).toBe('root')
    expect(index.byAcronym.get('ca1')).toBeDefined()
    expect(index.byAcronym.get('vta')).toBeDefined()
  })

  it('finds labelled tissue at the centre of the brain', () => {
    // A point well inside the brain must be annotated, whatever it is.
    const centre = regionAt({ ap: -2.0, ml: 0.5, dv: -3.0 })
    expect(centre.id).not.toBe(UNLABELLED)
  })

  it('reports empty space well outside the brain', () => {
    // 8 mm lateral is far outside an ~11 mm-wide brain.
    expect(volume.labelAt(profile, { ap: 0, ml: 8, dv: -1 })).toBe(UNLABELLED)
    // 10 mm above bregma is in open air.
    expect(volume.labelAt(profile, { ap: 0, ml: 0, dv: 10 })).toBe(UNLABELLED)
  })

  it('places a published dorsal CA1 coordinate in the hippocampal formation', () => {
    // AP -2.0, ML 1.5, DV -1.35 is a standard dorsal CA1 injection site.
    const region = regionAt({ ap: -2.0, ml: 1.5, dv: -1.35 })
    const HPF = index.byAcronym.get('hpf')!
    expect(
      isDescendantOf(index, region.id, HPF.id),
      `expected hippocampal formation at dorsal CA1 coordinates, got ${region.acronym}`,
    ).toBe(true)
  })

  it('places a published dorsal striatum coordinate in the caudoputamen', () => {
    // AP +0.5, ML 2.0, DV -3.0 is a standard dorsal striatum target.
    const region = regionAt({ ap: 0.5, ml: 2.0, dv: -3.0 })
    const CP = index.byAcronym.get('cp')!
    expect(
      isDescendantOf(index, region.id, CP.id),
      `expected caudoputamen at dorsal striatum coordinates, got ${region.acronym}`,
    ).toBe(true)
  })

  it('places a published VTA coordinate in the midbrain', () => {
    // AP -3.2, ML 0.5, DV -4.4 targets VTA.
    const region = regionAt({ ap: -3.2, ml: 0.5, dv: -4.4 })
    const MB = index.byAcronym.get('mb')!
    expect(
      isDescendantOf(index, region.id, MB.id),
      `expected midbrain at VTA coordinates, got ${region.acronym}`,
    ).toBe(true)
  })

  it('places a barrel cortex coordinate in the isocortex', () => {
    // AP -1.0, ML 3.0, DV -1.0 is barrel cortex layer 2/3.
    const region = regionAt({ ap: -1.0, ml: 3.0, dv: -1.0 })
    const isocortex = index.byAcronym.get('isocortex')!
    expect(
      isDescendantOf(index, region.id, isocortex.id),
      `expected isocortex at barrel cortex coordinates, got ${region.acronym}`,
    ).toBe(true)
    expect(region.acronym).toMatch(/^SSp-bfd/)
  })

  it('resolves cortical layers in order with increasing depth', () => {
    // Depth ordering is a strong check on the DV axis: layers must appear
    // superficial-to-deep, not shuffled or reversed.
    const column = [-1.0, -1.5, -2.0].map((dv) => regionAt({ ap: -1.0, ml: 3.0, dv }).acronym)
    expect(column).toEqual(['SSp-bfd2/3', 'SSp-bfd5', 'SSp-bfd6a'])
  })

  it('shows that DV referenced to bregma is not DV referenced to the pia', () => {
    // The profile's dvReference is 'bregma-plane'. At this lateral position the
    // brain surface is 0.62 mm below the bregma plane, so a coordinate quoted
    // as "0.5 mm deep from the surface" is in open space when read as
    // bregma-referenced. BrainCAD must never silently conflate the two.
    expect(profile.dvReference).toBe('bregma-plane')
    expect(volume.labelAt(profile, { ap: -1.0, ml: 3.0, dv: -0.5 })).toBe(UNLABELLED)

    const surface = volume.firstLabelledPoint(
      profile,
      { ap: -1.0, ml: 3.0, dv: 3.0 },
      { ap: -1.0, ml: 3.0, dv: -2.0 },
    )
    expect(surface).not.toBeNull()
    expect(surface!.coord.dv).toBeCloseTo(-0.62, 1)
  })

  it('finds the same structure in both hemispheres', () => {
    // Confirms the ML axis is centred: mirroring ML must hit the same structure.
    const right = regionAt({ ap: -2.0, ml: 1.5, dv: -1.35 })
    const left = regionAt({ ap: -2.0, ml: -1.5, dv: -1.35 })
    expect(left.acronym).toBe(right.acronym)
  })

  it('detects the brain surface above a cortical target', () => {
    // Descending from well above the skull must enter the brain before the target.
    const target: Stereotaxic = { ap: -1.0, ml: 3.0, dv: -1.0 }
    const above: Stereotaxic = { ...target, dv: 5.0 }
    const entry = volume.firstLabelledPoint(profile, above, target)

    expect(entry).not.toBeNull()
    expect(entry!.coord.dv).toBeGreaterThan(target.dv)
    expect(entry!.coord.dv).toBeLessThan(above.dv)
  })

  it('lists structures crossed by a vertical trajectory to CA1', () => {
    const target: Stereotaxic = { ap: -2.0, ml: 1.5, dv: -1.35 }
    const runs = volume.structuresAlong(profile, { ...target, dv: 2.0 }, target)

    // Air first, then tissue; and the final structure is the target's.
    expect(runs[0]!.id).toBe(UNLABELLED)
    expect(runs.length).toBeGreaterThan(1)
    expect(runs[runs.length - 1]!.id).toBe(volume.labelAt(profile, target))
  })

  it('produces coronal slices with anatomy in them', () => {
    const voxel = stereotaxicToVoxel(profile, { ap: -2.0, ml: 0, dv: 0 })
    const slice = volume.extractSlice('AP', voxel.i0)

    expect(slice.width).toBe(228) // ML voxels
    expect(slice.height).toBe(160) // DV voxels

    const labelled = slice.labels.reduce((n, l) => (l === UNLABELLED ? n : n + 1), 0)
    // A mid-brain coronal slice should be substantially filled with tissue.
    expect(labelled).toBeGreaterThan(slice.labels.length * 0.1)
  })
})
