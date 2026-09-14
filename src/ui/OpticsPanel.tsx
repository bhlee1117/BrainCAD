/**
 * OPTICS panel: objective approach-angle sweep.
 *
 * Renders the feasibility map the blueprint asks for (§12) — a grid of AP/ML
 * tilts coloured by whether the objective can reach the focal point from that
 * direction, with the limiting object named.
 */

import { useMemo, useState } from 'react'

import { STATE_COLOR, type CollisionMesh } from '../collision/check.ts'
import { cachedBvh, objectWorldMatrix } from '../collision/useCollision.ts'
import {
  DEFAULT_SWEEP_RANGE,
  formatRange,
  sweepAngles,
  type SweepResult,
} from '../collision/sweep.ts'
import { resolveGeometry } from '../objects/model.ts'
import { angleFromVerticalDeg } from '../objects/placement.ts'
import { useAppStore } from '../state/store.ts'

/** The feasibility grid, drawn as coloured cells. */
function FeasibilityMap({
  result,
  currentAp,
  currentMl,
  onPick,
}: {
  result: SweepResult
  currentAp: number
  currentMl: number
  onPick: (ap: number, ml: number) => void
}) {
  const cell = (ap: number, ml: number) =>
    result.samples.find((s) => s.apTiltDeg === ap && s.mlTiltDeg === ml)

  const nearest = (values: readonly number[], value: number) =>
    values.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), values[0]!)

  const currentApCell = nearest(result.apValues, currentAp)
  const currentMlCell = nearest(result.mlValues, currentMl)

  return (
    <div className="sweep">
      <div
        className="sweep__grid"
        style={{ gridTemplateColumns: `repeat(${result.mlValues.length}, 1fr)` }}
      >
        {result.apValues.map((ap) =>
          result.mlValues.map((ml) => {
            const sample = cell(ap, ml)
            const isCurrent = ap === currentApCell && ml === currentMlCell
            return (
              <button
                key={`${ap}:${ml}`}
                className={isCurrent ? 'sweep__cell sweep__cell--current' : 'sweep__cell'}
                style={{ background: sample ? STATE_COLOR[sample.state] : 'transparent' }}
                title={
                  sample
                    ? `AP ${ap}° · ML ${ml}° — ${sample.state}` +
                      (sample.limitingLabel ? ` (${sample.limitingLabel})` : '') +
                      (sample.clearanceMm !== null
                        ? ` · ${sample.clearanceMm.toFixed(2)} mm`
                        : '')
                    : ''
                }
                onClick={() => onPick(ap, ml)}
              />
            )
          }),
        )}
      </div>
      <div className="sweep__axes">
        <span>ML tilt {result.mlValues[0]}°</span>
        <span>→ {result.mlValues[result.mlValues.length - 1]}°</span>
      </div>
    </div>
  )
}

