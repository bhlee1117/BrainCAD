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
 * Minimum brightness of a route.
 *
 * Even the weakest source has to stay visible as a route — the picture is
 * about *where afferents arrive from*, and a line too faint to follow answers
 * nothing. The floor is the brightness a density of zero maps to; everything
 * above it spreads over the rest of the ramp.
 */
const MIN_BRIGHTNESS = 0.35

/**
 * A route is shaded by its source's strength at the target, one value for the
 * whole line, and deliberately not by the per-point density Allen attaches to
 * the path.
 *
 * That field looked like the obvious thing to use and is almost entirely zero.
 * On a real response a CA3 experiment delivering 0.981 at the target carries
 * the path densities [0, 0, 0, 0, 0, 0, 0, 0, 0.386, 0] — nine zeros, one
 * value next to the injection, and a zero at the target itself, which is the
 * one place the row's own number says the signal is strongest. It is not the
 * same quantity on the same scale, so shading by it drew every route at the
 * floor with a single bright segment near its far end: a picture of where
 * Allen's sampler happened to find signal, not of anything anatomical.
 *
 * The strength at the target is the number the route means — "this is how that
 * source reaches here" — and it is what the hub map's routes view already
 * uses, so the two now agree.
 */
/**
 * Source-marker dot and label size, in world millimetres.
 *
 * Small on purpose. A dozen sources put a dozen dots and a dozen words into a
 * 13 mm brain, and at the size an annotation wants to be they cover the
 * anatomy they are annotating — the markers stop being labels on a picture and
 * become the picture.
 */
const MARKER_RADIUS_MM = 0.065
const LABEL_SIZE_MM = 0.17

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

  // Normalised against the strongest route drawn, not against 1.0: a target
  // whose best input is 0.08 would otherwise render every route at the floor,
  // hiding the very ranking the shading exists to show.
  let peak = 0
  for (const source of sources) {
    if (source.densityAtTarget > peak) peak = source.densityAtTarget
  }
  const scale = peak > 0 ? 1 / peak : 0

  let at = 0
  for (const source of sources) {
    if (source.path.length < 2) continue

    // Square root for the same reason the projection clouds use one:
    // densities are heavily skewed, and a linear ramp puts almost every route
    // at the floor next to one saturated source.
    const weight =
      MIN_BRIGHTNESS +
      (1 - MIN_BRIGHTNESS) * Math.sqrt(Math.min(1, source.densityAtTarget * scale))
    base.set(source.structureColor)
    shade.copy(base).multiplyScalar(weight)

    for (let i = 0; i < source.path.length - 1; i++) {
      const from = stereotaxicToWorld(source.path[i]!.coord)
      const to = stereotaxicToWorld(source.path[i + 1]!.coord)

      positions[at] = from.x
      positions[at + 1] = from.y
      positions[at + 2] = from.z
      positions[at + 3] = to.x
      positions[at + 4] = to.y
      positions[at + 5] = to.z

      for (let k = 0; k < 6; k += 3) {
        colors[at + k] = shade.r
        colors[at + k + 1] = shade.g
        colors[at + k + 2] = shade.b
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
            <sphereGeometry args={[MARKER_RADIUS_MM, 16, 16]} />
            <meshBasicMaterial color={mark.color} depthTest={false} />
          </mesh>
          <Billboard position={[0, LABEL_SIZE_MM, 0]}>
            <Text
              fontSize={LABEL_SIZE_MM}
              color={mark.color}
              anchorX="center"
              anchorY="bottom"
              outlineWidth={0.015}
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
