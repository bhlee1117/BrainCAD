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

  const shown = visibleSources(backtrace.sources, {
    includeOverlapping: backtrace.includeOverlapping,
    topStructures: backtrace.topStructures,
    focusAbbrev: null,
  })
  const matrix = retrogradeMatrix(shown)
  const excluded = backtrace.sources.length - shown.length

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
              title={`${entry.label} — number pad ${entry.key}`}
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
          Number-pad keys move the target, or tap above; hold Shift for ×{COARSE_FACTOR}.
          Medial and lateral are relative to the midline, so they keep their meaning in
          the left hemisphere. Keys are ignored while the caret is in a field.
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
            max={20}
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
                {excluded > 0 &&
                  ` · ${excluded} more below the top ${backtrace.topStructures}`}
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
