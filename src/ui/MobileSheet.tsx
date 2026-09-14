/**
 * Mobile bottom sheet.
 *
 * The blueprint is explicit (§5): mobile is not a compressed desktop. It is a
 * compact reference tool used standing at a stereotaxic rig, where the 3D brain
 * should hold the screen and controls live in a sheet that can be pulled up
 * when needed and pushed down when it is in the way.
 *
 * That use shapes what PLAN shows: at the rig the questions are "what are the
 * numbers" and "am I clear", so the rig view leads with the coordinate, the
 * region readout and collision state rather than with authoring controls.
 *
 * The sheet is also where the top tab bar lands on a phone. It used to carry a
 * second, private set of tabs while the real ones sat inert in the header —
 * seven tabs that changed state and rendered nothing, because the panel they
 * drive is only mounted in the desktop branch. One tab system now, and every
 * tab in it resolves to something.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { UNLABELLED } from '../atlas/annotation.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { STATE_COLOR, STATE_LABEL, formatSeparation } from '../collision/check.ts'
import { useAppStore, type Target } from '../state/store.ts'

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

/**
 * Rig controls for the selected object: pick one, adjust its tilt.
 *
 * Sits above the full object library rather than replacing it — angle is what
 * gets nudged at the rig, but "add hardware on a desktop browser" was a dead
 * end on a tool that runs perfectly well in a phone browser.
 */
export function ObjectsTab() {
  const objects = useAppStore((s) => s.objects)
  const selection = useAppStore((s) => s.selection)
  const select = useAppStore((s) => s.select)
  const setObjectOrientation = useAppStore((s) => s.setObjectOrientation)

  const selected =
    selection?.kind === 'object' ? objects.find((o) => o.id === selection.id) : objects[0]

  if (objects.length === 0) return null

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
  tab,
  children,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  target: Target | null
  /** The active header tab, which is what the sheet body shows. */
  tab: string
  /** The panel for that tab; absent for PLAN, which has its own rig view. */
  children?: ReactNode
}) {
  // Starts collapsed so the brain holds the screen, as the blueprint's mobile
  // mock shows: a large 3D view over a compact strip carrying the coordinate
  // and the clearance state. Controls are one tap away on the grip.
  const [expanded, setExpanded] = useState(false)
  const report = useAppStore((s) => s.collisionReport)

  // Choosing a tab is a request to see it, so the sheet opens. Skipped on the
  // first render, which would otherwise defeat the collapsed default above.
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current) setExpanded(true)
    else mounted.current = true
  }, [tab])

  // The authoring panels are dense — a region tree, an experiment list — and
  // half a screen turns them into a letterbox. The rig view keeps the blueprint
  // 50vh, because there the brain is the point.
  const tall = expanded && tab !== 'PLAN'

  return (
    <div
      className={
        [
          'msheet',
          expanded ? 'msheet--open' : '',
          tall ? 'msheet--tall' : '',
        ]
          .filter(Boolean)
          .join(' ')
      }
    >
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
        <div className="msheet__body">
          {tab === 'PLAN' ? (
            <>
              <TargetTab atlas={atlas} profile={profile} target={target} />
              <h4 className="msheet__heading">Clearance</h4>
              <ClearanceTab />
            </>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  )
}
