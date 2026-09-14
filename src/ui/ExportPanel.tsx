/**
 * EXPORT panel: save and reopen a project, and produce a planning sheet.
 */

import { useRef, useState } from 'react'

import { NumberField } from './NumberField.tsx'
import { UNLABELLED } from '../atlas/annotation.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { restoreProject, serialiseProject } from '../project/project.ts'
import { parseProject, projectFilename } from '../project/schema.ts'
import { renderPlanningSheet, sheetFilename } from '../project/sheet.ts'
import { renderObjectiveView } from '../optics/objectiveView.ts'
import { renderOverviewViews } from '../optics/overviewViews.ts'
import { captureViewport } from '../optics/viewportCapture.ts'
import { getSceneHandle } from '../scene/handle.ts'
import {
  AXIS_LABEL,
  SECTION_AXES,
  SECTION_RANGE_MM,
  describeSection,
  isSectioning,
  type SectionSide,
} from '../scene/section.ts'
import { hydrateBuiltinGeometry } from '../objects/builtins.ts'
import { releaseAllCustomGeometry } from '../objects/model.ts'
import { MIRROR_CAVEAT } from '../overlays/model.ts'
import { adoptObjectIds, useAppStore } from '../state/store.ts'

/** Trigger a browser download of text content. */
function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on the next tick so the download has taken the reference.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Trigger a browser download of a data URL. */
function downloadDataUrl(filename: string, dataUrl: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/**
 * Section controls: one plane per stereotaxic axis, each naming the side it
 * removes in anatomical words rather than as a sign.
 *
 * "Remove +X" is a statement about the coordinate system; "remove dorsal" is a
 * statement about the animal, and is the one a surgeon can check at a glance.
 * The distinction matters because a section with the wrong side removed still
 * produces a convincing image — of the half you did not want.
 */
function SectionControls() {
  const section = useAppStore((s) => s.section)
  const setSectionPlane = useAppStore((s) => s.setSectionPlane)
  const clearSection = useAppStore((s) => s.clearSection)

  return (
    <div className="section">
      <h2>Section planes</h2>

      {SECTION_AXES.map((axis) => {
        const plane = section[axis]
        const label = AXIS_LABEL[axis]

        return (
          <div key={axis} className="section-plane">
            <label className="check">
              <input
                type="checkbox"
                checked={plane.enabled}
                onChange={(event) =>
                  setSectionPlane(axis, { enabled: event.target.checked })
                }
              />
              Cut along {label.axis}
            </label>

            {plane.enabled && (
              <>
                <div className="field">
                  <label htmlFor={`sec-${axis}-pos`}>At</label>
                  <NumberField
                    id={`sec-${axis}-pos`}
                    step={0.1}
                    value={plane.positionMm}
                    onChange={(positionMm) => setSectionPlane(axis, { positionMm })}
                  />
                  <span className="unit">mm</span>
                </div>
                <input
                  type="range"
                  min={-SECTION_RANGE_MM}
                  max={SECTION_RANGE_MM}
                  step={0.05}
                  value={plane.positionMm}
                  onChange={(event) =>
                    setSectionPlane(axis, { positionMm: Number(event.target.value) })
                  }
                />
                <div className="field">
                  <label htmlFor={`sec-${axis}-side`}>Remove</label>
                  <select
                    id={`sec-${axis}-side`}
                    value={plane.remove}
                    onChange={(event) =>
                      setSectionPlane(axis, {
                        remove: event.target.value as SectionSide,
                      })
                    }
                  >
                    <option value="positive">
                      {label.positive} (+{label.axis})
                    </option>
                    <option value="negative">
                      {label.negative} (−{label.axis})
                    </option>
                  </select>
                </div>
              </>
            )}
          </div>
        )
      })}

      {isSectioning(section) && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="btn" onClick={clearSection}>
            Clear sections
          </button>
        </div>
      )}

      <p className="hint">
        Display only — collision, clearance and measurement still see the whole solid.
        Cut surfaces are not capped, so a sectioned barrel shows its inside wall rather
        than a filled cross-section. Captures and the planning sheet are rendered through
        the same renderer, so they come out sectioned exactly as the screen is.
      </p>
    </div>
  )
}

