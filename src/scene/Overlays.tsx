/**
 * Rendering projection overlays as point clouds.
 *
 * One `THREE.Points` per overlay, with per-vertex colour, so a hundred thousand
 * points cost a single draw call. Positions arrive already in world space —
 * mapped through the same atlas-to-world matrix as the anatomy — so the overlay
 * is registered by construction rather than by a parallel calculation.
 */

import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry } from 'three'

import type { ProjectionOverlay } from '../overlays/model.ts'
import { useAppStore } from '../state/store.ts'

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

export function Overlays() {
  const overlays = useAppStore((s) => s.overlays)

  return (
    <group>
      {overlays.map((overlay) => (
        <group key={overlay.id}>
          <OverlayPoints overlay={overlay} />
          <InjectionPoints overlay={overlay} />
        </group>
      ))}
    </group>
  )
}
