/**
 * The 3D viewport: brain surface, region meshes, target markers, axis triad
 * and scale bar, all in stereotaxic world millimetres.
 */

import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { Line, OrbitControls, Text } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BackSide,
  BufferGeometry,
  DoubleSide,
  Matrix4,
  Vector3,
  type Group,
} from 'three'

import { atlasUrl, type LoadedAtlas } from '../atlas/load.ts'
import { loadAtlasMesh } from '../atlas/mesh.ts'
import { colorComponents } from '../atlas/ontology.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import { SceneObjects } from './SceneObjects.tsx'
import { Measurements, useMeasurementClick } from './Measurements.tsx'
import { Overlays } from './Overlays.tsx'
import { useCollision, type AnatomyMesh } from '../collision/useCollision.ts'
import { useAppStore, type Target } from '../state/store.ts'
import { Helper } from './Helper.tsx'
import { ANATOMY_FLAG } from './Helper.tsx'
import { setSceneHandle } from './handle.ts'
import { sectionPlanes } from './section.ts'
import { atlasToWorldMatrix, stereotaxicToWorld } from './world.ts'

/** Whole-brain root structure id in the Allen ontology. */
const ROOT_STRUCTURE_ID = 997

/** Standard camera positions, in world millimetres. */
const STANDARD_VIEWS = {
  dorsal: new Vector3(0, 26, 0.01),
  ventral: new Vector3(0, -26, 0.01),
  anterior: new Vector3(0, 0, 26),
  posterior: new Vector3(0, 0, -26),
  left: new Vector3(-26, 0, 0),
  right: new Vector3(26, 0, 0),
} as const

export type StandardView = keyof typeof STANDARD_VIEWS

/** Load one atlas mesh by structure id, returning null until it arrives. */
function useAtlasMeshGeometry(structureId: number): BufferGeometry | null {
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let loaded: BufferGeometry | null = null

    loadAtlasMesh(atlasUrl(`meshes/${structureId}.msh`), controller.signal)
      .then((mesh) => {
        if (disposed) {
          mesh.geometry.dispose()
          return
        }
        loaded = mesh.geometry
        setGeometry(mesh.geometry)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(`Could not load mesh ${structureId}`, error)
        }
      })

    return () => {
      disposed = true
      controller.abort()
      loaded?.dispose()
    }
  }, [structureId])

  return geometry
}

/**
 * The translucent whole-brain surface.
 *
 * Rendered back-faces-first so the interior stays readable when targets sit
 * inside it — with a single transparent pass, front faces would wash out the
 * markers behind them.
 */
function BrainSurface({
  matrix,
  onGeometry,
  onPick,
}: {
  matrix: Matrix4
  onGeometry?: (geometry: BufferGeometry | null) => void
  onPick?: (event: ThreeEvent<MouseEvent>) => void
}) {
  const geometry = useAtlasMeshGeometry(ROOT_STRUCTURE_ID)
  const { showBrain, brainOpacity } = useAppStore((s) => s.anatomy)

  useEffect(() => {
    onGeometry?.(geometry)
  }, [geometry, onGeometry])

  if (!geometry || !showBrain) return null

  return (
    <group
      matrixAutoUpdate={false}
      matrix={matrix}
      userData={{ [ANATOMY_FLAG]: true }}
    >
      <mesh geometry={geometry} renderOrder={-2}>
        <meshStandardMaterial
          color="#8fa9c4"
          transparent
          opacity={brainOpacity}
          side={BackSide}
          depthWrite={false}
          roughness={0.85}
        />
      </mesh>
      <mesh geometry={geometry} renderOrder={-1} onClick={onPick}>
        <meshStandardMaterial
          color="#b8cde4"
          transparent
          opacity={brainOpacity * 0.55}
          side={DoubleSide}
          depthWrite={false}
          roughness={0.85}
        />
      </mesh>
    </group>
  )
}

