/**
 * OVERLAYS panel: find a tracing experiment, load it, tune what is shown.
 *
 * The flow mirrors how someone actually asks the question — "what projects from
 * here?" — so it starts from a source structure rather than an experiment id.
 */

import { useMemo, useState } from 'react'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { parseNrrdAsync } from '../atlas/nrrd.ts'
import { makeVolumeSpace } from '../atlas/space.ts'
import { searchStructures } from '../atlas/ontology.ts'
import {
  describeExperiment,
  experimentCitation,
  experimentUrl,
  projectionVolumeUrl,
  searchExperiments,
  type ConnectivityExperiment,
} from '../overlays/connectivity.ts'
import {
  CONNECTIVITY_CAVEATS,
  overlayColorFor,
  type ProjectionOverlay,
} from '../overlays/model.ts'
import {
  DEFAULT_POINT_CLOUD_OPTIONS,
  buildProjectionPointCloud,
  densityColors,
  positionsToWorld,
} from '../overlays/pointCloud.ts'
import { atlasToWorldMatrix } from '../scene/world.ts'
import { useAppStore } from '../state/store.ts'

let overlayCounter = 0

export function OverlaysPanel({
  atlas,
  profile,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  const overlays = useAppStore((s) => s.overlays)
  const addOverlay = useAppStore((s) => s.addOverlay)
  const updateOverlay = useAppStore((s) => s.updateOverlay)
  const removeOverlay = useAppStore((s) => s.removeOverlay)

  const [query, setQuery] = useState('')
  const [structureId, setStructureId] = useState<number | null>(null)
  const [experiments, setExperiments] = useState<ConnectivityExperiment[] | null>(null)
  const [totalExperiments, setTotalExperiments] = useState(0)
  const [threshold, setThreshold] = useState(DEFAULT_POINT_CLOUD_OPTIONS.threshold)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const matches = useMemo(
    () => (query.trim() ? searchStructures(atlas.index, query, 8) : []),
    [atlas.index, query],
  )

  const selectedStructure = structureId ? atlas.index.byId.get(structureId) : null

  // Injections target whole regions far more often than individual layers, so
  // the parent is usually the useful next thing to try.
  const parentAcronym =
    selectedStructure?.parentId != null
      ? (atlas.index.byId.get(selectedStructure.parentId)?.acronym ?? null)
      : null

  async function findExperiments(id: number) {
    setStructureId(id)
    setExperiments(null)
    setError(null)
    setBusy('Searching Allen Connectivity Atlas…')
    try {
      const all = await searchExperiments(id, { limit: 10_000 })
      setTotalExperiments(all.length)
      setExperiments(all.slice(0, 40))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // Separate "the service is having a moment" from "this region has no
      // tracing data" — they look identical in the raw response but mean
      // opposite things to someone planning an experiment.
      setError(
        /busy|informatics service/i.test(message)
          ? 'The Allen connectivity service did not respond after several attempts. ' +
              'This is usually temporary — try that region again.'
          : message,
      )
    } finally {
      setBusy(null)
    }
  }

  async function loadExperiment(experiment: ConnectivityExperiment) {
    setError(null)
    setBusy(`Loading experiment ${experiment.id}…`)

    try {
      const response = await fetch(projectionVolumeUrl(experiment.id, 100))
      if (!response.ok) throw new Error(`Volume download failed: HTTP ${response.status}`)

      const nrrd = await parseNrrdAsync(await response.arrayBuffer())

      // The connectivity grid is the same CCF space as the annotation volume,
      // at its own resolution — so the shared axis convention applies directly.
      const space = makeVolumeSpace(nrrd.shape, nrrd.spacing[0], 'asr')
      const density =
        nrrd.data instanceof Float32Array
          ? nrrd.data
          : Float32Array.from(nrrd.data as ArrayLike<number>)

      const cloud = buildProjectionPointCloud(density, space, {
        ...DEFAULT_POINT_CLOUD_OPTIONS,
        threshold,
      })

      if (cloud.pointCount === 0) {
        setError(
          `Nothing above threshold ${threshold.toFixed(2)} — the peak density in this ` +
            `experiment is ${cloud.maxDensity.toFixed(3)}. Lower the threshold and retry.`,
        )
        return
      }

      const color = overlayColorFor(overlays.length)
      overlayCounter += 1

      const overlay: ProjectionOverlay = {
        id: `overlay-${overlayCounter}`,
        kind: 'projection-points',
        name: `${experiment.structureAbbrev} → projections`,
        visible: true,
        color,
        pointSizeMm: 0.08,
        opacity: 0.85,
        threshold,
        experimentId: experiment.id,
        provenance: {
          evidence: 'measured',
          citation: experimentCitation(experiment),
          url: experimentUrl(experiment.id),
          registeredTo: 'Allen CCFv3',
          resolutionUm: nrrd.spacing[0],
          caveats: CONNECTIVITY_CAVEATS,
        },
        cloud,
        worldPositions: positionsToWorld(cloud.positionsUm, atlasToWorldMatrix(profile)),
        colors: densityColors(cloud, color),
      }

      addOverlay(overlay)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="section">
        <h2>Projections from a region</h2>
        <div className="field">
          <input
            type="text"
            placeholder="VISp, CA1, MOs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {matches.length > 0 && (
          <div className="results">
            {matches.map((structure) => (
              <button
                key={structure.id}
                className="result"
                aria-pressed={structure.id === structureId}
                onClick={() => void findExperiments(structure.id)}
              >
                <span className="result__acronym">{structure.acronym}</span>
                <span className="result__name">{structure.name}</span>
              </button>
            ))}
          </div>
        )}

        <p className="hint">
          Searches the Allen Mouse Brain Connectivity Atlas for anterograde tracing experiments
          injected into that structure.
        </p>
      </div>

      {busy && <div className="status status--ok">{busy}</div>}
      {error && (
        <div className="status status--error">
          <div className="status__head">Search failed</div>
          <div className="status__line">{error}</div>
          {structureId !== null && (
            <button
              className="btn"
              style={{ marginTop: 8 }}
              disabled={busy !== null}
              onClick={() => void findExperiments(structureId)}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {experiments && (
        <div className="section">
          <h2>
            {selectedStructure?.acronym ?? 'Experiments'} —{' '}
            {totalExperiments > experiments.length
              ? `${experiments.length} of ${totalExperiments}`
              : `${experiments.length}`}{' '}
            experiment{totalExperiments === 1 ? '' : 's'}
          </h2>

          <div className="field">
            <label htmlFor="proj-threshold">Thresh</label>
            <input
              id="proj-threshold"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(event) => {
                const next = Number.parseFloat(event.target.value)
                if (Number.isFinite(next)) setThreshold(Math.max(0, next))
              }}
            />
          </div>

          {experiments.length === 0 && (
            <div className="status status--warn">
              <div className="status__head">No tracing experiments here</div>
              <div className="status__line">
                The Allen atlas has no anterograde injections whose primary site is{' '}
                {selectedStructure?.acronym ?? 'this structure'}. Fine-grained layers and
                small nuclei are rarely injected directly — try a parent region such as{' '}
                {parentAcronym ?? 'the structure above it'}.
              </div>
            </div>
          )}

          <div className="results" style={{ maxHeight: 260 }}>
            {experiments.map((experiment) => (
              <button
                key={experiment.id}
                className="result"
                onClick={() => void loadExperiment(experiment)}
                disabled={busy !== null}
                title={describeExperiment(experiment)}
              >
                <span className="result__acronym">{experiment.id}</span>
                <span className="result__name">{describeExperiment(experiment)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="section">
        <h2>Loaded overlays</h2>

        {overlays.length === 0 && (
          <p style={{ color: 'var(--text-faint)', margin: 0 }}>
            None loaded.
          </p>
        )}

        {overlays.map((overlay) => (
          <div className="overlay-card" key={overlay.id}>
            <div className="overlay-card__head">
              <span
                className="overlay-card__dot"
                style={{ background: overlay.color }}
              />
              <span className="overlay-card__name">{overlay.name}</span>
              <button
                className="icon-btn"
                title={overlay.visible ? 'Hide' : 'Show'}
                onClick={() => updateOverlay(overlay.id, { visible: !overlay.visible })}
              >
                {overlay.visible ? '◉' : '○'}
              </button>
              <button
                className="icon-btn"
                title="Remove"
                onClick={() => removeOverlay(overlay.id)}
              >
                ✕
              </button>
            </div>

            <div className="row">
              <span>Points</span>
              <b>{overlay.cloud.pointCount.toLocaleString()}</b>
            </div>
            <div className="row">
              <span>Above threshold</span>
              <b>{overlay.cloud.voxelsAboveThreshold.toLocaleString()} voxels</b>
            </div>
            <div className="row">
              <span>Threshold / peak</span>
              <b>
                {overlay.threshold.toFixed(2)} / {overlay.cloud.maxDensity.toFixed(2)}
              </b>
            </div>

            {overlay.cloud.capped && (
              <p className="hint">
                Showing the densest {overlay.cloud.pointCount.toLocaleString()} of{' '}
                {overlay.cloud.voxelsAboveThreshold.toLocaleString()} voxels above threshold.
              </p>
            )}

            <div className="field">
              <label htmlFor={`size-${overlay.id}`}>Size</label>
              <input
                id={`size-${overlay.id}`}
                type="range"
                min={0.02}
                max={0.3}
                step={0.01}
                value={overlay.pointSizeMm}
                onChange={(event) =>
                  updateOverlay(overlay.id, { pointSizeMm: Number(event.target.value) })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`op-${overlay.id}`}>Opac</label>
              <input
                id={`op-${overlay.id}`}
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={overlay.opacity}
                onChange={(event) =>
                  updateOverlay(overlay.id, { opacity: Number(event.target.value) })
                }
              />
            </div>

            <div className="provenance">
              <span className="badge badge--measured">measured</span>
              <div style={{ marginTop: 6 }}>{overlay.provenance.citation}</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 15 }}>
                {overlay.provenance.caveats.map((caveat, i) => (
                  <li key={i} style={{ marginBottom: 3 }}>
                    {caveat}
                  </li>
                ))}
              </ul>
              {overlay.provenance.url && (
                <div style={{ marginTop: 6 }}>
                  <a
                    href={overlay.provenance.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    View experiment ↗
                  </a>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
