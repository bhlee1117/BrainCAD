/**
 * Rendering projection overlays as point clouds.
 *
 * One `THREE.Points` per overlay, with per-vertex colour, so a hundred thousand
 * points cost a single draw call. Positions arrive already in world space —
 * mapped through the same atlas-to-world matrix as the anatomy — so the overlay
 * is registered by construction rather than by a parallel calculation.
 */

import { Billboard, Line, Text } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Vector3 } from 'three'

import {
  NEURON_AXON_COLOR,
  NEURON_DENDRITE_COLOR,
  type NeuronOverlay,
  type ProjectionOverlay,
} from '../overlays/model.ts'
import { useAppStore } from '../state/store.ts'
import { Helper } from './Helper.tsx'
import { stereotaxicToWorld } from './world.ts'

/**
 * A marker at the injection centre.
 *
 * The white voxel cloud shows the site's extent, but extent is hard to judge
 * inside a translucent brain full of other points — this says plainly "the
 * tracer went in here". Drawn as a ringed sphere so it reads as an annotation
 * rather than as more data, and billboarded so the label faces the reader from
 * any angle.
 *
 * Classified as a helper: it is an annotation, not physical geometry, so it is
 * excluded from the objective view where only things that can actually block
 * light belong.
 */
function InjectionMarker({ overlay }: { overlay: ProjectionOverlay }) {
  const centre = overlay.injection.centre

  const position = useMemo(
    () => (centre ? stereotaxicToWorld(centre) : null),
    [centre],
  )

  // A ring in the horizontal plane, so the marker reads as a site rather than
  // another projection point.
  const ring = useMemo(() => {
    const points: Vector3[] = []
    const radius = 0.42
    for (let i = 0; i <= 48; i++) {
      const angle = (i / 48) * Math.PI * 2
      points.push(new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius))
    }
    return points
  }, [])

  if (!position || !overlay.visible || !overlay.showInjection) return null

  const label =
    overlay.injection.structures[0] ?? overlay.name.replace(/ →.*$/, '')

  return (
    <group position={position}>
      <mesh renderOrder={4}>
        <sphereGeometry args={[0.18, 20, 20]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>

      <Line points={ring} color="#ffffff" lineWidth={1.4} transparent opacity={0.8} />

      <Billboard position={[0, 0.62, 0]}>
        <Text
          fontSize={0.38}
          color="#ffffff"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.035}
          outlineColor="#0b0e13"
        >
          {`injection · ${label}`}
        </Text>
      </Billboard>
    </group>
  )
}

/**
 * The injection site, drawn in white rather than on the overlay's density ramp.
 *
 * Deliberately not the same colour as the projections. The site is where the
 * tracer was *put*, not somewhere it travelled to, and rendering both on one
 * scale invites reading the brightest region as the strongest target when it is
 * the opposite.
 */
function InjectionPoints({ overlay }: { overlay: ProjectionOverlay }) {
  const positions = overlay.injection.worldPositions

  const geometry = useMemo(() => {
    if (!positions) return null
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(positions, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [positions])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry || !overlay.visible || !overlay.showInjection) return null

  return (
    <points geometry={geometry} renderOrder={3}>
      <pointsMaterial
        size={overlay.pointSizeMm * 1.4}
        sizeAttenuation
        color="#ffffff"
        transparent
        opacity={Math.min(1, overlay.opacity * 0.9)}
        depthWrite={false}
      />
    </points>
  )
}

function OverlayPoints({ overlay }: { overlay: ProjectionOverlay }) {
  const geometry = useMemo(() => {
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(overlay.worldPositions, 3))
    buffer.setAttribute('color', new BufferAttribute(overlay.colors, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [overlay.worldPositions, overlay.colors])

  useEffect(() => () => geometry.dispose(), [geometry])

  if (!overlay.visible || overlay.cloud.pointCount === 0) return null

  return (
    <points geometry={geometry} renderOrder={2}>
      <pointsMaterial
        size={overlay.pointSizeMm}
        sizeAttenuation
        vertexColors
        transparent
        opacity={overlay.opacity}
        // Additive blending makes overlapping projections accumulate, which is
        // the right reading for density: where more axons are, it glows more.
        blending={AdditiveBlending}
        // Depth writes off so the cloud does not punch holes in the translucent
        // brain surface drawn behind it.
        depthWrite={false}
      />
    </points>
  )
}

/**
 * One arbor, drawn as line segments.
 *
 * `LineSegments` rather than drei's `<Line>`: an axon runs to several thousand
 * nodes, and the fat-line implementation allocates several attributes per
 * segment. Plain GL lines are one buffer and one draw call, which is what makes
 * a dozen neurons practical.
 */
function ArborLines({
  positions,
  color,
  opacity,
}: {
  positions: Float32Array | null
  color: string
  opacity: number
}) {
  const geometry = useMemo(() => {
    if (!positions || positions.length === 0) return null
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(positions, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [positions])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null

  return (
    <lineSegments geometry={geometry} renderOrder={2}>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
      />
    </lineSegments>
  )
}

function NeuronArbors({ overlay }: { overlay: NeuronOverlay }) {
  const soma = overlay.somaWorld

  if (!overlay.visible) return null

  return (
    <group>
      {overlay.showAxon && (
        <ArborLines
          positions={overlay.axonWorld}
          color={NEURON_AXON_COLOR}
          opacity={overlay.opacity}
        />
      )}
      {overlay.showDendrite && (
        <ArborLines
          positions={overlay.dendriteWorld}
          color={NEURON_DENDRITE_COLOR}
          opacity={overlay.opacity}
        />
      )}

      {soma && (
        <mesh position={[soma[0], soma[1], soma[2]]} renderOrder={3}>
          <sphereGeometry args={[0.06, 14, 14]} />
          <meshBasicMaterial color={overlay.color} />
        </mesh>
      )}
    </group>
  )
}

export function Overlays() {
  const overlays = useAppStore((s) => s.overlays)

  return (
    <group>
      {overlays.map((overlay) =>
        overlay.kind === 'neuron-arbor' ? (
          <NeuronArbors key={overlay.id} overlay={overlay} />
        ) : (
          <group key={overlay.id}>
            <OverlayPoints overlay={overlay} />
            <InjectionPoints overlay={overlay} />
            <Helper>
              <InjectionMarker overlay={overlay} />
            </Helper>
          </group>
        ),
      )}
    </group>
  )
}
