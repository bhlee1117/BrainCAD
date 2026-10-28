/**
 * The second brain: retrograde strength painted onto anatomy.
 *
 * A separate canvas rather than a layer in the main viewport, because the two
 * answer different questions and would fight for the same pixels. The main
 * view is about hardware and access and is full of translucent geometry; this
 * one has to show a faint source at the bottom of the brain through everything
 * in front of it. Side by side on one camera, the comparison is immediate —
 * *the thing I can reach is here, the inputs come from there* — and neither
 * view has to compromise.
 *
 * Its camera is driven from the main view's (see `cameraLink.ts`) and has no
 * controls of its own. Orbiting either one independently is exactly what would
 * make the pair misleading.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Matrix4,
  PerspectiveCamera,
} from 'three'

import type { LoadedAtlas } from '../atlas/load.ts'
import type { CoordinateProfile } from '../atlas/profile.ts'
import type { Stereotaxic } from '../atlas/coords.ts'
import {
  buildRouteHeat,
  heatmapColors,
  type RetrogradeHeatmap,
} from '../overlays/heatmap.ts'
import type { RetrogradeSource } from '../overlays/retrograde.ts'
import { positionsToWorld } from '../overlays/pointCloud.ts'
import { useAppStore } from '../state/store.ts'
import { readCameraPose } from './cameraLink.ts'
import { TARGET_COLOR } from './Viewport.tsx'
import { useAtlasMeshGeometry } from './useAtlasMeshGeometry.ts'
import { atlasToWorldMatrix, stereotaxicToWorld } from './world.ts'

/** Whole-brain root structure id in the Allen ontology. */
const ROOT_STRUCTURE_ID = 997

/** Copies the main viewport's camera onto this canvas's, every frame. */
function CameraFollower() {
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)

  useFrame(() => {
    const pose = readCameraPose()
    camera.position.copy(pose.position)
    camera.quaternion.copy(pose.quaternion)

    const perspective = camera as PerspectiveCamera
    if (perspective.isPerspectiveCamera) {
      // Field of view is copied but aspect is this canvas's own: the two panes
      // are not the same width, and forcing the main view's aspect here would
      // stretch the brain rather than show the same framing in a narrower box.
      perspective.fov = pose.fov
      perspective.aspect = size.width / Math.max(1, size.height)
    }
    camera.zoom = pose.zoom
    camera.updateProjectionMatrix()
  })

  return null
}

/**
 * The brain shell, drawn dimmer than in the main view.
 *
 * It is context here, not the subject — its job is to say which way round the
 * head is, and anything brighter competes with the heat it is meant to frame.
 */
function BrainShell({ matrix }: { matrix: Matrix4 }) {
  const geometry = useAtlasMeshGeometry(ROOT_STRUCTURE_ID)
  if (!geometry) return null

  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh geometry={geometry} renderOrder={-2}>
        <meshStandardMaterial
          color="#6d7f93"
          transparent
          opacity={0.1}
          side={BackSide}
          depthWrite={false}
          roughness={0.9}
        />
      </mesh>
      <mesh geometry={geometry} renderOrder={-1}>
        <meshStandardMaterial
          color="#8ea4bb"
          transparent
          opacity={0.05}
          side={DoubleSide}
          depthWrite={false}
          roughness={0.9}
        />
      </mesh>
    </group>
  )
}

