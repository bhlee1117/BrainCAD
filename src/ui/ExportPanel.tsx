/**
 * EXPORT panel: save and reopen a project, and produce a planning sheet.
 */

import { useRef, useState } from 'react'

import { UNLABELLED } from '../atlas/annotation.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { restoreProject, serialiseProject } from '../project/project.ts'
import { parseProject, projectFilename } from '../project/schema.ts'
import { renderPlanningSheet, sheetFilename } from '../project/sheet.ts'
import { renderObjectiveView } from '../optics/objectiveView.ts'
import { getSceneHandle } from '../scene/handle.ts'
import { useAppStore } from '../state/store.ts'

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

/**
 * Capture the WebGL canvas.
 *
 * The renderer clears its drawing buffer after each frame unless asked not to,
 * so a capture has to happen right after a render. Requesting a frame and
 * reading back in the same tick is the reliable way to get a non-blank image
 * without leaving `preserveDrawingBuffer` on for the whole session.
 */
function captureCanvas(): string | null {
  const canvas = document.querySelector('.viewport canvas') as HTMLCanvasElement | null
  if (!canvas) return null
  try {
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
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
      screenshot: includeScreenshot ? captureCanvas() : null,
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
              citation: o.provenance.citation,
              url: o.provenance.url,
              resolutionUm: o.provenance.resolutionUm,
              caveats: o.provenance.caveats,
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
              citation: o.provenance.citation,
              url: o.provenance.url,
              resolutionUm: o.provenance.resolutionUm,
              caveats: o.provenance.caveats,
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

    const warnings = [...result.warnings, ...restored.warnings]
    setStatus({
      kind: warnings.length ? 'warn' : 'ok',
      lines: [
        `Opened "${result.project.metadata.name}".`,
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
          plan is self-describing. Imported STL geometry is not embedded; re-import those
          files after reopening.
        </p>
      </div>

      <div className="section">
        <h2>Planning sheet</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={includeScreenshot}
            onChange={(event) => setIncludeScreenshot(event.target.checked)}
          />
          Include 3D view capture
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
