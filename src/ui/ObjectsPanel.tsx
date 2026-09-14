/**
 * OBJECTS panel: the object library, the scene tree, and custom geometry import.
 */

import { useRef, useState } from 'react'
import { NumberField } from './NumberField.tsx'
import { Vector3 } from 'three'

import {
  DEFAULT_IMPORT_OPTIONS,
  applyImportOptions,
  describeSize,
  formatFromFilename,
  parseGeometryAsync,
  sizeWarning,
  type ImportOptions,
  type ImportedGeometry,
  type SourceUnit,
} from '../objects/import.ts'
import {
  KIND_COLOR,
  KIND_LABEL,
  registerCustomGeometry,
  type SceneObject,
} from '../objects/model.ts'
import type { ObjectKind } from '../objects/primitives.ts'
import { useAppStore } from '../state/store.ts'

const LIBRARY: { kind: ObjectKind; label: string; hint: string }[] = [
  { kind: 'pipette', label: 'Glass pipette', hint: 'Tapered tip, anchored at the tip' },
  { kind: 'cannula', label: 'Cannula', hint: 'Ferrule and shaft, pivots at the collar' },
  { kind: 'prism', label: 'Prism', hint: 'Anchored on the imaging face' },
  { kind: 'objective', label: 'Objective', hint: 'Anchored at the focal point' },
]

const UNITS: SourceUnit[] = ['mm', 'um', 'cm', 'm', 'in']

