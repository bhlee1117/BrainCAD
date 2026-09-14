/**
 * OVERLAYS panel: find a tracing experiment, load it, tune what is shown.
 *
 * The flow mirrors how someone actually asks the question — "what projects from
 * here?" — so it starts from a source structure rather than an experiment id.
 */

import { useEffect, useMemo, useState } from 'react'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { parseNrrdAsync } from '../atlas/nrrd.ts'
import { makeVolumeSpace } from '../atlas/space.ts'
import { searchStructures } from '../atlas/ontology.ts'
import {
  describeDriver,
  loadGene,
  loadTransgenicLines,
  type GeneIdentity,
  type LineIndex,
} from '../overlays/transgenicLines.ts'
import {
  CELL_CLASS_CAVEAT,
  CONFIDENCE_LABEL,
  cellClassForLine,
  geneFromLineName,
} from '../overlays/cellClasses.ts'
import {
  experimentCitation,
  experimentUrl,
  injectionVolumeUrl,
  projectionVolumeUrl,
  searchExperiments,
  type ConnectivityExperiment,
} from '../overlays/connectivity.ts'
import {
  CONNECTIVITY_CAVEATS,
  overlayColorFor,
  type InjectionSite,
  type ProjectionOverlay,
} from '../overlays/model.ts'
import {
  DEFAULT_POINT_CLOUD_OPTIONS,
  buildProjectionPointCloud,
  densityColors,
  positionsToWorld,
} from '../overlays/pointCloud.ts'
import { voxelToStereotaxic } from '../atlas/coords.ts'
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
  const [lines, setLines] = useState<LineIndex>(() => new Map())
  const [expanded, setExpanded] = useState<number | null>(null)
  const [genes, setGenes] = useState<Record<string, GeneIdentity | null>>({})

  // Loaded once and cached; the list still works without it, just without the
  // plain-language descriptions.
  useEffect(() => {
    let live = true
    void loadTransgenicLines().then((index) => {
      if (live) setLines(index)
    })
    return () => {
      live = false
    }
  }, [])

  const matches = useMemo(
    () => (query.trim() ? searchStructures(atlas.index, query, 8) : []),
    [atlas.index, query],
  )

  // Gene identity is fetched only for the row being inspected; the list itself
  // does not need it, and there is no reason to pull forty gene records to
  // render forty lines.
  useEffect(() => {
    if (expanded === null) return
    const experiment = experiments?.find((e) => e.id === expanded)
    const gene = experiment ? geneFromLineName(experiment.transgenicLine) : null
    if (!gene || gene in genes) return

    let live = true
    void loadGene(gene).then((identity) => {
      if (live) setGenes((previous) => ({ ...previous, [gene]: identity }))
    })
    return () => {
      live = false
    }
  }, [expanded, experiments, genes])

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
      // Both volumes, in parallel. The injection volume is under 10 KB, so
      // separating the site from the projections costs essentially nothing.
      const [projectionResponse, injectionResponse] = await Promise.all([
        fetch(projectionVolumeUrl(experiment.id, 100)),
        fetch(injectionVolumeUrl(experiment.id, 100)),
      ])
      if (!projectionResponse.ok) {
        throw new Error(`Volume download failed: HTTP ${projectionResponse.status}`)
      }

      const nrrd = await parseNrrdAsync(await projectionResponse.arrayBuffer())
      const space = makeVolumeSpace(nrrd.shape, nrrd.spacing[0], 'asl')
      const density =
        nrrd.data instanceof Float32Array
          ? nrrd.data
          : Float32Array.from(nrrd.data as ArrayLike<number>)

      // The injection volume is optional: without it the projection cloud still
      // renders, it just cannot separate the site.
      let injectionFraction: Float32Array | null = null
      if (injectionResponse.ok) {
        try {
          const injectionNrrd = await parseNrrdAsync(await injectionResponse.arrayBuffer())
          injectionFraction =
            injectionNrrd.data instanceof Float32Array
              ? injectionNrrd.data
              : Float32Array.from(injectionNrrd.data as ArrayLike<number>)
        } catch {
          injectionFraction = null
        }
      }

      const matrix = atlasToWorldMatrix(profile)

      const cloud = buildProjectionPointCloud(density, space, {
        ...DEFAULT_POINT_CLOUD_OPTIONS,
        threshold,
        mask: injectionFraction,
      })

      if (cloud.pointCount === 0) {
        setError(
          `Nothing above threshold ${threshold.toFixed(2)} outside the injection site — ` +
            `the peak projection density here is ${cloud.maxDensity.toFixed(3)}. ` +
            `Lower the threshold and retry.`,
        )
        return
      }

      // The injection site as its own cloud, from the fraction volume.
      let injectionCloud = null
      let injectionWorld: Float32Array | null = null
      if (injectionFraction) {
        injectionCloud = buildProjectionPointCloud(injectionFraction, space, {
          threshold: 0.5,
          maxPoints: 40_000,
          mask: null,
        })
        injectionWorld = positionsToWorld(injectionCloud.positionsUm, matrix)
      }

      // The API reports the injection centre in CCF micrometres, in the same
      // axis order as the volume, so it converts through the active profile
      // exactly like any other coordinate.
      //
      // Verified rather than assumed, because a swapped axis would put the
      // marker millimetres away while still looking plausible. Over 24
      // experiments across CP, CB, STR, HPF and VIS, this triple sits a mean
      // 475 um (max 757 um) from the centroid of the same experiment's
      // injection_fraction volume; swapping axes 0 and 2 pushes that to a mean
      // of 3495 um. The residual is Allen's density-weighted centroid against a
      // 0.5-thresholded one, not a registration error — so the marker is drawn
      // at Allen's reported centre and the white cloud shows the true extent.
      let centre: InjectionSite['centre'] = null
      if (experiment.injectionCoordinatesUm) {
        const [a, b, c] = experiment.injectionCoordinatesUm
        centre = voxelToStereotaxic(profile, {
          i0: a / profile.space.resolutionUm,
          i1: b / profile.space.resolutionUm,
          i2: c / profile.space.resolutionUm,
        })
      }

      const injection: InjectionSite = {
        centre,
        volumeMm3: experiment.injectionVolumeMm3,
        structures: experiment.injectionStructures,
        cloud: injectionCloud,
        worldPositions: injectionWorld,
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
        injection,
        excludeInjection: true,
        showInjection: true,
        provenance: {
          evidence: 'measured',
          citation: experimentCitation(experiment),
          url: experimentUrl(experiment.id),
          registeredTo: 'Allen CCFv3',
          resolutionUm: nrrd.spacing[0],
          caveats: CONNECTIVITY_CAVEATS,
        },
        cloud,
        worldPositions: positionsToWorld(cloud.positionsUm, matrix),
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

          <div className="explist">
            {experiments.map((experiment) => {
              const driver = describeDriver(experiment.transgenicLine, lines)
              const cellClass = cellClassForLine(experiment.transgenicLine)
              const isOpen = expanded === experiment.id

              return (
                <div className="exp" key={experiment.id}>
                  <div className="exp__main">
                    <button
                      className="exp__load"
                      onClick={() => void loadExperiment(experiment)}
                      disabled={busy !== null}
                    >
                      {/* The driver leads, because "which cells were labelled"
                          is the question someone scanning this list is asking.
                          The experiment id is an identifier, not information. */}
                      <span className="exp__driver">
                        {experiment.structureAbbrev} · {driver.label}
                      </span>
                      {/* The cell class answers the question being asked, so it
                          leads when one is established. Allen's anatomical
                          description is real but different information, and it
                          sits below. */}
                      {cellClass ? (
                        <span className="exp__population">{cellClass.population}</span>
                      ) : driver.population ? (
                        <span className="exp__population exp__population--anat">
                          {driver.population}
                        </span>
                      ) : null}
                      <span className="exp__meta">
                        {experiment.injectionVolumeMm3 !== null
                          ? `${experiment.injectionVolumeMm3.toFixed(2)} mm³`
                          : 'volume not reported'}
                        {experiment.strain ? ` · ${experiment.strain}` : ''}
                      </span>
                    </button>

                    <button
                      className="exp__more"
                      aria-expanded={isOpen}
                      title={isOpen ? 'Hide details' : 'Show details'}
                      onClick={() => setExpanded(isOpen ? null : experiment.id)}
                    >
                      {isOpen ? '−' : 'i'}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="exp__detail">
                      {cellClass && (
                        <div className="cellclass">
                          <div className="cellclass__head">
                            <span className="cellclass__pop">{cellClass.population}</span>
                            <span className="cellclass__conf">
                              {CONFIDENCE_LABEL[cellClass.confidence]}
                            </span>
                          </div>
                          <div className="cellclass__marker">{cellClass.marker}</div>
                          {cellClass.caveat && (
                            <div className="cellclass__caveat">{cellClass.caveat}</div>
                          )}
                          <div className="cellclass__source">{CELL_CLASS_CAVEAT}</div>
                        </div>
                      )}

                      {(() => {
                        const gene = geneFromLineName(experiment.transgenicLine)
                        const identity = gene ? genes[gene] : null
                        if (!identity) return null
                        return (
                          <p className="exp__gene">
                            <b>{identity.symbol}</b>
                            {identity.alias ? ` (${identity.alias})` : ''} — {identity.name}
                          </p>
                        )
                      })()}

                      {driver.line?.description ? (
                        <p className="exp__desc">
                          <span className="exp__desclabel">Allen — expression pattern:</span>{' '}
                          {driver.line.description}
                        </p>
                      ) : experiment.transgenicLine ? (
                        <p className="exp__desc exp__desc--missing">
                          No expression description published for this line.
                        </p>
                      ) : (
                        <p className="exp__desc">
                          No Cre driver — the tracer labelled all cell types at the
                          injection site.
                        </p>
                      )}

                      <div className="exp__facts">
                        <span>Experiment {experiment.id}</span>
                        {driver.line?.stockNumber && (
                          <span>
                            {driver.line.sourceName ?? 'Stock'} {driver.line.stockNumber}
                          </span>
                        )}
                        {experiment.gender && <span>{experiment.gender}</span>}
                      </div>

                      <div className="exp__links">
                        <a
                          href={experimentUrl(experiment.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Experiment page ↗
                        </a>
                        {driver.line?.url && (
                          <a href={driver.line.url} target="_blank" rel="noreferrer">
                            Line at {driver.line.sourceName ?? 'source'} ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
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

            <div className="injection">
              <div className="injection__head">
                <span className="injection__dot" />
                Injection site
              </div>

              {overlay.injection.centre ? (
                <div className="row">
                  <span>Centre</span>
                  <b>
                    AP {overlay.injection.centre.ap.toFixed(2)} · ML{' '}
                    {overlay.injection.centre.ml.toFixed(2)} · DV{' '}
                    {overlay.injection.centre.dv.toFixed(2)}
                  </b>
                </div>
              ) : (
                <div className="row">
                  <span>Centre</span>
                  <b>not reported</b>
                </div>
              )}

              {overlay.injection.volumeMm3 !== null && (
                <div className="row">
                  <span>Volume</span>
                  <b>{overlay.injection.volumeMm3.toFixed(2)} mm³</b>
                </div>
              )}

              {overlay.injection.structures.length > 0 && (
                <div className="injection__structures">
                  <span>Spanned </span>
                  {overlay.injection.structures.join(', ')}
                  {overlay.injection.structures.length > 1 && (
                    <span>
                      {' '}
                      — the injection was not confined to the named region, so the
                      projections are not attributable to it alone.
                    </span>
                  )}
                </div>
              )}

              {overlay.injection.centre && (
                <p className="hint" style={{ marginTop: 5 }}>
                  Hemisphere is taken from Allen&rsquo;s own injection labels, which agree
                  with the volume&rsquo;s ML axis in 36 of 36 checked experiments. Confirm
                  left/right at the rig regardless.
                </p>
              )}

              {overlay.cloud.maskedOut > 0 && (
                <p className="hint" style={{ marginTop: 6 }}>
                  {overlay.cloud.maskedOut.toLocaleString()} saturated injection-site voxels
                  are excluded from the projection cloud and drawn in white. Projection
                  density includes the site, where it reaches 1.0 — leaving it in would make
                  the source look like the strongest target.
                </p>
              )}

              <label className="check" style={{ marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={overlay.showInjection}
                  onChange={(event) =>
                    updateOverlay(overlay.id, { showInjection: event.target.checked })
                  }
                />
                Show injection site
              </label>
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
