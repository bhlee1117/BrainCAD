/**
 * MEASURE panel: place two points, read the distance, keep it in the project.
 *
 * Every saved measurement states which kind of distance it is and what each
 * endpoint was snapped to, so a number copied into a methods section can be
 * traced back to exactly what was measured.
 */

import {
  DISTANCE_LABEL,
  SNAP_LABEL,
  formatDistance,
  measurementComponents,
  measurementDistanceMm,
} from '../measure/measure.ts'
import { useAppStore } from '../state/store.ts'

export function MeasurePanel() {
  const measuring = useAppStore((s) => s.measuring)
  const pendingA = useAppStore((s) => s.pendingA)
  const measurements = useAppStore((s) => s.measurements)
  const startMeasuring = useAppStore((s) => s.startMeasuring)
  const cancelMeasuring = useAppStore((s) => s.cancelMeasuring)
  const updateMeasurement = useAppStore((s) => s.updateMeasurement)
  const removeMeasurement = useAppStore((s) => s.removeMeasurement)

  return (
    <>
      <div className="section">
        <h2>Measure distance</h2>

        {!measuring && (
          <button className="btn btn--primary" onClick={startMeasuring}>
            Measure distance
          </button>
        )}

        {measuring && (
          <>
            <div className="measure-prompt">
              {measuring === 'a'
                ? 'Click the first point in the 3D view.'
                : 'Click the second point.'}
              {pendingA && (
                <div className="measure-prompt__from">
                  From {pendingA.snappedTo ?? 'free point'} (
                  {pendingA.coord.ap.toFixed(2)}, {pendingA.coord.ml.toFixed(2)},{' '}
                  {pendingA.coord.dv.toFixed(2)})
                </div>
              )}
            </div>
            <button className="btn" onClick={cancelMeasuring} style={{ marginTop: 8 }}>
              Cancel
            </button>
          </>
        )}

        <p className="hint">
          Points snap to target markers and object anchors within 0.3 mm, then to the surface
          under the cursor. Snapping records the feature, not the click, so the measurement is
          reproducible.
        </p>
      </div>

      <div className="section">
        <h2>Saved measurements</h2>

        {measurements.length === 0 && (
          <p style={{ color: 'var(--text-faint)', margin: 0 }}>
            None yet. Measurements are stored with the project and appear on the planning
            sheet.
          </p>
        )}

        {measurements.map((measurement) => {
          const distance = measurementDistanceMm(measurement)
          const formatted = formatDistance(distance)
          const components = measurementComponents(measurement)

          return (
            <div className="measurement" key={measurement.id}>
              <div className="measurement__head">
                <input
                  type="text"
                  value={measurement.name}
                  onChange={(event) =>
                    updateMeasurement(measurement.id, { name: event.target.value })
                  }
                />
                <button
                  className="icon-btn"
                  title={measurement.visible ? 'Hide' : 'Show'}
                  onClick={() =>
                    updateMeasurement(measurement.id, { visible: !measurement.visible })
                  }
                >
                  {measurement.visible ? '◉' : '○'}
                </button>
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={() => removeMeasurement(measurement.id)}
                >
                  ✕
                </button>
              </div>

              <div className="measurement__value">{formatted.mm}</div>
              <div className="measurement__sub">{formatted.um}</div>

              <div className="row">
                <span>ΔAP</span>
                <b>{components.ap.toFixed(3)} mm</b>
              </div>
              <div className="row">
                <span>ΔML</span>
                <b>{components.ml.toFixed(3)} mm</b>
              </div>
              <div className="row">
                <span>ΔDV</span>
                <b>{components.dv.toFixed(3)} mm</b>
              </div>

              <div className="measurement__meta">
                {DISTANCE_LABEL[measurement.kind]} · {SNAP_LABEL[measurement.a.snap]} →{' '}
                {SNAP_LABEL[measurement.b.snap]}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
