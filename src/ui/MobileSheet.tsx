/**
 * Mobile bottom sheet.
 *
 * The blueprint is explicit (§5): mobile is not a compressed desktop. It is a
 * compact reference tool used standing at a stereotaxic rig, where the 3D brain
 * should hold the screen and controls live in a sheet that can be pulled up
 * when needed and pushed down when it is in the way.
 *
 * That use also shapes what belongs here. At the rig, the questions are "what
 * are the numbers" and "am I clear" — not "let me import an STL". So the sheet
 * carries coordinates, the region readout and collision state, and leaves the
 * heavier authoring tabs to the desktop layout.
 */

import { useState } from 'react'

import { UNLABELLED } from '../atlas/annotation.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { STATE_COLOR, STATE_LABEL, formatSeparation } from '../collision/check.ts'
import { useAppStore, type Target } from '../state/store.ts'

type SheetTab = 'target' | 'objects' | 'clearance'

/** Big, thumb-sized stepper for one coordinate axis. */
function CoordStepper({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (next: number) => void
}) {
  // 0.05 mm is a sensible nudge at a rig: fine enough to matter, coarse enough
  // that a gloved thumb is not fighting the control.
  const step = 0.05

  return (
    <div className="mstep">
      <span className="mstep__label">{label}</span>
      <button
        className="mstep__btn"
        aria-label={`Decrease ${label}`}
        onClick={() => onChange(Number((value - step).toFixed(3)))}
      >
        −
      </button>
      <input
        className="mstep__value"
        type="number"
        inputMode="decimal"
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      <button
        className="mstep__btn"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(Number((value + step).toFixed(3)))}
      >
        +
      </button>
    </div>
  )
}

function TargetTab({
  atlas,
  profile,
  target,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  target: Target | null
}) {
  const updateTarget = useAppStore((s) => s.updateTarget)

  if (!target) return <p className="mhint">No target selected.</p>

  const id = atlas.volume.labelAt(profile, target.coord)
  const structure = id === UNLABELLED ? null : atlas.index.byId.get(id)

  return (
    <>
      <div className="mregion">
        <div className="mregion__acronym">{structure?.acronym ?? '—'}</div>
        <div className="mregion__name">
          {structure?.name ?? 'Outside annotated tissue'}
        </div>
      </div>

      <CoordStepper
        label="AP"
        value={target.coord.ap}
        onChange={(ap) => updateTarget(target.id, { coord: { ...target.coord, ap } })}
      />
      <CoordStepper
        label="ML"
        value={target.coord.ml}
        onChange={(ml) => updateTarget(target.id, { coord: { ...target.coord, ml } })}
      />
      <CoordStepper
        label="DV"
        value={target.coord.dv}
        onChange={(dv) => updateTarget(target.id, { coord: { ...target.coord, dv } })}
      />

      <p className="mhint">
        {profile.label} · DV from {profile.dvReference.replace('-', ' ')}. Averaged atlas —
        verify on the animal.
      </p>
    </>
  )
}

function ObjectsTab() {
  const objects = useAppStore((s) => s.objects)
  const selection = useAppStore((s) => s.selection)
  const select = useAppStore((s) => s.select)
  const setObjectOrientation = useAppStore((s) => s.setObjectOrientation)

  const selected =
    selection?.kind === 'object' ? objects.find((o) => o.id === selection.id) : objects[0]

  if (objects.length === 0) {
    return <p className="mhint">No objects placed. Add hardware on a desktop browser.</p>
  }

  return (
    <>
      <div className="mchips">
        {objects.map((object) => (
          <button
            key={object.id}
            className={
              selected?.id === object.id ? 'mchip mchip--active' : 'mchip'
            }
            onClick={() => select({ kind: 'object', id: object.id })}
          >
            <span className="mchip__dot" style={{ background: object.color }} />
            {object.name}
          </button>
        ))}
      </div>

      {selected && (
        <>
          <CoordStepper
            label="AP tilt"
            value={selected.orientation.apTiltDeg}
            onChange={(apTiltDeg) => setObjectOrientation(selected.id, { apTiltDeg })}
          />
          <CoordStepper
            label="ML tilt"
            value={selected.orientation.mlTiltDeg}
            onChange={(mlTiltDeg) => setObjectOrientation(selected.id, { mlTiltDeg })}
          />
          <p className="mhint">
            Anchor at AP {selected.target.ap.toFixed(2)} · ML {selected.target.ml.toFixed(2)} ·
            DV {selected.target.dv.toFixed(2)} mm
          </p>
        </>
      )}
    </>
  )
}

