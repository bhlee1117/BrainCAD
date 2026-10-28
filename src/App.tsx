/**
 * BrainCAD application shell.
 *
 * Tabs follow the blueprint's mode structure (§6). PLAN and ATLAS are live at
 * M1; the rest are present but disabled so the intended shape of the tool is
 * visible without pretending the features exist.
 */

import { useEffect, useMemo, useState } from 'react'

import { loadAtlas } from './atlas/load.ts'
import { assertProfileMatchesSpace } from './atlas/profile.ts'
import { Viewport } from './scene/Viewport.tsx'
import {
  useAppStore,
  useAtlas,
  useProfile,
  useSelectedObject,
  useSelectedTarget,
  useSourceSideFilter,
} from './state/store.ts'
import { useTargetNudge } from './state/useTargetNudge.ts'
import { useUndoShortcuts } from './state/useUndoShortcuts.ts'
import { CollisionPanel } from './ui/CollisionPanel.tsx'
import { ExportPanel } from './ui/ExportPanel.tsx'
import { MeasurePanel } from './ui/MeasurePanel.tsx'
import { MobileSheet, ObjectsTab } from './ui/MobileSheet.tsx'
import { OpticsPanel } from './ui/OpticsPanel.tsx'
import { ObjectProperties } from './ui/ObjectProperties.tsx'
import { ObjectsPanel } from './ui/ObjectsPanel.tsx'
import { OverlaysPanel } from './ui/OverlaysPanel.tsx'
import { PlanPanel } from './ui/PlanPanel.tsx'
import { HeatmapViewport } from './scene/HeatmapViewport.tsx'
import {
  describeHubMap,
  useConvergenceMatrix,
  useBacktraceHeatmap,
  useHeatmapSources,
  useSectionHubPaint,
  useVoxelConvergence,
  useVoxelPaint,
} from './overlays/useHubMap.ts'
import { formatConvergence } from './overlays/convergence.ts'
import { visibleSources } from './overlays/retrograde.ts'
import type { Stereotaxic } from './atlas/coords.ts'
import { decode } from './overlays/voxelConvergence.ts'
import { BackTracePanel } from './ui/BackTracePanel.tsx'
import { AtlasPanel, ProfilePanel, ScenePanel } from './ui/SidePanels.tsx'
import { SlicePanel } from './ui/SlicePanel.tsx'

type Tab =
  | 'PLAN'
  | 'OBJECTS'
  | 'ATLAS'
  | 'OVERLAYS'
  | 'BACKTRACE'
  | 'SLICES'
  | 'MEASURE'
  | 'OPTICS'
  | 'EXPORT'

const TABS: readonly {
  id: Tab
  enabled: boolean
  title: string
  /** Only offered in the compact layout. */
  compactOnly?: boolean
}[] = [
  { id: 'PLAN', enabled: true, title: 'Target and trajectory planning' },
  { id: 'OBJECTS', enabled: true, title: 'Hardware primitives and custom geometry' },
  { id: 'ATLAS', enabled: true, title: 'Atlas browsing and region meshes' },
  { id: 'OVERLAYS', enabled: true, title: 'Axon projection data from the Allen Connectivity Atlas' },
  {
    id: 'BACKTRACE',
    enabled: true,
    title: 'What projects to the target, traced back from it',
  },
  // The desktop keeps the slice strip permanently under the 3D view, so this
  // tab would be a second way to see what is already on screen. On a phone
  // there is no room for the strip and the slices were simply unavailable.
  {
    id: 'SLICES',
    enabled: true,
    title: 'Coronal, sagittal and horizontal sections at the target',
    compactOnly: true,
  },
  { id: 'MEASURE', enabled: true, title: 'Two-point distance measurement' },
  { id: 'OPTICS', enabled: true, title: 'Objective approach-angle sweep' },
  { id: 'EXPORT', enabled: true, title: 'Project file and planning sheet' },
]

/**
 * Whether the compact rig layout should be used.
 *
 * A media query rather than a user-agent check, and read live, so rotating a
 * tablet or resizing a window moves between layouts instead of stranding the
 * user in whichever one happened to load first.
 */
function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const update = (event: MediaQueryListEvent) => setCompact(event.matches)
    query.addEventListener('change', update)
    setCompact(query.matches)
    return () => query.removeEventListener('change', update)
  }, [])

  return compact
}

