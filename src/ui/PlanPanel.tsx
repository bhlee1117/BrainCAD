/**
 * PLAN panel: coordinate entry, target list, and the anatomical readout that
 * answers "which region is my target in".
 */

import { useCallback } from 'react'

import { UNLABELLED } from '../atlas/annotation.ts'
import { formatStereotaxic, type Stereotaxic } from '../atlas/coords.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import { ancestorsOf, colorComponents } from '../atlas/ontology.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { useAppStore, type Target } from '../state/store.ts'

function CoordinateInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div className="field">
      <label htmlFor={`coord-${label}`}>{label}</label>
      <input
        id={`coord-${label}`}
        type="number"
        step={0.05}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number.parseFloat(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
      <span className="unit">mm</span>
    </div>
  )
}

/** The structure containing the current target, with its ancestry. */
function RegionReadout({
  atlas,
  profile,
  coord,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  coord: Stereotaxic
}) {
  const id = atlas.volume.labelAt(profile, coord)

  if (id === UNLABELLED) {
    return (
      <div className="region region--empty">
        <div className="region__acronym">—</div>
        <div className="region__name">
          Outside annotated tissue. The target is in open space, or beyond the atlas volume.
        </div>
      </div>
    )
  }

  const structure = atlas.index.byId.get(id)
  if (!structure) {
    return (
      <div className="region region--empty">
        <div className="region__acronym">id {id}</div>
        <div className="region__name">Label is not present in the loaded ontology.</div>
      </div>
    )
  }

  const [r, g, b] = colorComponents(structure)
  const ancestry = ancestorsOf(atlas.index, id)
    .slice(1, -1)
    .map((s) => s.acronym)

  return (
    <div className="region" style={{ borderLeftColor: `rgb(${r},${g},${b})` }}>
      <div className="region__acronym">{structure.acronym}</div>
      <div className="region__name">{structure.name}</div>
      {ancestry.length > 0 && <div className="region__path">{ancestry.join(' › ')}</div>}
    </div>
  )
}

/** Depth of the brain surface directly above the target, along a vertical approach. */
function EntryReadout({
  atlas,
  profile,
  coord,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  coord: Stereotaxic
}) {
  const entry = atlas.volume.firstLabelledPoint(
    profile,
    { ...coord, dv: 6 },
    { ...coord, dv: coord.dv },
  )

  if (!entry) {
    return (
      <div className="row">
        <span>Vertical entry</span>
        <b>no tissue above</b>
      </div>
    )
  }

  const structure = atlas.index.byId.get(entry.id)
  const insertion = entry.coord.dv - coord.dv

  return (
    <>
      <div className="row">
        <span>Surface DV</span>
        <b>{entry.coord.dv.toFixed(2)} mm</b>
      </div>
      <div className="row">
        <span>Insertion depth</span>
        <b>{insertion.toFixed(2)} mm</b>
      </div>
      <div className="row">
        <span>Enters at</span>
        <b>{structure?.acronym ?? '—'}</b>
      </div>
    </>
  )
}

/** Structures a vertical pipette would pass through on the way to the target. */
function TrajectoryReadout({
  atlas,
  profile,
  coord,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  coord: Stereotaxic
}) {
  const runs = atlas.volume
    .structuresAlong(profile, { ...coord, dv: 6 }, coord)
    .filter((run) => run.id !== UNLABELLED)

  if (runs.length === 0) return <div className="row">No structures crossed.</div>

  return (
    <div className="results">
      {runs.map((run, i) => {
        const structure = atlas.index.byId.get(run.id)
        if (!structure) return null
        const [r, g, b] = colorComponents(structure)
        return (
          <div className="result" key={`${run.id}-${i}`}>
            <span className="result__swatch" style={{ background: `rgb(${r},${g},${b})` }} />
            <span className="result__acronym">{structure.acronym}</span>
            <span className="result__name">
              {(run.exitMm - run.entryMm).toFixed(2)} mm
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function PlanPanel({
  atlas,
  profile,
  target,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  target: Target | null
}) {
  const updateTarget = useAppStore((s) => s.updateTarget)

  const setCoord = useCallback(
    (patch: Partial<Stereotaxic>) => {
      if (target) updateTarget(target.id, { coord: { ...target.coord, ...patch } })
    },
    [target, updateTarget],
  )

  if (!target) {
    return (
      <div className="section">
        <h2>Plan</h2>
        <p style={{ color: 'var(--text-dim)' }}>No target selected.</p>
      </div>
    )
  }

  return (
    <>
      <div className="section">
        <h2>Target</h2>
        <div className="field">
          <label htmlFor="target-name">Name</label>
          <input
            id="target-name"
            type="text"
            value={target.name}
            onChange={(event) => updateTarget(target.id, { name: event.target.value })}
          />
        </div>
        <CoordinateInput label="AP" value={target.coord.ap} onChange={(ap) => setCoord({ ap })} />
        <CoordinateInput label="ML" value={target.coord.ml} onChange={(ml) => setCoord({ ml })} />
        <CoordinateInput label="DV" value={target.coord.dv} onChange={(dv) => setCoord({ dv })} />
        <div style={{ color: 'var(--text-faint)', fontSize: 11, marginTop: 4 }}>
          {formatStereotaxic(target.coord)}
        </div>
      </div>

      <div className="section">
        <h2>Region at target</h2>
        <RegionReadout atlas={atlas} profile={profile} coord={target.coord} />
      </div>

      <div className="section">
        <h2>Vertical approach</h2>
        <EntryReadout atlas={atlas} profile={profile} coord={target.coord} />
      </div>

      <div className="section">
        <h2>Structures crossed</h2>
        <TrajectoryReadout atlas={atlas} profile={profile} coord={target.coord} />
      </div>
    </>
  )
}
