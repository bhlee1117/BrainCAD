/**
 * Building the heat map from whatever the back-trace currently holds.
 *
 * A hook rather than a call inside the canvas, because the walk over the
 * annotation volume is tens of milliseconds of synchronous arithmetic and must
 * not run on every frame — it runs when the sources, the metric or the filters
 * change, and never otherwise.
 */

import { useMemo } from 'react'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { BacktraceState } from '../state/store.ts'
import {
  buildRetrogradeHeatmap,
  strengthByStructure,
  type RetrogradeHeatmap,
} from './heatmap.ts'
import {
  retrogradeMatrix,
  visibleSources,
  type RetrogradeSource,
} from './retrograde.ts'

/**
 * Which sources the heat map is built from.
 *
 * Separate from the list's filter on purpose. The list is ranked and truncated
 * so it can be read; the map is looking for hubs, and a region that is a hub
 * because many middling experiments reach it is exactly what a top-N cut
 * removes. So `heatAllSources` defaults on and the panel says which it used.
 */
export function heatmapSources(backtrace: BacktraceState) {
  if (backtrace.heatAllSources) {
    return backtrace.sources.filter(
      (s) => backtrace.includeOverlapping || !s.targetInsideInjection,
    )
  }
  return visibleSources(backtrace.sources, {
    includeOverlapping: backtrace.includeOverlapping,
    topStructures: backtrace.topStructures,
    focusAbbrev: null,
  })
}

/**
 * The same selection, memoised, for the routes mode.
 *
 * Both modes read one selection so the two pictures are of the same set of
 * experiments — switching the checkbox should change how the answer is drawn,
 * never which answer it is.
 */
export function useHeatmapSources(backtrace: BacktraceState): RetrogradeSource[] {
  const { sources, heatAllSources, includeOverlapping, topStructures } = backtrace

  return useMemo(
    () => heatmapSources(backtrace),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, heatAllSources, includeOverlapping, topStructures],
  )
}

export function useRetrogradeHeatmap(
  atlas: LoadedAtlas | null,
  backtrace: BacktraceState,
): RetrogradeHeatmap | null {
  const sources = backtrace.sources
  const { heatMetric, heatAllSources, includeOverlapping, topStructures, showHeatmap } =
    backtrace

  return useMemo(() => {
    if (!atlas || !showHeatmap || sources.length === 0) return null

    const selected = heatmapSources({
      ...backtrace,
      sources,
      heatAllSources,
      includeOverlapping,
      topStructures,
    })
    if (selected.length === 0) return null

    const strengths = strengthByStructure(retrogradeMatrix(selected), heatMetric)
    return buildRetrogradeHeatmap(atlas.volume, atlas.index, strengths)
    // `backtrace` is spread into the helper but only these fields change the
    // result; listing the object itself would rebuild on every status tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    atlas,
    showHeatmap,
    sources,
    heatMetric,
    heatAllSources,
    includeOverlapping,
    topStructures,
  ])
}

/**
 * The caption under the heat map.
 *
 * Says what the brightest colour stands for, because the ramp is normalised
 * against the strongest value present rather than against 1.0 — without the
 * number, two targets with hugely different input strengths produce two
 * identical-looking maps.
 */
export function describeHeatmap(
  backtrace: BacktraceState,
  heatmap: RetrogradeHeatmap | null,
): string {
  if (backtrace.status === 'loading') return 'Tracing…'
  if (backtrace.sources.length === 0) return 'No sources yet — trace a target first.'
  if (backtrace.heatMode === 'regions' && (!heatmap || heatmap.pointCount === 0)) {
    return 'No region of the atlas matched a source.'
  }

  const scope = backtrace.heatAllSources
    ? 'all sources'
    : `top ${backtrace.topStructures} structures`
  if (backtrace.heatMode === 'routes') {
    return `Traced routes · coloured by strength at the target · ${scope}`
  }

  if (!heatmap) return 'No region of the atlas matched a source.'

  return (
    `Retrograde strength · ${backtrace.heatMetric} · ${scope} · ` +
    `brightest = ${heatmap.maxStrength.toFixed(3)} · ` +
    `${heatmap.paintedStructureIds.length} regions painted`
  )
}
