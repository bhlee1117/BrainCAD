/**
 * Validation of the back-trace against a real Allen response.
 *
 * The unit tests prove the parsing is self-consistent. This proves it is
 * pointed at the right anatomy, which no self-consistency test can: the seed
 * point is computed from a stereotaxic coordinate, and a swapped or flipped
 * axis would search a different part of the brain and come back with a
 * perfectly well-formed, perfectly confident list of the wrong regions.
 *
 * So the fixture is a real response, recorded against a coordinate whose
 * afferents are textbook. Dorsal CA1 is fed by CA3 (Schaffer collaterals),
 * entorhinal cortex (temporoammonic path), the subiculum, and the medial
 * septum / diagonal band. If the seed were wrong, those would not all be at
 * the top of the list together.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Stereotaxic } from '../atlas/coords.ts'
import { ALLEN_CCFV3_50UM } from '../atlas/profile.ts'
import {
  parseRetrogradeResponse,
  retrogradeMatrix,
  seedPointParam,
} from './retrograde.ts'

const FIXTURE = join(process.cwd(), 'test-fixtures', 'retrograde-ca1-dorsal.json')
const present = existsSync(FIXTURE)

interface Fixture {
  seedPoint: string
  seedStereotaxic: Stereotaxic
  profileId: string
  response: { success: boolean; msg: unknown[] }
}

describe.skipIf(!present)('real Allen back-trace at dorsal CA1', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
  const profile = ALLEN_CCFV3_50UM
  const target = fixture.seedStereotaxic

  const sources = parseRetrogradeResponse(profile, target, fixture.response, 100)
  const matrix = retrogradeMatrix(sources)
  const abbrevs = matrix.map((r) => r.abbrev)

  it('was recorded against the profile this build still uses', () => {
    expect(fixture.profileId).toBe(profile.id)
  })

  it('derives the seed the fixture was fetched with', () => {
    // The assertion that makes everything below meaningful: these sources are
    // the answer for this coordinate only if the app still computes this seed.
    expect(seedPointParam(profile, target)).toBe(fixture.seedPoint)
  })

  it('finds CA3 among the strongest inputs', () => {
    // The Schaffer collateral is the defining input to CA1. If it is missing,
    // the seed is not in CA1.
    expect(abbrevs.slice(0, 4)).toContain('CA3')
  })

  it('finds the rest of the hippocampal circuit', () => {
    // DG labels the trisynaptic loop; SUB is CA1's own output partner and
    // projects back. Both belong near the top for a hippocampal seed.
    expect(abbrevs).toContain('DG')
    expect(abbrevs).toContain('SUB')
  })

  it('finds the septal and entorhinal afferents', () => {
    // NDB is the diagonal band — the cholinergic/GABAergic septohippocampal
    // input — and ENTl is the lateral entorhinal temporoammonic path. These
    // two are the check that really discriminates: they are nowhere near the
    // hippocampus in space, so they could only appear if the seed is right.
    expect(abbrevs).toContain('NDB')
    expect(abbrevs).toContain('ENTl')
  })

  it('does not return a cortical or cerebellar region as the top input', () => {
    // The failure mode a swapped axis produces: a plausible list, for a
    // different place. Dorsal CA1's strongest source is hippocampal.
    expect(['CA1', 'CA3', 'DG', 'SUB']).toContain(abbrevs[0])
  })

  it('flags the experiments injected into the target itself', () => {
    // The top row of the real response is a CA1 injection at density 0.9999 —
    // the tracer sitting on the seed, not a projection to it. It has to carry
    // the tag, or it reads as the strongest input in the brain.
    const ca1 = matrix.find((r) => r.abbrev === 'CA1')
    expect(ca1).toBeDefined()
    expect(ca1!.peakDensity).toBeGreaterThan(0.9)
    expect(ca1!.overlappingCount).toBeGreaterThan(0)
  })

  it('does not flag the distant afferents as overlapping', () => {
    // The same rule must not swallow the inputs that matter most.
    const ndb = matrix.find((r) => r.abbrev === 'NDB')!
    expect(ndb.overlappingCount).toBe(0)
    expect(ndb.sources[0]!.injectionDistanceMm).toBeGreaterThan(3)
  })

  it('starts every path at the target it was traced from', () => {
    // The path is drawn as the route into the target. One that started
    // somewhere else would draw a line from nowhere.
    for (const source of sources.filter((s) => s.path.length > 0)) {
      const start = source.path[0]!.coord
      const offset = Math.hypot(
        start.ap - target.ap,
        start.ml - target.ml,
        start.dv - target.dv,
      )
      // Allen snaps the seed to its own 100 um projection grid, so the first
      // point can be up to half a grid step away on each axis.
      expect(offset).toBeLessThan(0.1)
    }
  })

  it('ends every path at its own injection site', () => {
    for (const source of sources.filter((s) => s.path.length > 1 && s.injectionCentre)) {
      const end = source.path[source.path.length - 1]!.coord
      const centre = source.injectionCentre!
      expect(Math.hypot(end.ap - centre.ap, end.ml - centre.ml, end.dv - centre.dv)).toBeLessThan(
        0.05,
      )
    }
  })

  it('keeps every source inside the brain', () => {
    // A coordinate conversion off by a factor or an axis would put injection
    // centres outside the 13.2 x 8.0 x 11.4 mm volume.
    for (const source of sources) {
      if (!source.injectionCentre) continue
      expect(Math.abs(source.injectionCentre.ap)).toBeLessThan(9)
      expect(Math.abs(source.injectionCentre.ml)).toBeLessThan(6)
      expect(source.injectionCentre.dv).toBeLessThan(1)
      expect(source.injectionCentre.dv).toBeGreaterThan(-9)
    }
  })

  it('puts the hippocampal sources in the same hemisphere as the target', () => {
    // The target is at ML +1.5. CA3 projects to CA1 bilaterally, but the
    // strongest experiment should be ipsilateral — a sign flip on ML would
    // make every one of them contralateral.
    const ca3 = matrix.find((r) => r.abbrev === 'CA3')!
    expect(ca3.sources[0]!.injectionCentre!.ml).toBeGreaterThan(0)
  })
})
