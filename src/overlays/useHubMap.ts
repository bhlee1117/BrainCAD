/**
 * Feeding the second brain.
 *
 * Two different things end up on one canvas, and the difference is the point:
 *
 *  - **Regions** paint the convergence matrix, which is a property of the
 *    Allen connectome and does *not* move when the target moves. That is what
 *    makes it a hub map rather than a second view of the back-trace.
 *  - **Routes** draw the traced paths into the current target, which do.
 *
 * Keeping both here, rather than in the canvas, means the matrix is fetched
 * once and the voxel walk runs when the metric changes instead of every frame.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { ColorTable } from '../atlas/ontology.ts'
import type { BacktraceState } from '../state/store.ts'
import {
  convergenceStrengths,
  formatConvergence,
  loadConvergenceMatrix,
  type ConvergenceMatrix,
} from './convergence.ts'
import {
  buildRetrogradeHeatmap,
  buildStrengthColorTable,
  type RetrogradeHeatmap,
} from './heatmap.ts'
import {
  retrogradeMatrix,
  visibleSources,
  type RetrogradeSource,
} from './retrograde.ts'

export interface HubMatrixState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly matrix: ConvergenceMatrix | null
  readonly message: string
}

/**
 * Load the bundled convergence matrix, once, on first use.
 *
 * Deliberately not loaded with the atlas: it is a few hundred kilobytes that
 * only the hub map needs, and most sessions never open it.
 */
export function useConvergenceMatrix(enabled: boolean): HubMatrixState {
  const [state, setState] = useState<HubMatrixState>({
    status: 'idle',
    matrix: null,
    message: '',
  })

  // A ref, not the status, because the status is what this effect sets. Keyed
  // on `state.status` the effect re-ran the moment it wrote "loading", and the
  // cleanup from that first run marked the in-flight load dead — so the
  // promise resolved into nothing and the caption sat on "Loading…" forever.
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true

    let live = true
    setState({ status: 'loading', matrix: null, message: 'Loading connectome matrix…' })

    loadConvergenceMatrix()
      .then((matrix) => {
        if (live) setState({ status: 'ready', matrix, message: '' })
      })
      .catch((error: unknown) => {
        // Cleared so closing and reopening the map tries again; the module's
        // own cache does not keep a failure either.
        started.current = false
        if (!live) return
        setState({
          status: 'error',
          matrix: null,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      live = false
    }
  }, [enabled])

  return state
}

/**
 * The painted brain, from the convergence matrix.
 *
 * Depends on the metric and the threshold and on nothing about the target —
 * which is the whole claim this view makes, and is worth being able to read
 * off the dependency list.
 */
export function useHubHeatmap(
  atlas: LoadedAtlas | null,
  matrix: ConvergenceMatrix | null,
  metric: BacktraceState['heatMetric'],
  threshold: number,
): RetrogradeHeatmap | null {
  return useMemo(() => {
    if (!atlas || !matrix) return null
    const strengths = convergenceStrengths(matrix, metric, threshold)
    if (strengths.size === 0) return null
    return buildRetrogradeHeatmap(atlas.volume, atlas.index, strengths)
  }, [atlas, matrix, metric, threshold])
}

export interface SectionHubColors {
  readonly colors: ColorTable
  readonly caption: string
}

/**
 * The hub map as a slice colour table.
 *
 * Built from the same strengths and the same ramp as the 3D cloud, so the two
 * surfaces are two drawings of one answer rather than two answers. The range
 * is taken over every structure that has a value — not over the ones that
 * happen to appear in the current slice — or the colours would shift under the
 * reader every time the target moved to a section with a different mix of
 * regions, which looks exactly like the data changing.
 */
export function useSectionHubColors(
  atlas: LoadedAtlas | null,
  matrix: ConvergenceMatrix | null,
  metric: BacktraceState['heatMetric'],
  threshold: number,
): SectionHubColors | null {
  return useMemo(() => {
    if (!atlas || !matrix) return null

    const strengths = convergenceStrengths(matrix, metric, threshold)
    if (strengths.size === 0) return null

    const values = [...strengths.values()]
    const range = { min: Math.min(...values), max: Math.max(...values) }

    return {
      colors: buildStrengthColorTable(atlas.index, strengths, range),
      caption:
        `Sections coloured by convergence · ${metric} · ` +
        `${formatConvergence(metric, range.min)} → ${formatConvergence(metric, range.max)} · ` +
        `grey is unmeasured · independent of the target`,
    }
  }, [atlas, matrix, metric, threshold])
}

/**
 * Which traced sources the routes mode draws.
 *
 * Reads the same filters as the panel's list, so the routes on screen are the
 * experiments the table is describing.
 */
export function useHeatmapSources(backtrace: BacktraceState): RetrogradeSource[] {
  const { sources, heatAllSources, includeOverlapping, topStructures } = backtrace

  return useMemo(() => {
    if (heatAllSources) {
      return sources.filter((s) => includeOverlapping || !s.targetInsideInjection)
    }
    return visibleSources(sources, {
      includeOverlapping,
      topStructures,
      focusAbbrev: null,
    })
  }, [sources, heatAllSources, includeOverlapping, topStructures])
}

/**
 * The caption under the second brain.
 *
 * Says what the brightest colour stands for, because the ramp is normalised
 * against the strongest value present rather than against a fixed scale — and
 * in regions mode it says plainly that the map is of the connectome, so a
 * reader who arrived at this view by moving a target is not left to assume it
 * followed them.
 */
export function describeHubMap(
  backtrace: BacktraceState,
  matrixState: HubMatrixState,
  heatmap: RetrogradeHeatmap | null,
  routeCount: number,
): string {
  if (backtrace.heatMode === 'routes') {
    if (backtrace.status === 'loading') return 'Tracing…'
    if (routeCount === 0) return 'No traced routes yet — trace a target first.'
    const scope = backtrace.heatAllSources
      ? 'all sources'
      : `top ${backtrace.topStructures} structures`
    return `Traced routes into the target · coloured by strength · ${scope}`
  }

  if (matrixState.status === 'loading') return matrixState.message
  if (matrixState.status === 'error') return matrixState.message
  if (!heatmap || heatmap.pointCount === 0) return 'No connectome matrix loaded.'

  const metric = backtrace.heatMetric
  return (
    `Convergence across the whole connectome · ${metric} · ` +
    `${formatConvergence(metric, heatmap.minStrength)} → ` +
    `${formatConvergence(metric, heatmap.maxStrength)} across ` +
    `${heatmap.paintedStructureIds.length} regions · independent of the target`
  )
}

export { retrogradeMatrix }
