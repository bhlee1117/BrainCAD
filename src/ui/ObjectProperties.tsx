/**
 * Properties panel for the selected object: position, orientation, pivot and
 * anchor, plus the parametric dimensions of a primitive.
 *
 * Numeric entry and the 3D gizmo are two views of the same state, so editing
 * either updates the other immediately.
 */

import { Vector3 } from 'three'
import { NumberField } from './NumberField.tsx'

import { UNLABELLED } from '../atlas/annotation.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { builtinModel } from '../objects/builtins.ts'
import {
  KIND_LABEL,
  effectivePivot,
  isMeshBacked,
  pivotDiffersFromAnchor,
  resolveGeometry,
  type PivotMode,
  type SceneObject,
} from '../objects/model.ts'
import type { BuiltPrimitive } from '../objects/primitives.ts'
import {
  angleFromVerticalDeg,
  localToWorld,
  solvePlacement,
  worldAxis,
} from '../objects/placement.ts'
import { worldToStereotaxic } from '../scene/world.ts'
import { useAppStore } from '../state/store.ts'

/** Human labels for the raw parameter keys on each primitive. */
const PARAM_LABELS: Record<string, string> = {
  shaftDiameterMm: 'Shaft ⌀',
  shaftLengthMm: 'Shaft length',
  tipDiameterMm: 'Tip ⌀',
  taperLengthMm: 'Taper length',
  outerDiameterMm: 'Outer ⌀',
  innerDiameterMm: 'Inner ⌀',
  lengthMm: 'Length',
  ferruleDiameterMm: 'Ferrule ⌀',
  ferruleLengthMm: 'Ferrule length',
  widthMm: 'Width',
  heightMm: 'Height',
  depthMm: 'Depth',
  insertionDepthMm: 'Insertion depth',
  workingDistanceMm: 'Working distance',
  barrelDiameterMm: 'Barrel ⌀',
  frontDiameterMm: 'Front ⌀',
  noseLengthMm: 'Nose length',
  barrelLengthMm: 'Barrel length',
  safetyMarginMm: 'Safety margin',
  fieldOfViewMm: 'Field of view',
}

/**
 * A mesh's overall size, in the axes the rest of the panel speaks.
 *
 * An object's local frame is aligned with the world when it is unrotated, so
 * local X/Y/Z read as ML/DV/AP — which is how the extent is labelled, rather
 * than as anonymous X/Y/Z the user would have to map themselves.
 */
function describeBounds(built: BuiltPrimitive): string {
  const box = built.geometry.boundingBox
  if (!box) return '—'
  const size = box.getSize(new Vector3())
  return `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} mm`
}

/** A labelled, unit-suffixed row wrapping the shared numeric input. */
function LabelledNumber({
  label,
  value,
  step = 0.05,
  unit = 'mm',
  onChange,
}: {
  label: string
  value: number
  step?: number
  unit?: string
  onChange: (next: number) => void
}) {
  return (
    <div className="field">
      <label title={label}>{label}</label>
      <NumberField step={step} value={value} onChange={onChange} />
      <span className="unit">{unit}</span>
    </div>
  )
}