/** A single anatomical region mesh, toggled from the ATLAS panel. */
function RegionMesh({
  structureId,
  color,
  matrix,
}: {
  structureId: number
  color: string
  matrix: Matrix4
}) {
  const geometry = useAtlasMeshGeometry(structureId)
  if (!geometry) return null

  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color={color}
          transparent
          opacity={0.62}
          side={DoubleSide}
          roughness={0.6}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

/** Target marker: a sphere with local axis whiskers for depth judgement. */
function TargetMarker({ target, selected }: { target: Target; selected: boolean }) {
  const position = useMemo(() => stereotaxicToWorld(target.coord), [target.coord])
  const selectTarget = useAppStore((s) => s.selectTarget)

  if (!target.visible) return null

  const radius = selected ? 0.16 : 0.11
  const whisker = 0.85

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation()
    selectTarget(target.id)
  }

  return (
    <group position={position}>
      <mesh onClick={onClick}>
        <sphereGeometry args={[radius, 20, 20]} />
        <meshBasicMaterial color={selected ? '#ff6b4a' : '#b8553f'} />
      </mesh>

      {selected && (
        <>
          {(
            [
              [new Vector3(whisker, 0, 0), '#e2574c'],
              [new Vector3(0, whisker, 0), '#52b788'],
              [new Vector3(0, 0, whisker), '#4da3ff'],
            ] as const
          ).map(([axis, color], i) => (
            <Line
              key={i}
              points={[axis.clone().negate(), axis]}
              color={color}
              lineWidth={1.2}
              transparent
              opacity={0.75}
            />
          ))}
          <Text
            position={[0, radius + 0.42, 0]}
            fontSize={0.42}
            color="#ff6b4a"
            anchorX="center"
            outlineWidth={0.035}
            outlineColor="#0b0e13"
          >
            {target.name}
          </Text>
        </>
      )}
    </group>
  )
}

/** Labelled AP/ML/DV axis triad at bregma. */
function AxisTriad() {
  const length = 3.4
  const axes = [
    { dir: new Vector3(1, 0, 0), color: '#e2574c', label: 'ML +' },
    { dir: new Vector3(0, 1, 0), color: '#52b788', label: 'DV +' },
    { dir: new Vector3(0, 0, 1), color: '#4da3ff', label: 'AP +' },
  ]

  return (
    <group>
      {axes.map((axis) => {
        const end = axis.dir.clone().multiplyScalar(length)
        return (
          <group key={axis.label}>
            <Line points={[new Vector3(0, 0, 0), end]} color={axis.color} lineWidth={1.6} />
            <Text
              position={end.clone().multiplyScalar(1.12)}
              fontSize={0.4}
              color={axis.color}
              anchorX="center"
              outlineWidth={0.03}
              outlineColor="#0b0e13"
            >
              {axis.label}
            </Text>
          </group>
        )
      })}
      {/* Bregma itself */}
      <mesh>
        <sphereGeometry args={[0.09, 14, 14]} />
        <meshBasicMaterial color="#e4e9ef" />
      </mesh>
      <Text
        position={[0, -0.45, 0]}
        fontSize={0.34}
        color="#8b97a6"
        anchorX="center"
        outlineWidth={0.03}
        outlineColor="#0b0e13"
      >
        bregma
      </Text>
    </group>
  )
}

/**
 * Publishes the live renderer and scene so the export panel can render an
 * extra view of exactly what is on screen.
 */
function SceneHandlePublisher() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)

  useEffect(() => {
    setSceneHandle({ gl, scene, camera })
    return () => setSceneHandle(null)
  }, [gl, scene, camera])

  return null
}

/**
 * Applies the section planes to the renderer.
 *
 * Set globally on the renderer rather than per material: every material in the
 * scene must be cut by the same plane or the section would slice the anatomy
 * and leave the hardware whole, which reads as a rendering bug rather than as
 * a section. Setting it here also means the offscreen captures, which render
 * through this same renderer, come out sectioned exactly as the screen is.
 */
function SectionPlanes() {
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const section = useAppStore((s) => s.section)

  useEffect(() => {
    gl.clippingPlanes = sectionPlanes(section)
    invalidate()
    return () => {
      gl.clippingPlanes = []
    }
  }, [gl, invalidate, section])

  return null
}

