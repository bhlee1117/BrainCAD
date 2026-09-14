/**
 * Measurement picking and display in the 3D view.
 *
 * Picking uses an invisible plane-free approach: a click anywhere in the scene
 * reports the world point on whatever mesh was hit, which is then offered to
 * the snap resolver alongside the named features.
 */

import { Line, Text } from '@react-three/drei'
import { useMemo } from 'react'
import { Vector3 } from 'three'

import {
  measurementDistanceMm,
  measurementMidpoint,
  resolveSnap,
  type SnapCandidate,
} from '../measure/measure.ts'
import { effectivePivot, resolveGeometry } from '../objects/model.ts'
import { localToWorld, solvePlacement } from '../objects/placement.ts'
import { useAppStore } from '../state/store.ts'
import { stereotaxicToWorld, worldToStereotaxic } from './world.ts'

/** Snap radius in millimetres. Generous enough to be forgiving, tight enough
 *  that two nearby anchors stay distinguishable. */
const SNAP_RADIUS_MM = 0.3

/** Named features a measurement endpoint can snap to. */
export function useSnapCandidates(): SnapCandidate[] {
  const targets = useAppStore((s) => s.targets)
  const objects = useAppStore((s) => s.objects)

  return useMemo(() => {
    const candidates: SnapCandidate[] = []

    for (const target of targets) {
      if (!target.visible) continue
      candidates.push({ coord: target.coord, kind: 'target', label: target.name })
    }

    for (const object of objects) {
      if (!object.visible) continue
      const built = resolveGeometry(object)
      if (!built) continue

      const pivot = effectivePivot(object, built)
      const placement = solvePlacement(built.anchor, pivot, object.orientation, object.target)

      candidates.push({
        coord: object.target,
        kind: 'object-anchor',
        label: `${object.name} anchor`,
      })

      if (pivot.distanceToSquared(built.anchor) > 1e-9) {
        candidates.push({
          coord: worldToStereotaxic(localToWorld(pivot, placement, pivot)),
          kind: 'object-pivot',
          label: `${object.name} pivot`,
        })
      }

      if (object.kind !== 'custom') built.geometry.dispose()
    }

    return candidates
  }, [targets, objects])
}

/**
 * Handle a click in the 3D view while measuring.
 *
 * Exported so the viewport can call it from its own pointer handler rather
 * than this component needing an invisible catcher mesh over the scene.
 */
export function useMeasurementClick() {
  const measuring = useAppStore((s) => s.measuring)
  const setPendingA = useAppStore((s) => s.setPendingA)
  const addMeasurement = useAppStore((s) => s.addMeasurement)
  const candidates = useSnapCandidates()

  return (worldPoint: Vector3) => {
    if (!measuring) return
    const picked = worldToStereotaxic(worldPoint)
    const point = resolveSnap(picked, candidates, SNAP_RADIUS_MM)

    if (measuring === 'a') setPendingA(point)
    else addMeasurement(point)
  }
}

function MeasurementLine({
  a,
  b,
  label,
  distanceMm,
}: {
  a: Vector3
  b: Vector3
  label: string
  distanceMm: number
}) {
  const mid = a.clone().add(b).multiplyScalar(0.5)

  return (
    <group>
      <Line points={[a, b]} color="#7ee0b8" lineWidth={1.8} />
      {[a, b].map((point, i) => (
        <mesh key={i} position={point}>
          <sphereGeometry args={[0.07, 12, 12]} />
          <meshBasicMaterial color="#7ee0b8" />
        </mesh>
      ))}
      <Text
        position={[mid.x, mid.y + 0.28, mid.z]}
        fontSize={0.36}
        color="#7ee0b8"
        anchorX="center"
        outlineWidth={0.03}
        outlineColor="#0b0e13"
      >
        {`${label}  ${distanceMm.toFixed(3)} mm`}
      </Text>
    </group>
  )
}

export function Measurements() {
  const measurements = useAppStore((s) => s.measurements)
  const pendingA = useAppStore((s) => s.pendingA)

  return (
    <group>
      {measurements
        .filter((m) => m.visible)
        .map((measurement) => (
          <MeasurementLine
            key={measurement.id}
            a={stereotaxicToWorld(measurement.a.coord)}
            b={stereotaxicToWorld(measurement.b.coord)}
            label={measurement.name}
            distanceMm={measurementDistanceMm(measurement)}
          />
        ))}

      {/* The first endpoint, while the second is still being placed. */}
      {pendingA && (
        <mesh position={stereotaxicToWorld(pendingA.coord)}>
          <sphereGeometry args={[0.09, 14, 14]} />
          <meshBasicMaterial color="#7ee0b8" />
        </mesh>
      )}
    </group>
  )
}

/** Midpoint helper re-exported for the planning sheet at M4. */
export { measurementMidpoint }