export function ObjectProperties({
  object,
  atlas,
  profile,
}: {
  object: SceneObject
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  const updateObject = useAppStore((s) => s.updateObject)
  const updateObjectParams = useAppStore((s) => s.updateObjectParams)
  const setObjectOrientation = useAppStore((s) => s.setObjectOrientation)
  const gizmoMode = useAppStore((s) => s.gizmoMode)
  const setGizmoMode = useAppStore((s) => s.setGizmoMode)

  const built = resolveGeometry(object)
  const meshBacked = isMeshBacked(object)
  const model = object.source?.builtinId ? builtinModel(object.source.builtinId) : null

  // Read off the spec rather than the model so a value the user has changed is
  // the one shown. Only the optics survive on a mesh-backed object; everything
  // else the spec carries describes a solid that is no longer being drawn.
  const params = object.spec?.params as Record<string, number> | undefined
  const workingDistanceMm =
    object.kind === 'objective' && typeof params?.workingDistanceMm === 'number'
      ? params.workingDistanceMm
      : null
  const fieldOfViewMm =
    object.kind === 'objective' && typeof params?.fieldOfViewMm === 'number'
      ? params.fieldOfViewMm
      : null

  const setTarget = (patch: Partial<Stereotaxic>) =>
    updateObject(object.id, { target: { ...object.target, ...patch } })

  // Where the far end of the instrument sits — the entry point for an
  // insertion, the front element for an objective.
  let entry: Stereotaxic | null = null
  let entryRegion: string | null = null

  if (built) {
    const pivot = effectivePivot(object, built)
    const placement = solvePlacement(built.anchor, pivot, object.orientation, object.target)
    const backAlongAxis = built.anchor
      .clone()
      .sub(built.axis.clone().multiplyScalar(built.lengthMm))
    entry = worldToStereotaxic(localToWorld(backAlongAxis, placement, pivot))

    const surface = atlas.volume.firstLabelledPoint(profile, entry, object.target)
    if (surface && surface.id !== UNLABELLED) {
      entryRegion = atlas.index.byId.get(surface.id)?.acronym ?? null
    }
  }

  const axis = built ? worldAxis(built.axis, object.orientation) : new Vector3()
  const obliquity = angleFromVerticalDeg(object.orientation)

  return (
    <>
      <div className="section">
        <h2>{KIND_LABEL[object.kind]}</h2>
        <div className="field">
          <label htmlFor="obj-name">Name</label>
          <input
            id="obj-name"
            type="text"
            value={object.name}
            onChange={(event) => updateObject(object.id, { name: event.target.value })}
          />
        </div>
        {object.source && (
          <div className="provenance" style={{ marginTop: 4 }}>
            {object.source.filename} · {object.source.triangleCount.toLocaleString()} tris ·{' '}
            {object.source.builtinId ? (
              'built-in model'
            ) : (
              <>
                imported as {object.source.unit === 'um' ? 'µm' : object.source.unit}
                {object.source.scale !== 1 && ` × ${object.source.scale}`}
              </>
            )}
          </div>
        )}
      </div>

      <div className="section">
        <h2>Anchor position</h2>
        <LabelledNumber label="AP" value={object.target.ap} onChange={(ap) => setTarget({ ap })} />
        <LabelledNumber label="ML" value={object.target.ml} onChange={(ml) => setTarget({ ml })} />
        <LabelledNumber label="DV" value={object.target.dv} onChange={(dv) => setTarget({ dv })} />
      </div>

      <div className="section">
        <h2>Orientation</h2>
        <LabelledNumber
          label="AP tilt"
          value={object.orientation.apTiltDeg}
          step={0.5}
          unit="°"
          onChange={(apTiltDeg) => setObjectOrientation(object.id, { apTiltDeg })}
        />
        <LabelledNumber
          label="ML tilt"
          value={object.orientation.mlTiltDeg}
          step={0.5}
          unit="°"
          onChange={(mlTiltDeg) => setObjectOrientation(object.id, { mlTiltDeg })}
        />
        <LabelledNumber
          label="Roll"
          value={object.orientation.rollDeg}
          step={1}
          unit="°"
          onChange={(rollDeg) => setObjectOrientation(object.id, { rollDeg })}
        />

        <div className="row">
          <span>Off vertical</span>
          <b>{obliquity.toFixed(1)}°</b>
        </div>

        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className={gizmoMode === 'translate' ? 'btn btn--primary' : 'btn'}
            onClick={() => setGizmoMode('translate')}
          >
            Move
          </button>
          <button
            className={gizmoMode === 'rotate' ? 'btn btn--primary' : 'btn'}
            onClick={() => setGizmoMode('rotate')}
          >
            Rotate
          </button>
          <button
            className="btn"
            onClick={() =>
              setObjectOrientation(object.id, { apTiltDeg: 0, mlTiltDeg: 0, rollDeg: 0 })
            }
          >
            Reset
          </button>
        </div>
      </div>

      <div className="section">
        <h2>Pivot</h2>
        <div className="field">
          <label htmlFor="pivot-mode">Mode</label>
          <select
            id="pivot-mode"
            value={object.pivotMode}
            onChange={(event) =>
              updateObject(object.id, { pivotMode: event.target.value as PivotMode })
            }
          >
            <option value="default">
              {built && pivotDiffersFromAnchor(built) ? 'Default (part-specific)' : 'Default'}
            </option>
            <option value="anchor">At the anchor</option>
            <option value="custom">Custom offset</option>
          </select>
        </div>

        {object.pivotMode === 'custom' && (
          <>
            <LabelledNumber
              label="X"
              value={object.pivotCustom[0]}
              onChange={(x) =>
                updateObject(object.id, {
                  pivotCustom: [x, object.pivotCustom[1], object.pivotCustom[2]],
                })
              }
            />
            <LabelledNumber
              label="Y"
              value={object.pivotCustom[1]}
              onChange={(y) =>
                updateObject(object.id, {
                  pivotCustom: [object.pivotCustom[0], y, object.pivotCustom[2]],
                })
              }
            />
            <LabelledNumber
              label="Z"
              value={object.pivotCustom[2]}
              onChange={(z) =>
                updateObject(object.id, {
                  pivotCustom: [object.pivotCustom[0], object.pivotCustom[1], z],
                })
              }
            />
          </>
        )}

        <p className="hint">
          The <b style={{ color: 'var(--target)' }}>anchor</b> is what sits on the coordinate
          above. The <b style={{ color: 'var(--accent)' }}>pivot</b> is what the object rotates
          around. Both are drawn on the selected object.
        </p>
      </div>

      {entry && (
        <div className="section">
          <h2>Approach</h2>
          <div className="row">
            <span>Far end AP</span>
            <b>{entry.ap.toFixed(2)} mm</b>
          </div>
          <div className="row">
            <span>Far end ML</span>
            <b>{entry.ml.toFixed(2)} mm</b>
          </div>
          <div className="row">
            <span>Far end DV</span>
            <b>{entry.dv.toFixed(2)} mm</b>
          </div>
          <div className="row">
            <span>Enters tissue at</span>
            <b>{entryRegion ?? 'no tissue crossed'}</b>
          </div>
          <div className="row">
            <span>Axis (ML/DV/AP)</span>
            <b>
              {axis.x.toFixed(2)} / {axis.y.toFixed(2)} / {axis.z.toFixed(2)}
            </b>
          </div>
        </div>
      )}

      {object.spec && !meshBacked && (
        <div className="section">
          <h2>Dimensions</h2>
          {Object.entries(object.spec.params).map(([key, value]) => (
            <LabelledNumber
              key={key}
              label={PARAM_LABELS[key] ?? key}
              value={value as number}
              step={key.includes('Diameter') ? 0.05 : 0.1}
              onChange={(next) => updateObjectParams(object.id, { [key]: next })}
            />
          ))}
        </div>
      )}

      {/*
        A mesh-backed object's dimensions are the mesh's. Showing the parametric
        fields here would offer edits that silently do nothing — the geometry
        comes from the file, not from the numbers — so the solid is reported
        rather than offered for editing. The exception is the field of view,
        which is a property of the scan path rather than of the part, and is
        the one number a user genuinely has to set for themselves.
      */}
      {meshBacked && built && (
        <div className="section">
          <h2>Dimensions</h2>
          <div className="row">
            <span>Extent (ML/DV/AP)</span>
            <b>{describeBounds(built)}</b>
          </div>
          {workingDistanceMm !== null && (
            <div className="row">
              <span>Working distance</span>
              <b>{workingDistanceMm.toFixed(2)} mm</b>
            </div>
          )}
          {fieldOfViewMm !== null && (
            <LabelledNumber
              label={PARAM_LABELS.fieldOfViewMm!}
              value={fieldOfViewMm}
              step={0.05}
              onChange={(next) => updateObjectParams(object.id, { fieldOfViewMm: next })}
            />
          )}
          <p className="hint">
            Fixed by the mesh. {model?.provenance}
          </p>
          {model && model.caveats.length > 0 && (
            <ul className="hint" style={{ paddingLeft: 16, margin: '4px 0 0' }}>
              {model.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="section">
        <h2>Display</h2>
        <div className="field">
          <label htmlFor="obj-color">Colour</label>
          <input
            id="obj-color"
            type="color"
            value={object.color}
            onChange={(event) => updateObject(object.id, { color: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="obj-opacity">Opacity</label>
          <input
            id="obj-opacity"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={object.opacity}
            onChange={(event) =>
              updateObject(object.id, { opacity: Number(event.target.value) })
            }
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={object.collision}
            onChange={(event) => updateObject(object.id, { collision: event.target.checked })}
          />
          Include in collision checks
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={object.anatomyCollision}
            disabled={!object.collision}
            onChange={(event) =>
              updateObject(object.id, { anatomyCollision: event.target.checked })
            }
          />
          Also check against anatomy
        </label>
        <p className="hint" style={{ marginTop: 2 }}>
          {object.anatomyCollision
            ? 'Also flagged when this object touches the atlas surface. The atlas is an averaged brain, so treat that as a rough guide, not a measurement.'
            : 'Checked against other objects only. The atlas surface is not treated as a collision partner.'}
        </p>
      </div>
    </>
  )
}
