/**
 * Where every needle in the corpus went.
 *
 * The second brain's colours say how hard each region drives the target. They
 * cannot say anything about a region that is dark, because dark has two
 * meanings — nothing projects from there, or nobody ever injected there — and
 * they look identical. This layer separates them: a dark region with no dots
 * in it is a gap in the Allen dataset, not a finding about the brain.
 *
 * Built by `scripts/fetch-injection-sites.mjs` and bundled as 45 KB, which is
 * small enough to load alongside the view rather than behind a control.
 */

import { voxelToStereotaxic, type Stereotaxic } from '../atlas/coords.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { connectivityUrl } from './convergence.ts'

export interface InjectionSites {
  readonly generatedAt: string
  readonly products: readonly number[]
  readonly corpus: string
  readonly count: number
  readonly injectedRight: number
  readonly note: string
  readonly source: string
  /** Flat `[x, y, z]` triples in CCF micrometres. */
  readonly coordinatesUm: readonly number[]
}

let pending: Promise<InjectionSites> | null = null

export function loadInjectionSites(): Promise<InjectionSites> {
  if (!pending) {
    pending = (async () => {
      const response = await fetch(connectivityUrl('injections.json'), {
        cache: 'no-cache',
      })
      if (!response.ok) {
        throw new Error(
          `Injection sites not available (HTTP ${response.status}). ` +
            `Build them with \`npm run injections:fetch\`.`,
        )
      }
      return (await response.json()) as InjectionSites
    })()
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}

/** Forget the cached list. For tests. */
export function clearInjectionSitesCache(): void {
  pending = null
}

/**
 * The sites as stereotaxic coordinates, all on one side.
 *
 * Mirrored onto the **right**, which is the screen's injected hemisphere and
 * where 75% of them already were. That puts them on the same side as the
 * back-trace's own sources, which the side filter also keeps right-injected —
 * and the overlap is the point rather than a collision. The coloured regions
 * are a *subset* of these dots: the experiments that happen to reach this
 * target, drawn among every experiment there is. A coloured region sitting in
 * a dense patch of grey was found by many needles; one sitting almost alone
 * rests on a single experiment, and a dark patch of grey was sampled and found
 * nothing.
 *
 * Mirroring is honest here for the same reason it is in the hub map — the
 * corpus is a set of experiments, not an animal, and which hemisphere each was
 * injected into is a fact about the method.
 *
 * Done through the profile rather than on the raw micrometres so the dots
 * follow the active coordinate profile, like everything else on screen.
 */
export function injectionSitesToStereotaxic(
  sites: InjectionSites,
  profile: CoordinateProfile,
): Stereotaxic[] {
  const resolution = profile.space.resolutionUm
  const out: Stereotaxic[] = []

  for (let i = 0; i + 2 < sites.coordinatesUm.length; i += 3) {
    const coord = voxelToStereotaxic(profile, {
      i0: sites.coordinatesUm[i]! / resolution,
      i1: sites.coordinatesUm[i + 1]! / resolution,
      i2: sites.coordinatesUm[i + 2]! / resolution,
    })
    // Negating zero gives -0, which is harmless in arithmetic and surprising
    // everywhere it is printed or compared.
    out.push(coord.ml >= 0 ? coord : { ...coord, ml: coord.ml === 0 ? 0 : -coord.ml })
  }

  return out
}

/** Carried wherever the dots are shown. */
export const INJECTION_CAVEATS: readonly string[] = [
  'One dot per experiment, at its reported injection centre — a point standing for a ' +
    'volume that is longer along the pipette track than it is wide.',
  'All mirrored onto the right, the side the sources are drawn on.',
  'A dark region with no dots was never injected, which is not the same as not ' +
    'projecting to the target.',
]