/** Drives the camera to a standard view when one is requested. */
function ViewDriver({ view }: { view: { name: StandardView; nonce: number } | null }) {
  const { camera } = useThree()

  useEffect(() => {
    if (!view) return
    const position = STANDARD_VIEWS[view.name]
    camera.position.copy(position)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [view, camera])

  return null
}

function Scene({
  atlas,
  profile,
  view,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  view: { name: StandardView; nonce: number } | null
}) {
  const targets = useAppStore((s) => s.targets)
  const selectedTargetId = useAppStore((s) => s.selectedTargetId)
  const visibleStructureIds = useAppStore((s) => s.anatomy.visibleStructureIds)
  const collisionEnabled = useAppStore((s) => s.collisionEnabled)
  const collisionSettings = useAppStore((s) => s.collisionSettings)
  const setCollisionReport = useAppStore((s) => s.setCollisionReport)
  const measuring = useAppStore((s) => s.measuring)
  const onMeasureClick = useMeasurementClick()
  const groupRef = useRef<Group>(null)

  const matrix = useMemo(() => atlasToWorldMatrix(profile), [profile])

  // The brain surface is the anatomy every implant is checked against.
  const [brainGeometry, setBrainGeometry] = useState<BufferGeometry | null>(null)

  const anatomy = useMemo<AnatomyMesh[]>(
    () =>
      brainGeometry
        ? [{ id: 'brain', label: 'Brain surface', geometry: brainGeometry, matrix }]
        : [],
    [brainGeometry, matrix],
  )

  const { report, stale } = useCollision(anatomy, collisionSettings, collisionEnabled)

  // Publish into the store so panels and object colouring can read it without
  // the collision hook having to live at the top of the tree.
  useEffect(() => {
    setCollisionReport(report)
  }, [report, setCollisionReport])
  void stale

  return (
    <>
      <ambientLight intensity={1.5} />
      <directionalLight position={[8, 14, 10]} intensity={1.9} />
      <directionalLight position={[-10, -6, -8]} intensity={0.7} />

      <group ref={groupRef}>
        <BrainSurface
          matrix={matrix}
          onGeometry={setBrainGeometry}
          onPick={
            measuring
              ? (event) => {
                  // Stop here so the catcher sphere behind the brain does not
                  // also fire and overwrite the surface point with a far one.
                  event.stopPropagation()
                  onMeasureClick(event.point)
                }
              : undefined
          }
        />

        {visibleStructureIds.map((id) => {
          const structure = atlas.index.byId.get(id)
          if (!structure) return null
          const [r, g, b] = colorComponents(structure)
          return (
            <RegionMesh
              key={id}
              structureId={id}
              color={`rgb(${r},${g},${b})`}
              matrix={matrix}
            />
          )
        })}

        <Helper>
          <AxisTriad />
        </Helper>

        <SceneObjects />

        <Overlays />

        <Helper>
          <Measurements />
        </Helper>

        {/* While measuring, a large invisible sphere catches clicks that miss
            every mesh, so a point can still be placed in open space. */}
        {measuring && (
          <mesh
            onClick={(event) => {
              event.stopPropagation()
              onMeasureClick(event.point)
            }}
          >
            <sphereGeometry args={[60, 16, 16]} />
            <meshBasicMaterial visible={false} side={BackSide} />
          </mesh>
        )}

        <Helper>
          {targets.map((target) => (
            <TargetMarker
              key={target.id}
              target={target}
              selected={target.id === selectedTargetId}
            />
          ))}
        </Helper>
      </group>

      <SceneHandlePublisher />
      <SectionPlanes />
      <ViewDriver view={view} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        minDistance={2}
        maxDistance={80}
        target={[0, -2, 0]}
      />
    </>
  )
}

export function Viewport({
  atlas,
  profile,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
}) {
  // `nonce` lets the same view be re-selected to snap back to it.
  const [view, setView] = useState<{ name: StandardView; nonce: number } | null>(null)

  return (
    <div className="viewport">
      <div className="viewbar">
        {(Object.keys(STANDARD_VIEWS) as StandardView[]).map((name) => (
          <button
            key={name}
            className="btn"
            onClick={() => setView((v) => ({ name, nonce: (v?.nonce ?? 0) + 1 }))}
            title={`${name} view`}
          >
            {name.slice(0, 3)}
          </button>
        ))}
      </div>

      <Canvas
        camera={{ position: [14, 9, 16], fov: 40, near: 0.05, far: 400 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0b0e13']} />
        <Scene atlas={atlas} profile={profile} view={view} />
      </Canvas>

      <div className="hud">
        World units: mm · origin at bregma · {atlas.manifest.meshes.length} meshes available
      </div>
    </div>
  )
}