/** The heat cloud itself. */
function HeatPoints({
  heatmap,
  matrix,
  opacity,
  pointSizeMm,
}: {
  heatmap: RetrogradeHeatmap
  matrix: Matrix4
  opacity: number
  pointSizeMm: number
}) {
  const geometry = useMemo(() => {
    const world = positionsToWorld(heatmap.positionsUm, matrix)
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(world, 3))
    buffer.setAttribute('color', new BufferAttribute(heatmapColors(heatmap), 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [heatmap, matrix])

  useEffect(() => () => geometry.dispose(), [geometry])

  if (heatmap.pointCount === 0) return null

  return (
    <points geometry={geometry} renderOrder={2}>
      {/*
        Not additive, which was the first thing tried and was wrong in a way
        that looked good: overlapping voxels summed, so a thick region blew out
        to white and the colour encoded how much tissue lay along the view ray
        rather than how strong the input was. The whole brain read as a hub.

        Plain blending with depth means a pixel shows the nearest painted
        voxel, so its colour is a strength and nothing else. The cost is
        occlusion — an interior hub hides behind the cortex in front of it —
        which is what the opacity control is for, and why the view orbits with
        the main one rather than being a fixed picture.
      */}
      <pointsMaterial
        size={pointSizeMm}
        sizeAttenuation
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.9}
      />
    </points>
  )
}

/**
 * Every injection site, as translucent grey dots over the painted regions.
 *
 * The colours answer "how hard does this region drive the target"; these
 * answer "and where did the needles actually go". The pair is worth seeing
 * together because a bright region backed by one injection and a bright region
 * backed by twelve are different claims, and the painted cloud alone cannot
 * tell them apart — it keeps one value per structure by design, so a region
 * sampled once and a region sampled a dozen times are the same colour.
 *
 * Grey and unlit on purpose: anything on the heat ramp would read as another
 * strength, and this layer is a count of needles rather than a measurement.
 *
 * Drawn with the depth test off, which is unusual enough to say why. The
 * colours and the dots describe the same places — a strong source is strong
 * *because* a needle went there — so with depth on, the layer that is supposed
 * to explain the colours is hidden behind exactly the colours it explains.
 * Off, every injection is visible and the dots read as an overlay rather than
 * as objects in the scene, which is what they are. They are drawn before the
 * target pin so the one thing that is a position rather than a reference stays
 * on top.
 *
 * These are already stereotaxic millimetres, which is world space, so they
 * need no atlas matrix — the coordinates came back from Allen as coordinates.
 */
function InjectionDots({
  sites,
  sizeMm,
}: {
  sites: readonly Stereotaxic[]
  sizeMm: number
}) {
  const geometry = useMemo(() => {
    if (sites.length === 0) return null
    const points = new Float32Array(sites.length * 3)
    for (let i = 0; i < sites.length; i++) {
      const world = stereotaxicToWorld(sites[i]!)
      points[i * 3] = world.x
      points[i * 3 + 1] = world.y
      points[i * 3 + 2] = world.z
    }
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(points, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [sites])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null

  return (
    <points geometry={geometry} renderOrder={3}>
      <pointsMaterial
        size={sizeMm}
        sizeAttenuation
        // Cool neutral rather than white: the heat ramp tops out near-white,
        // and a hot region and a needle should not be the same colour.
        color="#aeb6c4"
        transparent
        // Low enough that overlap is the signal rather than saturation: a
        // heavily sampled nucleus accumulates into a visibly brighter patch
        // and a single needle stays faint. Tuned for the whole corpus — at
        // 0.35 the 2,915 dots blew out to a solid white half and the one
        // thing the layer is for, the gaps, went with it.
        opacity={0.2}
        depthWrite={false}
        depthTest={false}
      />
    </points>
  )
}

/**
 * The target, drawn the same way in both views.
 *
 * Deliberately not the main viewport's full marker with its whiskers and
 * label: in this view the target is the one fixed point everything else is
 * measured against, and it needs to stay legible on top of a bright hub
 * without adding another three lines of annotation to read.
 */
function TargetPin({ coord }: { coord: Stereotaxic }) {
  const position = useMemo(() => stereotaxicToWorld(coord), [coord])

  const ring = useMemo(() => {
    const points: number[] = []
    const radius = 0.55
    for (let i = 0; i <= 64; i++) {
      const angle = (i / 64) * Math.PI * 2
      points.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
    }
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(Float32Array.from(points), 3))
    return buffer
  }, [])

  useEffect(() => () => ring.dispose(), [ring])

  return (
    <group position={position}>
      <mesh renderOrder={5}>
        <sphereGeometry args={[0.17, 20, 20]} />
        <meshBasicMaterial color={TARGET_COLOR} depthTest={false} />
      </mesh>
      <line>
        <primitive object={ring} attach="geometry" />
        <lineBasicMaterial
          color={TARGET_COLOR}
          transparent
          opacity={0.85}
          depthTest={false}
        />
      </line>
    </group>
  )
}

/**
 * The traced routes, on the heat ramp.
 *
 * Built in stereotaxic millimetres, which is already world space, so unlike
 * the region cloud these need no atlas matrix — the paths came back as
 * coordinates, not as voxels.
 */
function HeatRoutes({
  sources,
  opacity,
}: {
  sources: readonly RetrogradeSource[]
  opacity: number
}) {
  const geometry = useMemo(() => {
    const heat = buildRouteHeat(sources)
    if (heat.segmentCount === 0) return null
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(heat.points, 3))
    buffer.setAttribute('color', new BufferAttribute(heat.colors, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [sources])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null

  return (
    <lineSegments geometry={geometry} renderOrder={2}>
      <lineBasicMaterial
        vertexColors
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={false}
      />
    </lineSegments>
  )
}

function HeatScene({
  atlas,
  profile,
  heatmap,
  routeSources,
  injectionSites,
  target,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  heatmap: RetrogradeHeatmap | null
  routeSources: readonly RetrogradeSource[]
  injectionSites: readonly Stereotaxic[]
  target: Stereotaxic | null
}) {
  const matrix = useMemo(() => atlasToWorldMatrix(profile), [profile])
  const backtrace = useAppStore((s) => s.backtrace)
  void atlas

  return (
    <>
      {/* Flat lighting on purpose: the shell is a silhouette and the heat is
          unlit points, so a modelled light would only add shading that reads
          as variation in the data. */}
      <ambientLight intensity={2.2} />
      <directionalLight position={[8, 14, 10]} intensity={0.6} />

      <BrainShell matrix={matrix} />

      {backtrace.heatMode === 'regions' && heatmap && (
        <HeatPoints
          heatmap={heatmap}
          matrix={matrix}
          opacity={backtrace.heatOpacity}
          pointSizeMm={backtrace.heatPointSizeMm}
        />
      )}

      {backtrace.heatMode === 'routes' && (
        <HeatRoutes sources={routeSources} opacity={backtrace.heatOpacity} />
      )}

      {/* Over both modes: where the needles went is context for either. */}
      <InjectionDots sites={injectionSites} sizeMm={backtrace.heatPointSizeMm * 1.2} />

      {target && <TargetPin coord={target} />}

      <CameraFollower />
    </>
  )
}

export function HeatmapViewport({
  atlas,
  profile,
  heatmap,
  routeSources,
  injectionSites,
  target,
  caption,
}: {
  atlas: LoadedAtlas
  profile: CoordinateProfile
  heatmap: RetrogradeHeatmap | null
  routeSources: readonly RetrogradeSource[]
  /** Where every experiment in the current answer was injected. */
  injectionSites: readonly Stereotaxic[]
  target: Stereotaxic | null
  caption: string
}) {
  return (
    <div className="viewport viewport--heat">
      <Canvas
        camera={{ position: [14, 9, 16], fov: 40, near: 0.05, far: 400 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#07090d']} />
        <HeatScene
          atlas={atlas}
          profile={profile}
          heatmap={heatmap}
          routeSources={routeSources}
          injectionSites={injectionSites}
          target={target}
        />
      </Canvas>

      <div className="hud hud--heat">{caption}</div>
    </div>
  )
}