function ClearanceTab() {
  const report = useAppStore((s) => s.collisionReport)
  const enabled = useAppStore((s) => s.collisionEnabled)

  if (!enabled) return <p className="mhint">Collision checking is off.</p>
  if (!report || report.checkedPairs === 0) {
    return <p className="mhint">Nothing to check yet.</p>
  }

  return (
    <>
      <div
        className="mstatus"
        style={{
          background: STATE_COLOR[report.worst],
          color: report.worst === 'near' ? '#221a08' : '#08110c',
        }}
      >
        {STATE_LABEL[report.worst]}
        {report.limiting && (
          <span className="mstatus__detail">
            {formatSeparation(report.limiting)} · {report.limiting.aLabel} ↔{' '}
            {report.limiting.bLabel}
          </span>
        )}
      </div>

      {report.pairs
        .filter((p) => p.state !== 'safe' || p.clearanceMm !== null)
        .slice(0, 6)
        .map((pair) => (
          <div className="mpair" key={`${pair.aId}-${pair.bId}`}>
            <span className="mpair__bar" style={{ background: STATE_COLOR[pair.state] }} />
            <span className="mpair__names">
              {pair.aLabel} ↔ {pair.bLabel}
            </span>
            <span className="mpair__value">{formatSeparation(pair)}</span>
          </div>
        ))}
    </>
  )
}

export function MobileSheet({
  atlas,
  profile,
  target,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  target: Target | null
}) {
  const [tab, setTab] = useState<SheetTab>('target')
  // Starts collapsed so the brain holds the screen, as the blueprint's mobile
  // mock shows: a large 3D view over a compact strip carrying the coordinate
  // and the clearance state. Controls are one tap away on the grip.
  const [expanded, setExpanded] = useState(false)
  const report = useAppStore((s) => s.collisionReport)

  return (
    <div className={expanded ? 'msheet msheet--open' : 'msheet'}>
      <button
        className="msheet__grip"
        onClick={() => setExpanded((v) => !v)}
        aria-label={expanded ? 'Collapse controls' : 'Expand controls'}
      >
        <span className="msheet__bar" />
      </button>

      {/* Collapsed, the sheet still shows the two things worth a glance at a
          rig: where the target is and whether anything is fouling. */}
      <div className="msheet__summary">
        <span className="msheet__coord">
          {target
            ? `AP ${target.coord.ap.toFixed(2)}  ML ${target.coord.ml.toFixed(2)}  DV ${target.coord.dv.toFixed(2)}`
            : 'No target'}
        </span>
        {report && report.checkedPairs > 0 && (
          <span
            className="msheet__pill"
            style={{
              background: STATE_COLOR[report.worst],
              color: report.worst === 'near' ? '#221a08' : '#08110c',
            }}
          >
            {STATE_LABEL[report.worst]}
          </span>
        )}
      </div>

      {expanded && (
        <>
          <div className="msheet__tabs">
            {(
              [
                ['target', 'Target'],
                ['objects', 'Objects'],
                ['clearance', 'Clearance'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? 'msheet__tab msheet__tab--active' : 'msheet__tab'}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="msheet__body">
            {tab === 'target' && (
              <TargetTab atlas={atlas} profile={profile} target={target} />
            )}
            {tab === 'objects' && <ObjectsTab />}
            {tab === 'clearance' && <ClearanceTab />}
          </div>
        </>
      )}
    </div>
  )
}
