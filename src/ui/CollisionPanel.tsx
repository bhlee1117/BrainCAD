/**
 * Collision status panel.
 *
 * Reports the limiting object and the minimum clearance, which is the pair of
 * facts the blueprint asks for (§11) and the pair a surgeon actually acts on:
 * *what* is in the way, and *by how much*.
 */

import {
  STATE_COLOR,
  STATE_LABEL,
  formatSeparation,
  type CollisionState,
  type PairReport,
  type SceneCollisionReport,
} from '../collision/check.ts'
import { NumberField } from './NumberField.tsx'
import { useAppStore } from '../state/store.ts'

function StatePill({ state }: { state: CollisionState }) {
  return (
    <span
      className="state-pill"
      style={{ background: STATE_COLOR[state], color: state === 'near' ? '#221a08' : '#08110c' }}
    >
      {STATE_LABEL[state]}
    </span>
  )
}

/** Rows worth showing: anything not comfortably clear, worst first. */
function notablePairs(report: SceneCollisionReport): PairReport[] {
  const severity: Record<CollisionState, number> = {
    collision: 0,
    unknown: 1,
    near: 2,
    safe: 3,
  }
  return [...report.pairs]
    .filter((p) => p.state !== 'safe' || p.clearanceMm !== null)
    .sort(
      (a, b) =>
        severity[a.state] - severity[b.state] ||
        (a.clearanceMm ?? Infinity) - (b.clearanceMm ?? Infinity),
    )
    .slice(0, 12)
}

export function CollisionPanel({ stale }: { stale: boolean }) {
  const report = useAppStore((s) => s.collisionReport)
  const enabled = useAppStore((s) => s.collisionEnabled)
  const setEnabled = useAppStore((s) => s.setCollisionEnabled)
  const settings = useAppStore((s) => s.collisionSettings)
  const setSettings = useAppStore((s) => s.setCollisionSettings)
  const objects = useAppStore((s) => s.objects)

  const participating = objects.filter((o) => o.collision && o.visible).length

  return (
    <div className="section">
      <h2>Collision</h2>

      <label className="check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Check collisions
      </label>

      {!enabled && (
        <p className="hint" style={{ marginTop: 4 }}>
          Checking is off. Objects are drawn in their own colours and no clearance is reported.
        </p>
      )}

      {enabled && (
        <>
          <div className="field">
            <label htmlFor="warn-clearance" title="Warn below this clearance">
              Warn
            </label>
            <NumberField
              id="warn-clearance"
              step={0.05}
              min={0}
              value={settings.warnClearanceMm}
              onChange={(warnClearanceMm) => setSettings({ warnClearanceMm })}
            />
            <span className="unit">mm</span>
          </div>

          {participating === 0 && (
            <p className="hint" style={{ marginTop: 4 }}>
              No objects are participating yet. Add hardware in OBJECTS to check clearance
              against the brain.
            </p>
          )}

          {report && participating > 0 && (
            <>
              <div className="row" style={{ marginTop: 8 }}>
                <span>Status</span>
                <StatePill state={report.worst} />
              </div>
              <div className="row">
                <span>Minimum clearance</span>
                <b>
                  {/* Overlapping surfaces have no positive clearance, so
                      reporting a bound here would contradict the status
                      directly above it. */}
                  {report.worst === 'collision'
                    ? 'overlapping'
                    : report.limiting
                      ? formatSeparation(report.limiting)
                      : report.pairs.length
                        ? `> ${settings.exactQueryWindowMm} mm`
                        : '—'}
                </b>
              </div>
              {report.limiting && (
                <div className="row">
                  <span>Limiting</span>
                  <b>
                    {report.limiting.aLabel} ↔ {report.limiting.bLabel}
                  </b>
                </div>
              )}
              <div className="row">
                <span>Pairs checked</span>
                <b>
                  {report.checkedPairs}
                  {stale ? ' (updating…)' : ''}
                </b>
              </div>

              {notablePairs(report).length > 0 && (
                <div className="pairs">
                  {notablePairs(report).map((pair) => (
                    <div className="pair" key={`${pair.aId}-${pair.bId}`}>
                      <span
                        className="pair__bar"
                        style={{ background: STATE_COLOR[pair.state] }}
                      />
                      <span className="pair__names">
                        {pair.aLabel} ↔ {pair.bLabel}
                      </span>
                      <span className="pair__value">{formatSeparation(pair)}</span>
                      {pair.involvesAnatomy && <span className="pair__tag">anatomy</span>}
                    </div>
                  ))}
                </div>
              )}

              {report.worst === 'collision' && (
                <div className="warn-box" style={{ marginTop: 9 }}>
                  Meshes overlap. Note that a collision-free plan is not a guarantee of
                  surgical success, and a detected collision is measured against an averaged
                  atlas surface — verify against the animal.
                </div>
              )}

              {report.worst === 'unknown' && (
                <div className="warn-box" style={{ marginTop: 9 }}>
                  Some pairs could not be evaluated. An unknown result is not evidence of
                  clearance.
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