/** Import flow for a user-supplied STL / OBJ / GLB. */
function ImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null)
  const addObject = useAppStore((s) => s.addObject)
  const updateObject = useAppStore((s) => s.updateObject)
  const targets = useAppStore((s) => s.targets)
  const selectedTargetId = useAppStore((s) => s.selectedTargetId)

  const [pending, setPending] = useState<{
    imported: ImportedGeometry
    filename: string
  } | null>(null)
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setError(null)
    const format = formatFromFilename(file.name)
    if (!format) {
      setError(`Cannot read ${file.name}. Supported formats are STL, OBJ and GLB.`)
      return
    }

    try {
      const imported = await parseGeometryAsync(await file.arrayBuffer(), format)
      setPending({ imported, filename: file.name })
      // Start from the inferred unit, which the user can override before adding.
      setOptions({ ...DEFAULT_IMPORT_OPTIONS, unit: imported.unitGuess.unit })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function confirmImport() {
    if (!pending) return

    const { geometry, boundsMm } = applyImportOptions(pending.imported, options)
    const target =
      targets.find((t) => t.id === selectedTargetId)?.coord ?? { ap: 0, ml: 0, dv: -2 }

    const id = addObject('custom', target, pending.filename.replace(/\.[^.]+$/, ''))
    registerCustomGeometry(id, {
      geometry,
      // Imported parts have no declared pivot or anchor, so both start at the
      // local origin — which the origin mode above has just placed deliberately.
      pivot: new Vector3(0, 0, 0),
      anchor: new Vector3(0, 0, 0),
      axis: new Vector3(0, -1, 0),
      lengthMm: boundsMm.getSize(new Vector3()).y,
    })
    updateObject(id, {
      source: {
        filename: pending.filename,
        format: pending.imported.format,
        unit: options.unit,
        scale: options.scale,
        origin: options.origin,
        triangleCount: pending.imported.triangleCount,
      },
    })

    setPending(null)
  }

  const preview = pending ? applyImportOptions(pending.imported, options) : null
  const warning = preview ? sizeWarning(preview.boundsMm) : null

  return (
    <div className="section">
      <h2>Custom geometry</h2>

      <input
        ref={fileRef}
        type="file"
        accept=".stl,.obj,.glb,.gltf"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void handleFile(file)
          event.target.value = ''
        }}
      />

      {!pending && (
        <>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import STL / OBJ / GLB…
          </button>
          {error && <div className="warn-box">{error}</div>}
        </>
      )}

      {pending && preview && (
        <div className="import">
          <div className="import__name">{pending.filename}</div>
          <div className="import__meta">
            {pending.imported.triangleCount.toLocaleString()} triangles ·{' '}
            {describeSize(pending.imported.rawBounds, 'units')}
          </div>

          <div
            className={
              pending.imported.unitGuess.confidence === 'likely'
                ? 'guess guess--likely'
                : 'guess guess--uncertain'
            }
          >
            <b>
              {pending.imported.unitGuess.confidence === 'likely'
                ? 'Unit looks like'
                : 'Unit is ambiguous —'}{' '}
              {pending.imported.unitGuess.unit}
            </b>
            <span>{pending.imported.unitGuess.reason}</span>
          </div>

          <div className="field">
            <label htmlFor="imp-unit">Unit</label>
            <select
              id="imp-unit"
              value={options.unit}
              onChange={(e) => setOptions({ ...options, unit: e.target.value as SourceUnit })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u === 'um' ? 'µm' : u}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="imp-scale">Scale</label>
            <NumberField
              id="imp-scale"
              step={0.1}
              value={options.scale}
              onChange={(scale) => setOptions({ ...options, scale })}
            />
          </div>

          <div className="field">
            <label htmlFor="imp-origin">Origin</label>
            <select
              id="imp-origin"
              value={options.origin}
              onChange={(e) =>
                setOptions({ ...options, origin: e.target.value as ImportOptions['origin'] })
              }
            >
              <option value="file">File origin</option>
              <option value="center">Geometric centre</option>
              <option value="base">Base (sits on origin)</option>
            </select>
          </div>

          <div className="row">
            <span>Result</span>
            <b>{describeSize(preview.boundsMm, 'mm')}</b>
          </div>

          {warning && <div className="warn-box">{warning}</div>}

          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn btn--primary" onClick={confirmImport}>
              Add to scene
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ObjectRow({ object }: { object: SceneObject }) {
  const selection = useAppStore((s) => s.selection)
  const select = useAppStore((s) => s.select)
  const updateObject = useAppStore((s) => s.updateObject)

  const current = selection?.kind === 'object' && selection.id === object.id

  return (
    <div
      className="target"
      aria-current={current}
      onClick={() => select({ kind: 'object', id: object.id })}
    >
      <span
        className="target__dot"
        style={{ background: object.color, borderRadius: 2 }}
      />
      <span className="target__name">{object.name}</span>
      <button
        className="icon-btn"
        title={object.visible ? 'Hide' : 'Show'}
        onClick={(event) => {
          event.stopPropagation()
          updateObject(object.id, { visible: !object.visible })
        }}
      >
        {object.visible ? '◉' : '○'}
      </button>
    </div>
  )
}

export function ObjectsPanel() {
  const objects = useAppStore((s) => s.objects)
  const addObject = useAppStore((s) => s.addObject)
  const removeObject = useAppStore((s) => s.removeObject)
  const selection = useAppStore((s) => s.selection)

  return (
    <>
      <div className="section">
        <h2>Add object</h2>
        <div className="library">
          {LIBRARY.map((entry) => (
            <button
              key={entry.kind}
              className="lib"
              onClick={() => addObject(entry.kind)}
              title={entry.hint}
            >
              <span className="lib__swatch" style={{ background: KIND_COLOR[entry.kind] }} />
              <span className="lib__label">{entry.label}</span>
              <span className="lib__hint">{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <ImportPanel />

      <div className="section">
        <h2>Scene objects</h2>
        {objects.length === 0 && (
          <p style={{ color: 'var(--text-faint)', margin: 0 }}>
            Nothing placed yet. Add a primitive above, or import your own hardware.
          </p>
        )}
        {objects.map((object) => (
          <ObjectRow key={object.id} object={object} />
        ))}
        {selection?.kind === 'object' && (
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => removeObject(selection.id)}>
              Remove {KIND_LABEL[objects.find((o) => o.id === selection.id)?.kind ?? 'custom']}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
