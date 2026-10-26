/**
 * Drawing the back-traced routes into the target.
 *
 * One `LineSegments` for the whole trace rather than a line per source: a
 * dozen sources with sixty points each is a thousand segments, and drei's fat
 * lines allocate several attributes apiece. One buffer, one draw call, and the
 * colour per vertex carries which structure a route came from — so the picture
 * reads as "these regions, arriving from these directions" without a legend.
 *
 * Classified as a helper, like the measurement annotations and the axis triad:
 * a route is an annotation about the plan, not geometry that can block light,
 * so it must not appear in the objective view.
 */

import { Billboard, Text } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color } from 'three'

import { visibleSources, type RetrogradeSource } from '../overlays/retrograde.ts'
import { useAppStore } from '../state/store.ts'
import { Helper } from './Helper.tsx'
import { stereotaxicToWorld } from './world.ts'

/**
 * Minimum brightness along a route.
 *
 * Density along a path drops to exactly zero over stretches of white matter —
 * the sampled value is signal, not a count of axons passing — so shading
 * straight from it draws a route that vanishes mid-brain and reappears. The
 * floor keeps the route continuous while still letting the bright parts, where
 * the projection actually is, stand out.
 */
const MIN_BRIGHTNESS = 0.35

interface TraceBuffers {
  positions: Float32Array
  colors: Float32Array
  segmentCount: number
}

/**
 * Flatten the selected routes into one position/colour pair of buffers.
 *
 * Each route contributes `n - 1` segments, written as pairs of vertices
 * because `LineSegments` draws disconnected pairs — writing them as a strip
 * would join the end of one source's route to the start of the next, drawing a
 * line across the brain that is not data.
 */
function buildBuffers(sources: readonly RetrogradeSource[]): TraceBuffers | null {
  let segmentCount = 0
  for (const source of sources) {
    if (source.path.length > 1) segmentCount += source.path.length - 1
  }
  if (segmentCount === 0) return null

  const positions = new Float32Array(segmentCount * 6)
  const colors = new Float32Array(segmentCount * 6)
  const base = new Color()
  const shade = new Color()

  let at = 0
  for (const source of sources) {
    if (source.path.length < 2) continue
    base.set(source.structureColor)

    for (let i = 0; i < source.path.length - 1; i++) {
      const a = source.path[i]!
      const b = source.path[i + 1]!
      const from = stereotaxicToWorld(a.coord)
      const to = stereotaxicToWorld(b.coord)

      positions[at] = from.x
      positions[at + 1] = from.y
      positions[at + 2] = from.z
      positions[at + 3] = to.x
      positions[at + 4] = to.y
      positions[at + 5] = to.z

      // Shaded by the density at each end, so a route brightens where the
      // projection it follows is actually dense.
      for (const [offset, point] of [
        [0, a],
        [3, b],
      ] as const) {
        const weight = MIN_BRIGHTNESS + (1 - MIN_BRIGHTNESS) * Math.min(1, point.density)
        shade.copy(base).multiplyScalar(weight)
        colors[at + offset] = shade.r
        colors[at + offset + 1] = shade.g
        colors[at + offset + 2] = shade.b
      }

      at += 6
    }
  }

  return { positions, colors, segmentCount }
}

function TraceLines({ sources }: { sources: readonly RetrogradeSource[] }) {
  const buffers = useMemo(() => buildBuffers(sources), [sources])

  const geometry = useMemo(() => {
    if (!buffers) return null
    const buffer = new BufferGeometry()
    buffer.setAttribute('position', new BufferAttribute(buffers.positions, 3))
    buffer.setAttribute('color', new BufferAttribute(buffers.colors, 3))
    buffer.computeBoundingSphere()
    return buffer
  }, [buffers])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return null

  return (
    <lineSegments geometry={geometry} renderOrder={2}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={0.85}
        // Additive, matching the projection clouds: where several sources
        // arrive along the same route it brightens, which is the right reading.
        blending={AdditiveBlending}
        depthWrite={false}
      />
    </lineSegments>
  )
}

/**
 * A labelled dot at each source's injection site.
 *
 * The route says which way an afferent arrives; this says where it starts, and
 * is the thing a plan is actually about — the region you would have to be able
 * to reach, or avoid, for the connection to matter.
 */
function SourceMarkers({ sources }: { sources: readonly RetrogradeSource[] }) {
  // One marker per structure, at its strongest experiment. A dozen CA3
  // injections would otherwise stack a dozen identical labels on each other.
  const marks = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; abbrev: string; color: string; at: [number, number, number] }[] = []

    for (const source of sources) {
      if (!source.injectionCentre || seen.has(source.structureAbbrev)) continue
      seen.add(source.structureAbbrev)
      const world = stereotaxicToWorld(source.injectionCentre)
      out.push({
        key: `${source.structureAbbrev}-${source.experimentId}`,
        abbrev: source.structureAbbrev,
        color: source.structureColor,
        at: [world.x, world.y, world.z],
      })
    }
    return out
  }, [sources])

  return (
    <group>
      {marks.map((mark) => (
        <group key={mark.key} position={mark.at}>
          <mesh renderOrder={4}>
            <sphereGeometry args={[0.13, 16, 16]} />
            <meshBasicMaterial color={mark.color} depthTest={false} />
          </mesh>
          <Billboard position={[0, 0.34, 0]}>
            <Text
              fontSize={0.34}
              color={mark.color}
              anchorX="center"
              anchorY="bottom"
              outlineWidth={0.03}
              outlineColor="#0b0e13"
            >
              {mark.abbrev}
            </Text>
          </Billboard>
        </group>
      ))}
    </group>
  )
}

export function BackTrace() {
  const backtrace = useAppStore((s) => s.backtrace)

  const sources = useMemo(
    () =>
      visibleSources(backtrace.sources, {
        includeOverlapping: backtrace.includeOverlapping,
        topStructures: backtrace.topStructures,
        focusAbbrev: backtrace.focusAbbrev,
      }),
    [
      backtrace.sources,
      backtrace.includeOverlapping,
      backtrace.topStructures,
      backtrace.focusAbbrev,
    ],
  )

  if (!backtrace.showPaths || sources.length === 0) return null

  return (
    <Helper>
      <TraceLines sources={sources} />
      <SourceMarkers sources={sources} />
    </Helper>
  )
}
