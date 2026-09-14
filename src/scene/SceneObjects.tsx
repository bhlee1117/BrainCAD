/**
 * Rendering and direct manipulation of scene objects.
 *
 * The scene graph mirrors the placement model exactly: a positioned, rotated
 * group whose children are offset by −pivot. That is not a coincidence — it is
 * what makes the gizmo's rotation handles spin the object about its declared
 * pivot without any extra maths, and it keeps the rendered result and the
 * numeric readout derived from the same transform.
 */

import { TransformControls } from '@react-three/drei'
import { useEffect, useMemo, useState } from 'react'
import { Vector3, type Group, type Object3D } from 'three'

import { worldToStereotaxic } from './world.ts'
import {
  effectivePivot,
  isMeshBacked,
  resolveGeometry,
  type SceneObject,
} from '../objects/model.ts'
import {
  localToWorld,
  orientationToEuler,
  orientationToQuaternion,
  quaternionToOrientation,
  solvePlacement,
} from '../objects/placement.ts'
import { STATE_COLOR, stateForObject } from '../collision/check.ts'
import { Helper } from './Helper.tsx'
import { useAppStore } from '../state/store.ts'

/** Small cross marking a declared point (anchor or pivot) on a selected object. */
function PointMarker({
  position,
  color,
  size = 0.55,
}: {
  position: Vector3
  color: string
  size?: number
}) {
  const axes: [number, number, number][] = [
    [size, 0, 0],
    [0, size, 0],
    [0, 0, size],
  ]

  return (
    <group position={position}>
      {axes.map(([x, y, z], i) => (
        <mesh key={i} position={[x / 2, y / 2, z / 2]}>
          <boxGeometry args={[x || 0.035, y || 0.035, z || 0.035]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
        </mesh>
      ))}
      {axes.map(([x, y, z], i) => (
        <mesh key={`n${i}`} position={[-x / 2, -y / 2, -z / 2]}>
          <boxGeometry args={[x || 0.035, y || 0.035, z || 0.035]} />
          <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.5} />
        </mesh>
      ))}
    </group>
  )
}

/** Dashed-looking insertion axis, drawn from the anchor back along the axis. */
function AxisLine({ length, color }: { length: number; color: string }) {
  return (
    <mesh position={[0, length / 2, 0]}>
      <cylinderGeometry args={[0.012, 0.012, length, 6]} />
      <meshBasicMaterial color={color} transparent opacity={0.55} depthTest={false} />
    </mesh>
  )
}

function ObjectView({ object, selected }: { object: SceneObject; selected: boolean }) {
  const select = useAppStore((s) => s.select)
  const report = useAppStore((s) => s.collisionReport)

  // Collision state overrides the object's own colour, because a red implant is
  // the single most important thing on screen when it happens.
  const collisionState =
    report && object.collision ? stateForObject(report, object.id) : 'safe'
  const displayColor = collisionState === 'safe' ? object.color : STATE_COLOR[collisionState]

  const built = useMemo(() => resolveGeometry(object), [object])

  // Rebuilt primitives own their geometry; release it when params change.
  // Mesh geometry belongs to the registry and must outlive this component.
  useEffect(() => {
    if (!built || isMeshBacked(object)) return
    return () => built.geometry.dispose()
  }, [built, object])

  const placement = useMemo(() => {
    if (!built) return null
    return solvePlacement(
      built.anchor,
      effectivePivot(object, built),
      object.orientation,
      object.target,
    )
  }, [built, object])

  if (!built || !placement || !object.visible) return null

  const pivot = effectivePivot(object, built)
  const euler = orientationToEuler(object.orientation)

  return (
    <group position={placement.position} rotation={euler}>
      {/* Children sit in the object's own local frame, shifted so the pivot is
          the group's rotation centre. */}
      <group position={[0, 0, 0]}>
        <mesh
          geometry={built.geometry}
          onClick={(event) => {
            event.stopPropagation()
            select({ kind: 'object', id: object.id })
          }}
        >
          <meshStandardMaterial
            color={displayColor}
            emissive={collisionState === 'collision' ? '#5a0f0a' : '#000000'}
            transparent={object.opacity < 1}
            opacity={object.opacity}
            roughness={0.45}
            metalness={0.1}
            depthWrite={object.opacity > 0.85}
          />
        </mesh>

        {selected && (
          <Helper>
            {/* Anchor in the target colour; pivot in a cooler tone, so the two
                concepts are visually distinct at a glance. */}
            <PointMarker position={built.anchor} color="#ff6b4a" />
            {pivot.distanceToSquared(built.anchor) > 1e-9 && (
              <PointMarker position={pivot} color="#4da3ff" size={0.4} />
            )}
            <AxisLine length={built.lengthMm} color={displayColor} />
          </Helper>
        )}
      </group>
    </group>
  )
}

