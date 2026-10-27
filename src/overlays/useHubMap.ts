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
import type { BacktraceState } from '../state/store.ts'
import {
  convergenceStrengths,
  formatConvergence,
  loadConvergenceMatrix,
  voxelSide,
  type ConvergenceMatrix,
  type Side,
} from './convergence.ts'
import {
  buildRetrogradeHeatmap,
  heatColor,
  strengthForStructure,
  type RetrogradeHeatmap,
} from './heatmap.ts'
import { UNLABELLED } from '../atlas/annotation.ts'
import {
  loadVoxelConvergence,
  valuesFor,
  voxelIndexFor,
  voxelRange,
  type VoxelConvergence,
  type VoxelRange,
} from './voxelConvergence.ts'
import type { VoxelPaint } from '../ui/SlicePanel.tsx'
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
      // Cleared here too, not only on failure. StrictMode mounts, unmounts and
      // mounts again in development: without this the first run claimed the
      // ref and had its result discarded by this very cleanup, and the second
      // run saw the ref already claimed and did nothing — so a component that
      // mounted with the map already enabled sat on "loading" forever, while
      // one that enabled it later worked. The load itself is cached at module
      // level, so running it again costs nothing.
      started.current = false
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
    const sided = convergenceStrengths(matrix, metric, threshold)
    if (sided.ipsi.size === 0 && sided.contra.size === 0) return null
    return buildRetrogradeHeatmap(atlas.volume, atlas.index, sided)
  }, [atlas, matrix, metric, threshold])
}

export interface SectionPaint {
  readonly paint: VoxelPaint
  readonly caption: string
}

/**
 * The structure map as a per-pixel paint source.
 *
 * It used to be a structure-id colour table, which is how the slice renderer
 * had always worked and stopped being expressible the moment a structure's
 * value came to depend on which half of the brain the pixel is in. Both grains
 * now take the same path — ask a pixel which voxel it is, then look that voxel
 * up — so the two are drawn by one piece of code and cannot drift.
 */
export function useSectionHubPaint(
  atlas: LoadedAtlas | null,
  matrix: ConvergenceMatrix | null,
  metric: BacktraceState['heatMetric'],
  threshold: number,
): SectionPaint | null {
  return useMemo(() => {
    if (!atlas || !matrix) return null

    const sided = convergenceStrengths(matrix, metric, threshold)
    if (sided.ipsi.size === 0 && sided.contra.size === 0) return null

    const all = [...sided.ipsi.values(), ...sided.contra.values()]
    const min = Math.min(...all)
    const max = Math.max(...all)
    const span = Math.max(max - min, Number.EPSILON)

    // One ancestor walk per label per side, not one per pixel.
    const cache: Record<Side, Map<number, number | null>> = {
      ipsi: new Map(),
      contra: new Map(),
    }

    return {
      caption:
        `Sections coloured by convergence · structures · ${metric} · ` +
        `${formatConvergence(metric, min)} → ${formatConvergence(metric, max)} · ` +
        `left is ipsilateral · grey is unmeasured · independent of the target`,
      paint: {
        valueAt: (voxel) => {
          const label = atlas.volume.labelAtVoxel(voxel.i0, voxel.i1, voxel.i2)
          if (label === UNLABELLED) return null
          const side = voxelSide(atlas.space, voxel)
          let value = cache[side].get(label)
          if (value === undefined) {
            value = strengthForStructure(atlas.index, sided[side], label)
            cache[side].set(label, value)
          }
          return value
        },
        colorFor: (value) => heatColor((value - min) / span),
        empty: [0.105, 0.1, 0.09],
      },
    }
  }, [atlas, matrix, metric, threshold])
}

export interface VoxelMapState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly map: VoxelConvergence | null
  readonly message: string
}

/**
 * Load the bundled voxel map, once, on first use.
 *
 * Separate from the structure matrix and loaded only when the voxel grain is
 * actually chosen: it is 2 MB over the wire against the matrix's 150 kB, and
 * most sessions want the structure view.
 */
export function useVoxelConvergence(enabled: boolean): VoxelMapState {
  const [state, setState] = useState<VoxelMapState>({
    status: 'idle',
    map: null,
    message: '',
  })
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true

    let live = true
    setState({ status: 'loading', map: null, message: 'Loading voxel map (2 MB)…' })

    loadVoxelConvergence()
      .then((map) => {
        if (live) setState({ status: 'ready', map, message: '' })
      })
      .catch((error: unknown) => {
        started.current = false
        if (!live) return
        setState({
          status: 'error',
          map: null,
          message: error instanceof Error ? error.message : String(error),
        })
      })

    // Released so a StrictMode remount re-runs rather than finding the ref
    // claimed by a run whose result this very cleanup discarded.
    return () => {
      live = false
      started.current = false
    }
  }, [enabled])

  return state
}

/**
 * The voxel map as something the slice views can paint.
 *
 * The range is recomputed when the metric changes and not otherwise, because
 * it sorts a tenth of a million samples; the per-pixel work is then two array
 * reads and a ramp lookup.
 */
export function useVoxelPaint(
  map: VoxelConvergence | null,
  metric: BacktraceState['heatMetric'],
): { paint: VoxelPaint; range: VoxelRange } | null {
  return useMemo(() => {
    if (!map) return null

    const values = valuesFor(map, metric)
    const range = voxelRange(values)
    const span = Math.max(1, range.max - range.min)

    return {
      range,
      paint: {
        valueAt: (voxel) => {
          const index = voxelIndexFor(map, voxel)
          if (index < 0) return null
          const raw = values[index]!
          return raw > 0 ? raw : null
        },
        colorFor: (raw) => heatColor((raw - range.min) / span),
        // Inside the brain but reached by nothing: a dim neutral, so the
        // section keeps its shape rather than showing holes.
        empty: [0.105, 0.1, 0.09],
      },
    }
  }, [map, metric])
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
