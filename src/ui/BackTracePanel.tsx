/**
 * BACKTRACE panel: what projects to the target, and the keys that move it.
 *
 * The panel is built around one loop — nudge the target, see the sources
 * change — so the pad legend sits at the top where it is read once, and the
 * matrix below it updates in place rather than being re-requested by hand.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { UNLABELLED } from '../atlas/annotation.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import {
  RETROGRADE_CAVEATS,
  RETROGRADE_CITATION,
  experimentUrl,
  retrogradeMatrix,
  searchRetrograde,
  isSeedCached,
  seedPointParam,
  visibleSources,
  type RetrogradeMatrixRow,
} from '../overlays/retrograde.ts'
import {
  CONVERGENCE_CAVEATS,
  CONVERGENCE_METRIC_LABEL,
  SIDE_LABEL,
  flipHemisphere,
  formatConvergence,
  rankConvergence,
  type ConvergenceMetric,
  type Side,
} from '../overlays/convergence.ts'
import { VOXEL_CAVEATS } from '../overlays/voxelConvergence.ts'
import { useConvergenceMatrix } from '../overlays/useHubMap.ts'
import { HEATMAP_MODE_LABEL } from '../overlays/heatmap.ts'
import { COARSE_FACTOR, NUDGE_LEGEND, nudgeCoord } from '../state/nudge.ts'
import { useAppStore } from '../state/store.ts'
import { NumberField } from './NumberField.tsx'

/**
 * How long the target must sit still before a follow-up query goes out.
 *
 * Long enough that holding a nudge key does not fire a request per repeat —
 * the key repeat rate is roughly 30/second — and short enough that a single
 * deliberate step feels answered rather than queued.
 */
const FOLLOW_DEBOUNCE_MS = 600

/**
 * Upper end of the "show top" slider.
 *
 * A hundred is past the point of reading the list and well into scanning the
 * map: with every source painted, the question stops being "what are the top
 * few" and becomes "is anything unexpected lit up". The fetch limit below is
 * what actually has to keep up with it.
 */
const MAX_TOP_STRUCTURES = 100

/**
 * How many hubs the list names.
 *
 * Long enough to look past the handful everyone already expects, short enough
 * that the list is still read rather than scrolled. The map beside it is what
 * covers the rest.
 */
const HUB_LIST_LENGTH = 15

/**
 * How long the search typically takes, in seconds.
 *
 * Measured, not guessed: a hippocampal seed came back in 5-15 s. The number is
 * shown while waiting because a spinner that sits still for thirteen seconds
 * is indistinguishable from one that has hung, and the user's next move is to
 * press the button again — which cancels the query they were waiting for.
 */
const TYPICAL_SECONDS = '5-15 s'

/** Seconds elapsed, while a query is in flight. */
function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!running) return
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 500)
    return () => clearInterval(timer)
  }, [running])

  return elapsed
}

function sameCoord(a: Stereotaxic | null, b: Stereotaxic | null): boolean {
  if (!a || !b) return a === b
  return a.ap === b.ap && a.ml === b.ml && a.dv === b.dv
}

/** A density bar, so the matrix can be read down the column at a glance. */
function DensityBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="bar">
      <div
        className="bar__fill"
        style={{ width: `${Math.min(100, value * 100).toFixed(1)}%`, background: color }}
      />
    </div>
  )
}