/**
 * Gizmo for the selected object.
 *
 * Translating writes back the *anchor's* new stereotaxic position rather than
 * the group's raw position, so dragging a cannula moves its tip to where the
 * user dropped it, not its ferrule. Rotating writes back tilt angles.
 */
function ObjectGizmo({ object }: { object: SceneObject }) {
  // A callback ref stored in state, not a plain useRef: TransformControls needs
  // a mounted Object3D to attach to, and a ref alone is still null on the first
  // render, so the controls would never appear.
  const [proxy, setProxy] = useState<Group | null>(null)
  const gizmoMode = useAppStore((s) => s.gizmoMode)
  const updateObject = useAppStore((s) => s.updateObject)
  const setObjectOrientation = useAppStore((s) => s.setObjectOrientation)

  const built = useMemo(() => resolveGeometry(object), [object])

  useEffect(() => {
    if (!built || isMeshBacked(object)) return
    return () => built.geometry.dispose()
  }, [built, object])

  const anchorWorld = useMemo(() => {
    if (!built) return new Vector3()
    const pivot = effectivePivot(object, built)
    const placement = solvePlacement(built.anchor, pivot, object.orientation, object.target)
    return localToWorld(built.anchor, placement, pivot)
  }, [built, object])

  const quaternion = useMemo(
    () => orientationToQuaternion(object.orientation),
    [object.orientation],
  )

  // Re-sync the proxy whenever the object changes from elsewhere — numeric
  // entry, a profile switch, a different selection — so the handle never drifts
  // away from the geometry it is supposed to be driving.
  useEffect(() => {
    if (!proxy) return
    proxy.position.copy(anchorWorld)
    proxy.quaternion.copy(quaternion)
  }, [proxy, anchorWorld, quaternion])

  if (!built) return null

  const handleChange = () => {
    if (!proxy) return

    if (gizmoMode === 'translate') {
      // Write back the anchor's position, not the group's: dragging a cannula
      // should move its tip to where it was dropped, not its ferrule.
      updateObject(object.id, { target: worldToStereotaxic(proxy.position.clone()) })
    } else {
      setObjectOrientation(object.id, quaternionToOrientation(proxy.quaternion.clone()))
    }
  }

  return (
    <>
      <group ref={setProxy} />
      {proxy && (
        <TransformControls
          object={proxy as unknown as Object3D}
          mode={gizmoMode}
          size={0.8}
          onObjectChange={handleChange}
        />
      )}
    </>
  )
}

export function SceneObjects() {
  const objects = useAppStore((s) => s.objects)
  const selection = useAppStore((s) => s.selection)

  const selectedObject =
    selection?.kind === 'object' ? objects.find((o) => o.id === selection.id) : undefined

  return (
    <group>
      {objects.map((object) => (
        <ObjectView
          key={object.id}
          object={object}
          selected={selectedObject?.id === object.id}
        />
      ))}
      {selectedObject && (
        <Helper>
          <ObjectGizmo key={selectedObject.id} object={selectedObject} />
        </Helper>
      )}
    </group>
  )
}
