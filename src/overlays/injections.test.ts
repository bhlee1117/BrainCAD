/**
 * The injection-site layer, which is the second brain's control.
 *
 * Its one job is to put every needle on one side of the brain so the other
 * side is free for the back-trace. If it mirrored the wrong way the dots would
 * land on top of the colours they exist to qualify, which is exactly the
 * confusion the split was introduced to end.
 */

import { describe, expect, it } from 'vitest'

import { getProfile, DEFAULT_PROFILE_ID } from '../atlas/profile.ts'
import {
  INJECTION_CAVEATS,
  injectionSitesToStereotaxic,
  type InjectionSites,
} from './injections.ts'
import { stereotaxicToVoxel } from '../atlas/coords.ts'

const PROFILE = getProfile(DEFAULT_PROFILE_ID)!

/** A site built from the coordinate it should come back as. */
function siteAt(ap: number, ml: number, dv: number): number[] {
  const voxel = stereotaxicToVoxel(PROFILE, { ap, ml, dv })
  const um = PROFILE.space.resolutionUm
  return [voxel.i0 * um, voxel.i1 * um, voxel.i2 * um]
}

function sites(...coords: number[][]): InjectionSites {
  return {
    generatedAt: '2026-10-28T00:00:00.000Z',
    products: [5],
    corpus: 'test',
    count: coords.length,
    injectedRight: 0,
    note: 'test',
    source: 'test',
    coordinatesUm: coords.flat(),
  }
}

describe('injectionSitesToStereotaxic', () => {
  it('leaves a right-hemisphere injection where it is', () => {
    const [site] = injectionSitesToStereotaxic(sites(siteAt(-2, 1.5, -1.35)), PROFILE)
    expect(site!.ml).toBeCloseTo(1.5, 5)
    expect(site!.ap).toBeCloseTo(-2, 5)
    expect(site!.dv).toBeCloseTo(-1.35, 5)
  })

  it('mirrors a left-hemisphere injection onto the right', () => {
    // The whole point: the left half belongs to the back-trace, whose own
    // sources are all on the left under the default side filter.
    const [site] = injectionSitesToStereotaxic(sites(siteAt(-2, -1.5, -1.35)), PROFILE)
    expect(site!.ml).toBeCloseTo(1.5, 5)
    // AP and DV are untouched, so the dot still marks the place it describes.
    expect(site!.ap).toBeCloseTo(-2, 5)
    expect(site!.dv).toBeCloseTo(-1.35, 5)
  })

  it('never returns negative zero for a midline injection', () => {
    // Harmless in arithmetic, surprising everywhere it is printed or compared.
    const [site] = injectionSitesToStereotaxic(sites(siteAt(-2, 0, -1.35)), PROFILE)
    expect(Object.is(site!.ml, -0)).toBe(false)
  })

  it('puts every site on the right, whichever side it came from', () => {
    const all = injectionSitesToStereotaxic(
      sites(siteAt(0, -3, -2), siteAt(1, 2, -1), siteAt(-1, -0.4, -3), siteAt(2, 4, -4)),
      PROFILE,
    )
    expect(all).toHaveLength(4)
    for (const site of all) expect(site.ml).toBeGreaterThanOrEqual(0)
  })

  it('ignores a trailing partial triple rather than reading past the end', () => {
    const ragged = sites(siteAt(0, 1, -1))
    const [site, ...rest] = injectionSitesToStereotaxic(
      { ...ragged, coordinatesUm: [...ragged.coordinatesUm, 100, 200] },
      PROFILE,
    )
    expect(site!.ml).toBeCloseTo(1, 5)
    expect(rest).toHaveLength(0)
  })

  it('says that an unsampled region is not the same as a silent one', () => {
    // The claim the layer exists to make, kept where it is shown.
    expect(INJECTION_CAVEATS.join(' ')).toMatch(/never injected/i)
  })
})