function MatrixRow({
  row,
  focused,
  onFocus,
}: {
  row: RetrogradeMatrixRow
  focused: boolean
  onFocus: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mrow" aria-current={focused}>
      <div className="mrow__head" onClick={onFocus} title={row.name}>
        <span className="swatch" style={{ background: row.color }} />
        <span className="mrow__abbrev">{row.abbrev}</span>
        <DensityBar value={row.peakDensity} color={row.color} />
        <span className="mrow__value">{row.peakDensity.toFixed(3)}</span>
        <button
          className="icon-btn"
          title={open ? 'Hide experiments' : 'Show experiments'}
          onClick={(event) => {
            event.stopPropagation()
            setOpen((o) => !o)
          }}
        >
          {open ? '−' : '+'}
        </button>
      </div>

      <div className="mrow__meta">
        {row.name} · {row.experimentCount} experiment
        {row.experimentCount === 1 ? '' : 's'}
        {row.experimentCount > 1 && ` · mean ${row.meanDensity.toFixed(3)}`}
        {row.overlappingCount > 0 && (
          <span className="pair__tag" title="The target lies inside this injection">
            {row.overlappingCount === row.experimentCount
              ? 'at target'
              : `${row.overlappingCount} at target`}
          </span>
        )}
      </div>

      {open && (
        <div className="mrow__experiments">
          {row.sources.map((source) => (
            <div key={source.experimentId} className="mrow__exp">
              <a href={experimentUrl(source.experimentId)} target="_blank" rel="noreferrer">
                {source.experimentId}
              </a>
              <span>{source.densityAtTarget.toFixed(3)}</span>
              <span>
                {source.injectionDistanceMm !== null
                  ? `${source.injectionDistanceMm.toFixed(2)} mm away`
                  : 'no injection centre'}
              </span>
              <span>{source.transgenicLine || 'wild-type'}</span>
              {source.side && (
                <span className="pair__tag">{SIDE_LABEL[source.side]}</span>
              )}
              {source.targetInsideInjection && (
                <span className="pair__tag">at target</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function BackTracePanel({
  atlas,
  profile,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  const targets = useAppStore((s) => s.targets)
  const selectedTargetId = useAppStore((s) => s.selectedTargetId)
  const backtrace = useAppStore((s) => s.backtrace)
  const setBacktrace = useAppStore((s) => s.setBacktrace)
  const nudgeStepMm = useAppStore((s) => s.nudgeStepMm)
  const setNudgeStepMm = useAppStore((s) => s.setNudgeStepMm)
  const updateTarget = useAppStore((s) => s.updateTarget)

  // The same hook App uses, so the matrix is fetched once and shared through
  // its module-level cache rather than downloaded twice.
  const convergence = useConvergenceMatrix(backtrace.showHeatmap)

  const target = targets.find((t) => t.id === selectedTargetId) ?? null
  const coord = target?.coord ?? null

  // One controller for the whole panel: a nudge during a query should abandon
  // the answer to the old coordinate rather than race it to the screen.
  const inFlight = useRef<AbortController | null>(null)

  const trace = useCallback(
    async (at: Stereotaxic) => {
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller

      setBacktrace({ status: 'loading', message: 'Searching Allen experiments…' })

      try {
        const sources = await searchRetrograde(profile, at, { signal: controller.signal })
        if (controller.signal.aborted) return
        setBacktrace({
          status: 'ready',
          message: '',
          sources,
          tracedCoord: at,
          focusAbbrev: null,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        setBacktrace({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          sources: [],
          tracedCoord: null,
        })
      }
    },
    [profile, setBacktrace],
  )

  // Follow the target, debounced. The dependency is the coordinate's numbers
  // rather than the object, so a re-render that hands back an equal coordinate
  // does not re-fire the query.
  const ap = coord?.ap
  const ml = coord?.ml
  const dv = coord?.dv
  const follow = backtrace.follow
  const traced = backtrace.tracedCoord

  useEffect(() => {
    if (!follow || ap === undefined || ml === undefined || dv === undefined) return
    const at = { ap, ml, dv }
    if (sameCoord(at, traced)) return

    const timer = setTimeout(() => void trace(at), FOLLOW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [follow, ap, ml, dv, traced, trace])

  useEffect(() => () => inFlight.current?.abort(), [])

  const loading = backtrace.status === 'loading'
  const elapsed = useElapsed(loading)
  const stale = coord !== null && !sameCoord(coord, backtrace.tracedCoord)
  const seed = coord ? seedPointParam(profile, coord) : null
  const cached = seed !== null && isSeedCached(seed)

  const regionAtTarget = (() => {
    if (!coord) return null
    const id = atlas.volume.labelAt(profile, coord)
    if (id === UNLABELLED) return null
    return atlas.index.byId.get(id)?.acronym ?? null
  })()

  // Ranked from the same matrix the colours come from, so the list and the
  // map can never disagree about which region is hottest.
  const hubs =
    convergence.matrix &&
    backtrace.showHeatmap &&
    (backtrace.heatSurface === 'sections' || backtrace.heatMode === 'regions')
      ? rankConvergence(
          convergence.matrix,
          backtrace.heatMetric,
          backtrace.connectionThreshold,
        )
      : []

  // Two separate exclusions, counted separately. Rolled into one number they
  // read as "below the top N", which is not what being on the other side of
  // the brain is.
  const sided = visibleSources(backtrace.sources, {
    includeOverlapping: backtrace.includeOverlapping,
    topStructures: Number.POSITIVE_INFINITY,
    focusAbbrev: null,
    side: backtrace.sourceSide,
  })
  const shown = visibleSources(backtrace.sources, {
    includeOverlapping: backtrace.includeOverlapping,
    topStructures: backtrace.topStructures,
    focusAbbrev: null,
    side: backtrace.sourceSide,
  })
  const matrix = retrogradeMatrix(shown)
  const belowTop = sided.length - shown.length
  const otherSide = backtrace.sources.length - sided.length

  if (!target || !coord) {
    return (
      <div className="section">
        <h2>Back-trace</h2>
        <p className="hint">No target selected. Back-tracing runs from a target.</p>
      </div>
    )
  }

  return (
    <>
      <div className="section">
        <h2>Target</h2>
        <div className="row">
          <span>{target.name}</span>
          <b>
            {coord.ap.toFixed(2)} / {coord.ml.toFixed(2)} / {coord.dv.toFixed(2)}
          </b>
        </div>
        <div className="row">
          <span>Region here</span>
          <b>{regionAtTarget ?? (seed ? 'unlabelled' : 'outside the volume')}</b>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor="nudge-step">Step</label>
          <NumberField
            id="nudge-step"
            step={0.05}
            value={nudgeStepMm}
            onChange={setNudgeStepMm}
          />
          <span className="unit">mm</span>
        </div>

        {/* The legend is also the control. A phone has no number pad, and the
            pure nudge is already written — so showing a key the reader cannot
            press, next to a direction they cannot apply, would be wasted
            space on exactly the layout with least of it. */}
        <div className="pad">
          {NUDGE_LEGEND.map((entry) => (
            <button
              key={entry.key}
              className="pad__key"
              title={`${entry.label} — ${entry.key}`}
              onClick={(event) =>
                updateTarget(target.id, {
                  coord: nudgeCoord(
                    coord,
                    entry.direction,
                    nudgeStepMm * (event.shiftKey ? COARSE_FACTOR : 1),
                  ),
                })
              }
            >
              <kbd>{entry.key}</kbd>
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
        <p className="hint">
          WASD moves the target in the horizontal plane, Q and E take it down and up, or
          tap above; hold Shift for ×{COARSE_FACTOR}. Left and right are the
          animal&rsquo;s. Keys are ignored while the caret is in a field.
        </p>

        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            className="btn"
            disabled={coord.ml === 0}
            title={
              coord.ml === 0
                ? 'The target is on the midline, so there is nothing to flip'
                : `Move the target to ML ${(-coord.ml).toFixed(2)}`
            }
            onClick={() =>
              updateTarget(target.id, { coord: flipHemisphere(coord) })
            }
          >
            Flip hemisphere
          </button>
        </div>
        <p className="hint" style={{ marginTop: 2 }}>
          Mirrors ML and keeps AP and DV, so the two answers are of one place rather than
          two. It does <i>not</i> pick ipsilateral or contralateral input — a target has
          both, and which dominates varies: 80% ipsilateral at dorsal CA1 ML +1.5, 63% at
          MOs ML −0.90, 45% at CA1 ML −1.5. Use the source filter below for that.
        </p>
      </div>

      <div className="section">
        <h2>Sources</h2>

        <label className="check">
          <input
            type="checkbox"
            checked={backtrace.follow}
            onChange={(event) => setBacktrace({ follow: event.target.checked })}
          />
          Re-trace when the target moves
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={backtrace.showPaths}
            onChange={(event) => setBacktrace({ showPaths: event.target.checked })}
          />
          Draw routes in the 3D view
        </label>
        {backtrace.showPaths && (
          <p className="hint" style={{ marginTop: 0 }}>
            Drawn on the target itself, in Allen&rsquo;s own coordinates — unmirrored, so
            a route runs to where that experiment was actually injected. The hub map
            below is mirrored and can be, having no target in it.
          </p>
        )}

        <div className="field">
          <label htmlFor="src-side">Side</label>
          <select
            id="src-side"
            value={backtrace.sourceSide}
            onChange={(event) =>
              setBacktrace({ sourceSide: event.target.value as Side | 'all' })
            }
          >
            <option value="all">Both sides</option>
            <option value="ipsi">Ipsilateral only</option>
            <option value="contra">Contralateral only</option>
          </select>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Read off each experiment&rsquo;s own injection against the target&rsquo;s, so it
          is a fact about that pair rather than a guess from where Allen usually injects.
          {coord.ml === 0 &&
            ' The target is on the midline, where neither side is defined, so the filter is empty.'}
        </p>

        <label className="check">
          <input
            type="checkbox"
            checked={backtrace.includeOverlapping}
            onChange={(event) => setBacktrace({ includeOverlapping: event.target.checked })}
          />
          Include injections covering the target
        </label>

        <div className="field">
          <label htmlFor="bt-top">Show top</label>
          <input
            id="bt-top"
            type="range"
            min={1}
            max={MAX_TOP_STRUCTURES}
            step={1}
            value={backtrace.topStructures}
            onChange={(event) =>
              setBacktrace({ topStructures: Number(event.target.value) })
            }
          />
          <span className="unit">{backtrace.topStructures}</span>
        </div>

        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            className="btn btn--primary"
            disabled={loading}
            onClick={() => void trace(coord)}
          >
            {loading ? `Tracing… ${elapsed.toFixed(0)} s` : 'Trace from target'}
          </button>
          {backtrace.sources.length > 0 && (
            <button className="btn" onClick={() => setBacktrace({ focusAbbrev: null })}>
              Show all
            </button>
          )}
        </div>

        {loading && (
          <p className="hint">
            Allen&rsquo;s spatial search compares the target against every injection in the
            corpus and usually takes {TYPICAL_SECONDS}. Answers are kept, so stepping back
            over a coordinate you have already traced is instant.
          </p>
        )}

        {!loading && cached && stale && (
          <p className="hint">This coordinate has been traced before — it will return at once.</p>
        )}

        {backtrace.status === 'error' && (
          <div className="warn-box">{backtrace.message}</div>
        )}

        {stale && backtrace.status === 'ready' && (
          <p className="hint">
            {backtrace.follow
              ? 'Target moved — re-tracing.'
              : 'Target has moved since this trace. Re-run it to match.'}
          </p>
        )}
      </div>

      {/*
        Deliberately not behind a completed trace. The hub map is a property of
        the connectome and needs no target at all — gating it on a back-trace
        would make the one view that does not depend on the target the only one
        you cannot open without waiting for the target's query to return.
      */}
      <div className="section">
          <h2>Hub map</h2>

          <label className="check">
            <input
              type="checkbox"
              checked={backtrace.showHeatmap}
              onChange={(event) => setBacktrace({ showHeatmap: event.target.checked })}
            />
            Show the hub map
          </label>

          {backtrace.showHeatmap && (
            <div className="field">
              <label htmlFor="heat-surface">Draw on</label>
              <select
                id="heat-surface"
                value={backtrace.heatSurface}
                onChange={(event) =>
                  setBacktrace({
                    heatSurface: event.target.value as 'sections' | 'brain',
                  })
                }
              >
                <option value="sections">The section views below</option>
                <option value="brain">A second brain, beside this one</option>
              </select>
            </div>
          )}

          {backtrace.showHeatmap && backtrace.heatSurface === 'sections' && (
            <>
              <div className="field">
                <label htmlFor="heat-grain">Grain</label>
                <select
                  id="heat-grain"
                  value={backtrace.heatGrain}
                  onChange={(event) =>
                    setBacktrace({
                      heatGrain: event.target.value as 'structures' | 'voxels',
                    })
                  }
                >
                  <option value="structures">Structures — one value per region</option>
                  <option value="voxels">Voxels — 100 µm, ignores the parcellation</option>
                </select>
              </div>
              {backtrace.heatGrain === 'voxels' && (
                <p className="hint" style={{ marginTop: 0 }}>
                  Accumulated from the raw projection grids of all 2,826 experiments, so
                  it owes nothing to the region boundaries and can disagree with them.
                  The pixels are larger — 100 µm against the atlas&rsquo;s 50 — and each
                  one is a measurement at that place rather than an average over the
                  region containing it. 2 MB, fetched once.
                </p>
              )}
            </>
          )}

          {backtrace.showHeatmap && (
            <>
              {backtrace.heatSurface === 'brain' && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={backtrace.heatMode === 'routes'}
                      onChange={(event) =>
                        setBacktrace({
                          heatMode: event.target.checked ? 'routes' : 'regions',
                        })
                      }
                    />
                    Draw traced routes instead of the hub map
                  </label>
                  <p className="hint" style={{ marginTop: 0 }}>
                    {HEATMAP_MODE_LABEL[backtrace.heatMode]}
                  </p>
                </>
              )}

              {backtrace.heatSurface === 'sections' || backtrace.heatMode === 'regions' ? (
                <>
                  <div className="field">
                    <label htmlFor="heat-metric">Measure</label>
                    <select
                      id="heat-metric"
                      value={backtrace.heatMetric}
                      onChange={(event) =>
                        setBacktrace({
                          heatMetric: event.target.value as ConvergenceMetric,
                        })
                      }
                    >
                      {(Object.keys(CONVERGENCE_METRIC_LABEL) as ConvergenceMetric[]).map(
                        (metric) => (
                          <option key={metric} value={metric}>
                            {CONVERGENCE_METRIC_LABEL[metric]}
                          </option>
                        ),
                      )}
                    </select>
                  </div>

                  <div className="field" hidden={backtrace.heatGrain === 'voxels'}>
                    <label htmlFor="heat-threshold">Counts above</label>
                    <NumberField
                      id="heat-threshold"
                      step={0.005}
                      value={backtrace.connectionThreshold}
                      onChange={(connectionThreshold) =>
                        setBacktrace({
                          connectionThreshold: Math.max(0, connectionThreshold),
                        })
                      }
                    />
                    <span className="unit">density</span>
                  </div>
                </>
              ) : (
                <p className="hint" style={{ marginTop: 0 }}>
                  Routes are coloured by their own experiment&rsquo;s strength at the
                  target, so the hub-map measure does not apply here.
                </p>
              )}

              {backtrace.heatSurface === 'brain' && backtrace.heatMode === 'routes' && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={backtrace.heatAllSources}
                    onChange={(event) =>
                      setBacktrace({ heatAllSources: event.target.checked })
                    }
                  />
                  Draw every route, not just the listed top
                </label>
              )}

              {backtrace.heatSurface === 'brain' && (
              <div className="field">
                <label htmlFor="heat-opacity">Opacity</label>
                <input
                  id="heat-opacity"
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={backtrace.heatOpacity}
                  onChange={(event) =>
                    setBacktrace({ heatOpacity: Number(event.target.value) })
                  }
                />
              </div>
              )}

              <div className="ramp">
                <div className="ramp__bar" />
                <div className="ramp__ends">
                  <span>weak</span>
                  <span>strong</span>
                </div>
              </div>

              <p className="hint">
                {backtrace.heatSurface === 'brain'
                  ? 'The second view shares this one’s camera, so orbiting the main brain turns both. '
                  : 'The strip under the viewport follows the target, so the sections move with it even though the colours do not. '}
                Colour is per structure, not per voxel — the finest grain Allen reports is
                the region an experiment was injected into, so edges fall on structure
                boundaries because that is where the information changes.
              </p>

              {hubs.length > 0 && (
                <>
                  {/* Postsynaptic because the map is in-degree: these are the
                      regions projections arrive *at*, so they sit downstream
                      of the sources that reach them. The word overstates
                      slightly — bulk anterograde signal counts a fibre passing
                      through a region the same as one terminating in it — which
                      is why that caveat sits directly under this list. */}
                  <h2 style={{ marginTop: 14 }}>Top postsynaptic hubs</h2>
                  <div className="mrow__meta" style={{ marginBottom: 6, marginLeft: 0 }}>
                    Regions most projected <i>to</i>, across the whole connectome — not
                    this target. Ranked ipsilaterally; <b>c</b> is the contralateral
                    value.
                  </div>
                  {hubs.slice(0, HUB_LIST_LENGTH).map((hub, rank) => (
                    <div key={hub.id} className="mrow__exp">
                      <span style={{ minWidth: 20, textAlign: 'right' }}>{rank + 1}.</span>
                      <span style={{ minWidth: 54, fontWeight: 600 }}>{hub.acronym}</span>
                      <DensityBar
                        value={hubs[0]!.value > 0 ? hub.value / hubs[0]!.value : 0}
                        color="#f5911f"
                      />
                      <span style={{ minWidth: 38, textAlign: 'right' }}>
                        {formatConvergence(backtrace.heatMetric, hub.value)}
                      </span>
                      {/* In count mode the value *is* the source count, so
                          printing both twice says nothing. Under mean it is
                          the evidence behind the average and has to be there:
                          0.14 from two sources is a different claim from 0.14
                          from sixty. */}
                      {backtrace.heatMetric === 'mean' && (
                        <span style={{ minWidth: 44 }}>n={hub.sourceCount}</span>
                      )}
                      {/* The contralateral value, never averaged into the
                          ranking. A region fed almost equally from both sides
                          is a different kind of hub from one fed overwhelmingly
                          from its own, and a single number hides which. */}
                      <span style={{ minWidth: 52 }} title="contralateral">
                        c {formatConvergence(backtrace.heatMetric, hub.contra)}
                      </span>
                    </div>
                  ))}
                </>
              )}

              {(backtrace.heatSurface === 'sections' ||
                backtrace.heatMode === 'regions') && (
                <div className="provenance">
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {(backtrace.heatSurface === 'sections' &&
                    backtrace.heatGrain === 'voxels'
                      ? VOXEL_CAVEATS
                      : CONVERGENCE_CAVEATS
                    ).map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                </div>
              )}

              {convergence.status === 'error' && (
                <div className="warn-box">{convergence.message}</div>
              )}
            </>
          )}
      </div>

      {backtrace.status === 'ready' && (
        <div className="section">
          <h2>Retrograde matrix</h2>

          {matrix.length === 0 ? (
            <p className="hint">
              No Allen injection deposits measurable signal here. That means no experiment
              in the corpus reaches this voxel — not that nothing projects to it.
            </p>
          ) : (
            <>
              <div className="mrow__meta" style={{ marginBottom: 6 }}>
                {matrix.length} source structure{matrix.length === 1 ? '' : 's'} ·{' '}
                {shown.length} experiment{shown.length === 1 ? '' : 's'}
                {belowTop > 0 &&
                  ` · ${belowTop} more below the top ${backtrace.topStructures}`}
                {otherSide > 0 && ` · ${otherSide} on the other side`}
              </div>

              {matrix.map((row) => (
                <MatrixRow
                  key={row.abbrev}
                  row={row}
                  focused={backtrace.focusAbbrev === row.abbrev}
                  onFocus={() =>
                    setBacktrace({
                      focusAbbrev:
                        backtrace.focusAbbrev === row.abbrev ? null : row.abbrev,
                    })
                  }
                />
              ))}
            </>
          )}
        </div>
      )}

      <div className="section">
        <h2>What this is</h2>
        <div className="provenance">
          {RETROGRADE_CITATION}
          <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
            {RETROGRADE_CAVEATS.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}