export function ExportPanel({
  atlas,
  profile,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  const store = useAppStore()
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('Surgical plan')
  const [notes, setNotes] = useState('')
  const [created] = useState(() => new Date().toISOString())
  const [includeScreenshot, setIncludeScreenshot] = useState(true)
  const [includeCurrentView, setIncludeCurrentView] = useState(true)
  const [includeObjectiveViews, setIncludeObjectiveViews] = useState(true)
  const [status, setStatus] = useState<{
    kind: 'ok' | 'error' | 'warn'
    lines: string[]
  } | null>(null)

  const snapshot = () => ({
    name,
    notes,
    created,
    profile,
    atlas,
    anatomy: store.anatomy,
    targets: store.targets,
    objects: store.objects,
    measurements: store.measurements,
    collisionSettings: store.collisionSettings,
  })

  function saveProject() {
    const file = serialiseProject(snapshot())
    download(projectFilename(name), JSON.stringify(file, null, 2), 'application/json')
    setStatus({ kind: 'ok', lines: [`Saved ${projectFilename(name)}`] })
  }

  /**
   * The name a capture of the current camera carries.
   *
   * Any active section is written into the name rather than left implicit: a
   * sectioned capture looks like an intact preparation that happens to be
   * transparent, and a reader months later has no way to tell the difference.
   */
  function currentViewName(): string {
    const cut = describeSection(store.section)
    return cut ? `Current view — sectioned (${cut})` : 'Current view'
  }

  function captureCurrentView(): { name: string; dataUrl: string } | null {
    const handle = getSceneHandle()
    if (!handle) return null
    const capture = captureViewport(handle.gl, handle.scene, handle.camera)
    return capture ? { name: currentViewName(), dataUrl: capture.dataUrl } : null
  }

  function saveCurrentView() {
    const capture = captureCurrentView()
    if (!capture) {
      setStatus({
        kind: 'error',
        lines: [
          'Could not capture the viewport.',
          'The 3D view must be open and rendering — see the console for details.',
        ],
      })
      return
    }

    downloadDataUrl(`${projectFilename(name).replace(/\.braincad\.json$/, '')}-view.png`, capture.dataUrl)
    setStatus({ kind: 'ok', lines: ['Saved the current view as a PNG.', capture.name] })
  }

  function exportSheet() {
    const project = serialiseProject(snapshot())

    // Region at each target, resolved through the same volume the app uses.
    const targetRegions: Record<string, string> = {}
    for (const target of store.targets) {
      const id = atlas.volume.labelAt(profile, target.coord)
      targetRegions[target.id] =
        id === UNLABELLED ? '—' : (atlas.index.byId.get(id)?.acronym ?? '—')
    }

    // Simulated view down each objective's axis, rendered from the live scene.
    const objectiveViews: {
      name: string
      dataUrl: string
      fieldOfViewMm: number
      workingDistanceMm: number
      extentMm: number
    }[] = []

    let overviewViews: { name: string; dataUrl: string }[] = []
    // The user's own framing goes first: it is the view they chose, and the
    // four standard ones are the context around it.
    if (includeCurrentView) {
      const capture = captureCurrentView()
      if (capture) overviewViews.push(capture)
      else console.warn('No live renderer available; the current view was skipped.')
    }
    if (includeScreenshot) {
      const handle = getSceneHandle()
      if (!handle) {
        console.warn('No live renderer available; overview captures were skipped.')
      } else {
        overviewViews = [...overviewViews, ...renderOverviewViews(handle.gl, handle.scene)]
      }
    }

    const objectiveCount = store.objects.filter(
      (o) => o.kind === 'objective' && o.visible,
    ).length

    if (includeObjectiveViews && objectiveCount > 0) {
      const handle = getSceneHandle()
      if (!handle) {
        console.warn('No live renderer available; objective views were skipped.')
      } else {
        for (const object of store.objects) {
          if (object.kind !== 'objective' || !object.visible) continue
          const view = renderObjectiveView(handle.gl, handle.scene, object)
          if (view) objectiveViews.push({ name: object.name, ...view })
        }
      }
    }

    const html = renderPlanningSheet({
      project,
      objects: store.objects,
      measurements: store.measurements,
      collision: store.collisionReport,
      overviewViews,
      objectiveViews,
      // A neuron and a projection volume are both overlays, but they carry
      // different evidence and the sheet must not flatten them into one row
      // shape — "threshold 0.05" against a traced arbor would be meaningless.
      overlays: store.overlays.map((o) =>
        o.kind === 'neuron-arbor'
          ? {
              name: o.name,
              experimentId: null,
              threshold: null,
              pointCount: o.totalNodes,
              injectionSummary: null,
              injectionStructures: o.somaAcronym ? [o.somaAcronym] : [],
              evidence: o.provenance.evidence,
              mirrored: o.mirrored,
              citation: o.provenance.citation,
              url: o.provenance.url,
              resolutionUm: o.provenance.resolutionUm,
              caveats: o.mirrored
                ? [MIRROR_CAVEAT, ...o.provenance.caveats]
                : o.provenance.caveats,
            }
          : {
              name: o.name,
              experimentId: o.experimentId,
              threshold: o.threshold,
              pointCount: o.cloud.pointCount,
              injectionSummary: o.injection.centre
                ? `AP ${o.injection.centre.ap.toFixed(2)}, ML ${o.injection.centre.ml.toFixed(2)}, ` +
                  `DV ${o.injection.centre.dv.toFixed(2)} mm` +
                  (o.injection.volumeMm3 !== null
                    ? `, ${o.injection.volumeMm3.toFixed(2)} mm³`
                    : '')
                : null,
              injectionStructures: o.injection.structures,
              evidence: o.provenance.evidence,
              mirrored: o.mirrored,
              citation: o.provenance.citation,
              url: o.provenance.url,
              resolutionUm: o.provenance.resolutionUm,
              caveats: o.mirrored
                ? [MIRROR_CAVEAT, ...o.provenance.caveats]
                : o.provenance.caveats,
            },
      ),
      targetRegions,
    })

    download(sheetFilename(name), html, 'text/html')
    setStatus({
      kind: 'ok',
      lines: [
        `Exported ${sheetFilename(name)}`,
        objectiveViews.length
          ? `Included ${objectiveViews.length} objective view(s).`
          : objectiveCount > 0 && includeObjectiveViews
            ? `Could not render ${objectiveCount} objective view(s) — see the console.`
            : 'Open it in a browser and print to PDF if you need one.',
      ],
    })
  }

  async function openProject(file: File) {
    const result = parseProject(await file.text())

    if (!result.ok || !result.project) {
      setStatus({
        kind: 'error',
        lines: ['Could not open this file.', ...result.errors.slice(0, 6)],
      })
      return
    }

    const restored = restoreProject(result.project, atlas)

    // Object ids come from the file and are reused across plans, so geometry
    // registered under this session's ids must go before the new objects
    // arrive — otherwise the previous plan's mesh would be drawn in place of
    // whatever the file's `object-1` actually is.
    releaseAllCustomGeometry()
    adoptObjectIds(restored.objects)

    // Built-in models ship with the app, so their geometry can be rebuilt
    // exactly. Done *before* the objects reach the store, so the first render
    // already resolves the real mesh — registering afterwards would leave the
    // viewport holding a memoised null until something else changed.
    const hydration = await hydrateBuiltinGeometry(restored.objects)

    // Replace state wholesale: a project is a complete plan, not a merge.
    useAppStore.setState({
      targets: restored.targets,
      objects: restored.objects,
      measurements: restored.measurements,
      anatomy: restored.anatomy,
      collisionSettings: restored.collisionSettings,
      selection: restored.targets[0]
        ? { kind: 'target', id: restored.targets[0].id }
        : null,
      selectedTargetId: restored.targets[0]?.id ?? null,
    })
    if (restored.profileId) useAppStore.setState({ profileId: restored.profileId })

    setName(result.project.metadata.name)
    setNotes(result.project.metadata.notes)

    const warnings = [
      ...result.warnings,
      ...restored.warnings,
      ...hydration.failures,
    ]
    setStatus({
      kind: warnings.length ? 'warn' : 'ok',
      lines: [
        `Opened "${result.project.metadata.name}".`,
        ...(hydration.restored > 0
          ? [`Restored ${hydration.restored} built-in hardware model(s).`]
          : []),
        ...warnings,
      ],
    })
  }

  return (
    <>
      <div className="section">
        <h2>Plan</h2>
        <div className="field">
          <label htmlFor="plan-name">Name</label>
          <input
            id="plan-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <textarea
          className="notes"
          placeholder="Notes — animal, cohort, anything the sheet should carry"
          value={notes}
          rows={3}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      <div className="section">
        <h2>Project file</h2>
        <div className="btn-row">
          <button className="btn btn--primary" onClick={saveProject}>
            Save .braincad.json
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Open…
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.braincad.json,application/json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void openProject(file)
            event.target.value = ''
          }}
        />
        <p className="hint">
          Contains targets, objects, measurements and the full coordinate profile — so the
          plan is self-describing. Built-in hardware models are restored on reopening;
          imported STL geometry is not embedded, so re-import those
          files after reopening.
        </p>
      </div>

      <SectionControls />

      <div className="section">
        <h2>Capture</h2>
        <button className="btn btn--primary" onClick={saveCurrentView}>
          Save current view as PNG
        </button>
        <p className="hint">
          Exactly what the viewport shows — your camera, your visibility toggles, your
          sections — rendered offscreen at 1600 px on the long edge, with the transform
          gizmo left out.
        </p>
      </div>

      <div className="section">
        <h2>Planning sheet</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={includeCurrentView}
            onChange={(event) => setIncludeCurrentView(event.target.checked)}
          />
          Include the current camera view
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeScreenshot}
            onChange={(event) => setIncludeScreenshot(event.target.checked)}
          />
          Include overview views (oblique, front, top, left)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeObjectiveViews}
            onChange={(event) => setIncludeObjectiveViews(event.target.checked)}
          />
          Include view through each objective
        </label>
        <button className="btn btn--primary" onClick={exportSheet}>
          Export planning sheet
        </button>
        <p className="hint">
          A standalone HTML document: coordinates, objects, clearances, measurements and
          provenance. Print to PDF from the browser.
        </p>
      </div>

      {status && (
        <div className={`status status--${status.kind}`}>
          {status.lines.map((line, i) => (
            <div key={i} className={i === 0 ? 'status__head' : 'status__line'}>
              {line}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