export function OpticsPanel() {
  const objects = useAppStore((s) => s.objects)
  const selection = useAppStore((s) => s.selection)
  const select = useAppStore((s) => s.select)
  const setObjectOrientation = useAppStore((s) => s.setObjectOrientation)
  const settings = useAppStore((s) => s.collisionSettings)

  const [result, setResult] = useState<SweepResult | null>(null)
  const [step, setStep] = useState(5)
  const [busy, setBusy] = useState(false)

  const objectives = objects.filter((o) => o.kind === 'objective')
  const selected =
    selection?.kind === 'object'
      ? (objects.find((o) => o.id === selection.id && o.kind === 'objective') ?? objectives[0])
      : objectives[0]

  const obliquity = selected ? angleFromVerticalDeg(selected.orientation) : 0

  const obstacles = useMemo<CollisionMesh[]>(() => {
    if (!selected) return []
    const meshes: CollisionMesh[] = []

    for (const other of objects) {
      if (other.id === selected.id || !other.collision || !other.visible) continue
      const built = resolveGeometry(other)
      const matrix = objectWorldMatrix(other)
      if (!built || !matrix) continue
      const bvh = cachedBvh(built.geometry)
      if (!bvh) continue
      meshes.push({
        id: other.id,
        label: other.name,
        geometry: built.geometry,
        bvh,
        matrixWorld: matrix,
        kind: 'hardware',
      })
    }
    return meshes
  }, [objects, selected])

  function runSweep() {
    if (!selected) return
    const built = resolveGeometry(selected)
    if (!built) return
    const bvh = cachedBvh(built.geometry)
    if (!bvh) return

    setBusy(true)
    // Yield a frame so the button can show its busy state before the grid runs.
    setTimeout(() => {
      setResult(
        sweepAngles(selected, built, bvh, obstacles, settings, {
          ...DEFAULT_SWEEP_RANGE,
          stepDeg: step,
        }),
      )
      setBusy(false)
    }, 16)
  }

  if (objectives.length === 0) {
    return (
      <div className="section">
        <h2>Optical access</h2>
        <p style={{ color: 'var(--text-faint)', margin: 0 }}>
          Add an objective in OBJECTS to sweep approach angles. The sweep rotates it about its
          focal point, so it answers which directions can reach a fixed imaging plane.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="section">
        <h2>Objective</h2>
        <select
          value={selected?.id ?? ''}
          onChange={(event) => select({ kind: 'object', id: event.target.value })}
        >
          {objectives.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>

        {selected && (
          <>
            <div className="row" style={{ marginTop: 8 }}>
              <span>AP tilt</span>
              <b>{selected.orientation.apTiltDeg.toFixed(1)}°</b>
            </div>
            <div className="row">
              <span>ML tilt</span>
              <b>{selected.orientation.mlTiltDeg.toFixed(1)}°</b>
            </div>
            <div className="row">
              <span>Off vertical</span>
              <b>{obliquity.toFixed(1)}°</b>
            </div>
            <div className="row">
              <span>Obstacles</span>
              <b>{obstacles.length}</b>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h2>Approach sweep</h2>
        <div className="field">
          <label htmlFor="sweep-step">Step</label>
          <input
            id="sweep-step"
            type="number"
            min={1}
            max={15}
            step={1}
            value={step}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10)
              if (Number.isFinite(next) && next > 0) setStep(next)
            }}
          />
          <span className="unit">°</span>
        </div>

        <button className="btn btn--primary" onClick={runSweep} disabled={busy}>
          {busy ? 'Sweeping…' : 'Sweep ±30°'}
        </button>

        {obstacles.length === 0 && (
          <p className="hint">
            Nothing to collide with yet. A sweep with no obstacles will report every angle
            feasible, which is true but not informative — add a headbar, prism or imported
            hardware first.
          </p>
        )}

        {result && (
          <>
            <FeasibilityMap
              result={result}
              currentAp={selected?.orientation.apTiltDeg ?? 0}
              currentMl={selected?.orientation.mlTiltDeg ?? 0}
              onPick={(ap, ml) => {
                if (selected) {
                  setObjectOrientation(selected.id, { apTiltDeg: ap, mlTiltDeg: ml })
                }
              }}
            />

            <div className="row" style={{ marginTop: 10 }}>
              <span>Feasible</span>
              <b>
                {result.feasibleCount} / {result.totalCount}
              </b>
            </div>
            <div className="row">
              <span>Allowed AP tilt</span>
              <b>{formatRange(result.allowedApDeg)}</b>
            </div>
            <div className="row">
              <span>Allowed ML tilt</span>
              <b>{formatRange(result.allowedMlDeg)}</b>
            </div>
            <div className="row">
              <span>Sweep time</span>
              <b>{result.elapsedMs} ms</b>
            </div>

            <p className="hint">
              Ranges are contiguous runs through the current pose, not the extremes of the
              feasible set — a quoted range you cannot actually traverse would describe a path
              straight through an obstacle. Click any cell to adopt that angle.
            </p>
          </>
        )}
      </div>
    </>
  )
}
