/**
 * Left-hand panels: scene tree (targets and anatomy visibility) and the ATLAS
 * structure browser.
 */

import { useMemo, useState } from 'react'

import type { LoadedAtlas } from '../atlas/load.ts'
import { colorComponents, searchStructures } from '../atlas/ontology.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { profilesForSpace } from '../atlas/profile.ts'
import { useAppStore } from '../state/store.ts'

/** Targets and whole-brain visibility. */
export function ScenePanel() {
  const targets = useAppStore((s) => s.targets)
  const selectedTargetId = useAppStore((s) => s.selectedTargetId)
  const selectTarget = useAppStore((s) => s.selectTarget)
  const addTarget = useAppStore((s) => s.addTarget)
  const removeTarget = useAppStore((s) => s.removeTarget)
  const anatomy = useAppStore((s) => s.anatomy)
  const setAnatomy = useAppStore((s) => s.setAnatomy)

  return (
    <>
      <div className="section">
        <h2>Scene</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={anatomy.showBrain}
            onChange={(e) => setAnatomy({ showBrain: e.target.checked })}
          />
          Brain surface
        </label>
        <div className="field">
          <label htmlFor="opacity">Opac</label>
          <input
            id="opacity"
            type="range"
            min={0.03}
            max={0.75}
            step={0.01}
            value={anatomy.brainOpacity}
            onChange={(e) => setAnatomy({ brainOpacity: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="section">
        <h2>Targets</h2>
        {targets.map((target) => (
          <div
            key={target.id}
            className="target"
            aria-current={target.id === selectedTargetId}
            onClick={() => selectTarget(target.id)}
          >
            <span className="target__dot" />
            <span className="target__name">{target.name}</span>
            <span className="target__coord">
              {target.coord.ap.toFixed(1)}/{target.coord.ml.toFixed(1)}/
              {target.coord.dv.toFixed(1)}
            </span>
          </div>
        ))}
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn"
            onClick={() => addTarget({ ap: 0, ml: 0, dv: -2 })}
          >
            + Target
          </button>
          {targets.length > 1 && selectedTargetId && (
            <button className="btn" onClick={() => removeTarget(selectedTargetId)}>
              Remove
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/** ATLAS panel: structure search and region mesh toggles. */
export function AtlasPanel({ atlas }: { atlas: LoadedAtlas }) {
  const [query, setQuery] = useState('')
  const visibleStructureIds = useAppStore((s) => s.anatomy.visibleStructureIds)
  const toggleStructure = useAppStore((s) => s.toggleStructure)

  const results = useMemo(() => searchStructures(atlas.index, query, 40), [atlas.index, query])

  /** Meshes that ship with the app can be toggled instantly. */
  const availableIds = useMemo(
    () => new Set(atlas.manifest.meshes.map((m) => m.id)),
    [atlas.manifest],
  )

  return (
    <>
      <div className="section">
        <h2>Find a region</h2>
        <div className="field">
          <input
            type="text"
            placeholder="CA1, thalamus, VTA…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {query.trim() !== '' && (
          <div className="results">
            {results.length === 0 && (
              <div style={{ color: 'var(--text-faint)', padding: '4px 6px' }}>No matches.</div>
            )}
            {results.map((structure) => {
              const [r, g, b] = colorComponents(structure)
              const shipped = availableIds.has(structure.id)
              return (
                <button
                  key={structure.id}
                  className="result"
                  aria-pressed={visibleStructureIds.includes(structure.id)}
                  onClick={() => toggleStructure(structure.id)}
                  title={
                    shipped
                      ? structure.name
                      : `${structure.name} — mesh not bundled; will not render yet`
                  }
                  disabled={!shipped}
                  style={shipped ? undefined : { opacity: 0.4 }}
                >
                  <span
                    className="result__swatch"
                    style={{ background: `rgb(${r},${g},${b})` }}
                  />
                  <span className="result__acronym">{structure.acronym}</span>
                  <span className="result__name">{structure.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="section">
        <h2>Bundled regions</h2>
        <div className="results" style={{ maxHeight: 300 }}>
          {atlas.manifest.meshes
            .filter((m) => m.id !== 997)
            .map((mesh) => {
              const structure = atlas.index.byId.get(mesh.id)
              if (!structure) return null
              const [r, g, b] = colorComponents(structure)
              return (
                <button
                  key={mesh.id}
                  className="result"
                  aria-pressed={visibleStructureIds.includes(mesh.id)}
                  onClick={() => toggleStructure(mesh.id)}
                  title={structure.name}
                >
                  <span
                    className="result__swatch"
                    style={{ background: `rgb(${r},${g},${b})` }}
                  />
                  <span className="result__acronym">{structure.acronym}</span>
                  <span className="result__name">{structure.name}</span>
                </button>
              )
            })}
        </div>
      </div>
    </>
  )
}

/** Coordinate profile selector with its provenance, per blueprint §4. */
export function ProfilePanel({
  atlas,
  profile,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  const setProfileId = useAppStore((s) => s.setProfileId)
  const valid = useMemo(() => profilesForSpace(atlas.space), [atlas.space])

  const badgeClass =
    profile.provenance.confidence === 'published' ? 'badge--published' : 'badge--convention'

  return (
    <div className="section">
      <h2>Coordinate profile</h2>
      <select value={profile.id} onChange={(e) => setProfileId(e.target.value)}>
        {valid.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <div className="provenance">
        <span className={`badge ${badgeClass}`}>{profile.provenance.confidence}</span>
        <div style={{ marginTop: 6 }}>{profile.provenance.citation}</div>
        <ul style={{ margin: '6px 0 0', paddingLeft: 15 }}>
          {profile.provenance.caveats.map((caveat, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {caveat}
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 6 }}>
          DV referenced to <b>{profile.dvReference.replace('-', ' ')}</b>.
        </div>
      </div>
    </div>
  )
}