export function App() {
  const [tab, setTab] = useState<Tab>('PLAN')
  const compact = useCompactLayout()
  const atlas = useAtlas()
  const profile = useProfile()
  const target = useSelectedTarget()
  const sourceSide = useSourceSideFilter()
  const selectedObject = useSelectedObject()
  useUndoShortcuts()
  useTargetNudge()

  const atlasStatus = useAppStore((s) => s.atlasStatus)
  const setAtlasStatus = useAppStore((s) => s.setAtlasStatus)
  const backtrace = useAppStore((s) => s.backtrace)

  // The hub map is built here rather than in the panel so the second canvas
  // does not depend on a panel that is unmounted the moment the layout goes
  // compact — and so the cost is paid once, not once per consumer.
  const hubMapOn = tab === 'BACKTRACE' && backtrace.showHeatmap
  const showHeatmap = hubMapOn && backtrace.heatSurface === 'brain' && !compact

  // Two grains, one surface. The structure paint reads the bundled matrix; the
  // voxel paint reads the raw 100 µm grids, which are only downloaded once
  // that grain is actually chosen.
  const sectionsOn = hubMapOn && backtrace.heatSurface === 'sections'
  const voxelOn = sectionsOn && backtrace.heatGrain === 'voxels'

  // Only the sections read the connectome matrix now, so it is not fetched for
  // a session that opens the tab straight onto the second brain.
  const convergence = useConvergenceMatrix(sectionsOn && !voxelOn)

  const routeSources = useHeatmapSources(backtrace, target?.coord ?? null)

  // The second brain paints the back-trace, not the connectome: how hard each
  // source drives *this* target. The hub map is the sections' job, and the two
  // answer different questions — one moves with the target and one does not.
  const heatmap = useBacktraceHeatmap(showHeatmap ? atlas : null, routeSources)

  // Every injection in the current answer, drawn grey over the colours. Not
  // cut to the top N: the point of the layer is the sampling behind the
  // colours, and the structures that fell below the cut were still injected.
  const injectionSites = useMemo(
    () =>
      showHeatmap
        ? visibleSources(backtrace.sources, {
            includeOverlapping: true,
            topStructures: Number.POSITIVE_INFINITY,
            focusAbbrev: null,
            side: sourceSide,
          })
            .map((source) => source.injectionCentre)
            .filter((centre): centre is Stereotaxic => centre !== null)
        : [],
    [showHeatmap, backtrace.sources, sourceSide],
  )

  const voxels = useVoxelConvergence(voxelOn)
  const voxelPaint = useVoxelPaint(
    voxelOn ? voxels.map : null,
    backtrace.heatMetric,
    atlas?.space ?? null,
  )
  const structurePaint = useSectionHubPaint(
    atlas,
    sectionsOn && !voxelOn ? convergence.matrix : null,
    backtrace.heatMetric,
    backtrace.connectionThreshold,
  )

  const sectionHub = voxelOn
    ? voxelPaint && {
        paint: voxelPaint.paint,
        caption:
          `Sections coloured by convergence · voxels (100 µm) · ` +
          `${backtrace.heatMetric} · up to ` +
          `${formatConvergence(backtrace.heatMetric, decode(backtrace.heatMetric, voxelPaint.range.max))}` +
          ` at the 99th percentile · the left half is the injected hemisphere · ` +
          `${voxels.map?.header.experiments ?? 0} experiments`,
      }
    : structurePaint
  const heatmapCaption = describeHubMap(
    backtrace,
    heatmap,
    routeSources.length,
    injectionSites.length,
  )

  // Widening the window retires the compact-only tabs. Without this, rotating a
  // tablet while on SLICES leaves the active tab pointing at a button that is
  // no longer in the strip.
  useEffect(() => {
    if (!compact && TABS.find((t) => t.id === tab)?.compactOnly) setTab('PLAN')
  }, [compact, tab])

  useEffect(() => {
    // The load itself is shared and uncancellable; this flag only suppresses
    // state updates from an effect run that has already been torn down.
    let live = true

    setAtlasStatus({ kind: 'loading', message: 'Starting' })
    loadAtlas((progress) => {
      if (live) setAtlasStatus({ kind: 'loading', message: progress.message })
    })
      .then((loaded) => {
        if (!live) return
        // Guard against pairing a profile with a volume it does not describe.
        assertProfileMatchesSpace(profile, loaded.space)
        setAtlasStatus({ kind: 'ready', atlas: loaded })
      })
      .catch((error: unknown) => {
        if (!live) return
        setAtlasStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      live = false
    }
    // Intentionally runs once: the atlas assets do not change during a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The panel for the active tab, built once and used by whichever layout is
  // mounted. Keeping it in one place is what stops the two layouts drifting —
  // the compact branch used to omit it entirely, which left every header tab
  // changing state and rendering nothing on a phone.
  const tabPanel =
    atlas && tab === 'ATLAS' ? (
      <AtlasPanel atlas={atlas} />
    ) : atlas && tab === 'SLICES' ? (
      target ? (
        <SlicePanel
          atlas={atlas}
          profile={profile}
          coord={target.coord}
          voxelPaint={sectionHub?.paint}
          caption={sectionHub?.caption ?? (voxelOn ? voxels.message : undefined)}
        />
      ) : (
        <p className="mhint">No target selected — sections follow the target.</p>
      )
    ) : tab === 'OBJECTS' ? (
      <ObjectsPanel />
    ) : tab === 'OVERLAYS' && atlas ? (
      <OverlaysPanel atlas={atlas} profile={profile} />
    ) : tab === 'BACKTRACE' && atlas ? (
      <BackTracePanel atlas={atlas} profile={profile} />
    ) : tab === 'MEASURE' ? (
      <MeasurePanel />
    ) : tab === 'OPTICS' ? (
      <OpticsPanel />
    ) : tab === 'EXPORT' && atlas ? (
      <ExportPanel atlas={atlas} profile={profile} />
    ) : (
      <ScenePanel />
    )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          BrainCAD<span>3D stereotaxic planning</span>
        </div>
        <nav className="tabs">
          {TABS.filter((entry) => !entry.compactOnly || compact).map((entry) => (
            <button
              key={entry.id}
              className="tab"
              aria-selected={tab === entry.id}
              disabled={!entry.enabled}
              title={entry.title}
              onClick={() => setTab(entry.id)}
            >
              {entry.id}
            </button>
          ))}
        </nav>
      </header>

      <div className={compact ? 'main main--compact' : 'main'}>
        {!compact && <aside className="panel panel--left">{tabPanel}</aside>}

        <div style={{ display: 'grid', gridTemplateRows: '1fr auto', minWidth: 0 }}>
          <div className={showHeatmap ? 'viewrow viewrow--split' : 'viewrow'}>
            {atlas ? (
              <Viewport atlas={atlas} profile={profile} />
            ) : (
              <div className="viewport" />
            )}

            {/* The second brain only exists while BACKTRACE is open. It is a
                reading of the target, not a permanent part of the scene, and
                a canvas left running behind other tabs would cost a frame
                budget for a view nobody is looking at. */}
            {showHeatmap && atlas && (
              <HeatmapViewport
                atlas={atlas}
                profile={profile}
                heatmap={heatmap}
                routeSources={routeSources}
                injectionSites={injectionSites}
                target={target?.coord ?? null}
                caption={heatmapCaption}
              />
            )}

            {atlasStatus.kind === 'loading' && (
              <div className="overlay">
                <div>
                  <h3>Loading atlas</h3>
                  <p>{atlasStatus.message}…</p>
                </div>
              </div>
            )}

            {atlasStatus.kind === 'error' && (
              <div className="overlay">
                <div>
                  <h3>Atlas assets not available</h3>
                  <p>
                    {atlasStatus.message}
                    <br />
                    <br />
                    Build them with <code>npm run atlas:fetch</code>, then reload.
                  </p>
                </div>
              </div>
            )}
          </div>

          {atlas && target && !compact && (
            <SlicePanel
              atlas={atlas}
              profile={profile}
              coord={target.coord}
              voxelPaint={sectionHub?.paint}
                  caption={sectionHub?.caption ?? (voxelOn ? voxels.message : undefined)}
            />
          )}
        </div>

        {compact && atlas && (
          <MobileSheet atlas={atlas} profile={profile} target={target} tab={tab}>
            {/* The rig controls lead, then the same panel the desktop shows —
                angle is what gets nudged at the rig, but the library has to be
                reachable or OBJECTS is a dead end on a phone. */}
            {tab === 'OBJECTS' && <ObjectsTab />}
            <div className="panel panel--sheet">{tabPanel}</div>
          </MobileSheet>
        )}

        {!compact && (
        <aside className="panel panel--right">
          {/* The properties panel follows the selection rather than the tab:
              selecting an object in the 3D view should show its properties
              wherever the user happens to be. */}
          {atlas && <CollisionPanel stale={false} />}
          {atlas && selectedObject ? (
            <ObjectProperties object={selectedObject} atlas={atlas} profile={profile} />
          ) : (
            <>
              {atlas && <ProfilePanel atlas={atlas} profile={profile} />}
              {atlas && tab === 'PLAN' && (
                <PlanPanel atlas={atlas} profile={profile} target={target} />
              )}
            </>
          )}
        </aside>
        )}
      </div>

      <footer className="notice">
        <strong>Research planning tool.</strong>
        <span>
          Verify coordinates, skull levelling, object dimensions and surgical access
          experimentally before use. CCFv3 is an averaged reference brain; live-animal
          coordinates differ.
        </span>
      </footer>
    </div>
  )
}
