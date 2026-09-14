/**
 * BrainCAD application shell.
 *
 * Tabs follow the blueprint's mode structure (§6). PLAN and ATLAS are live at
 * M1; the rest are present but disabled so the intended shape of the tool is
 * visible without pretending the features exist.
 */

import { useEffect, useState } from 'react'

import { loadAtlas } from './atlas/load.ts'
import { assertProfileMatchesSpace } from './atlas/profile.ts'
import { Viewport } from './scene/Viewport.tsx'
import {
  useAppStore,
  useAtlas,
  useProfile,
  useSelectedObject,
  useSelectedTarget,
} from './state/store.ts'
import { CollisionPanel } from './ui/CollisionPanel.tsx'
import { ExportPanel } from './ui/ExportPanel.tsx'
import { MeasurePanel } from './ui/MeasurePanel.tsx'
import { OpticsPanel } from './ui/OpticsPanel.tsx'
import { ObjectProperties } from './ui/ObjectProperties.tsx'
import { ObjectsPanel } from './ui/ObjectsPanel.tsx'
import { PlanPanel } from './ui/PlanPanel.tsx'
import { AtlasPanel, ProfilePanel, ScenePanel } from './ui/SidePanels.tsx'
import { SlicePanel } from './ui/SlicePanel.tsx'

type Tab = 'PLAN' | 'OBJECTS' | 'ATLAS' | 'MEASURE' | 'OPTICS' | 'EXPORT'

const TABS: readonly { id: Tab; enabled: boolean; title: string }[] = [
  { id: 'PLAN', enabled: true, title: 'Target and trajectory planning' },
  { id: 'OBJECTS', enabled: true, title: 'Hardware primitives and custom geometry' },
  { id: 'ATLAS', enabled: true, title: 'Atlas browsing and region meshes' },
  { id: 'MEASURE', enabled: true, title: 'Two-point distance measurement' },
  { id: 'OPTICS', enabled: true, title: 'Objective approach-angle sweep' },
  { id: 'EXPORT', enabled: true, title: 'Project file and planning sheet' },
]

export function App() {
  const [tab, setTab] = useState<Tab>('PLAN')
  const atlas = useAtlas()
  const profile = useProfile()
  const target = useSelectedTarget()
  const selectedObject = useSelectedObject()
  const atlasStatus = useAppStore((s) => s.atlasStatus)
  const setAtlasStatus = useAppStore((s) => s.setAtlasStatus)

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          BrainCAD<span>3D stereotaxic planning</span>
        </div>
        <nav className="tabs">
          {TABS.map((entry) => (
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

      <div className="main">
        <aside className="panel panel--left">
          {atlas && tab === 'ATLAS' ? (
            <AtlasPanel atlas={atlas} />
          ) : tab === 'OBJECTS' ? (
            <ObjectsPanel />
          ) : tab === 'MEASURE' ? (
            <MeasurePanel />
          ) : tab === 'OPTICS' ? (
            <OpticsPanel />
          ) : tab === 'EXPORT' && atlas ? (
            <ExportPanel atlas={atlas} profile={profile} />
          ) : (
            <ScenePanel />
          )}
        </aside>

        <div style={{ display: 'grid', gridTemplateRows: '1fr auto', minWidth: 0 }}>
          <div style={{ position: 'relative', minHeight: 0 }}>
            {atlas ? (
              <Viewport atlas={atlas} profile={profile} />
            ) : (
              <div className="viewport" />
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

          {atlas && target && (
            <SlicePanel atlas={atlas} profile={profile} coord={target.coord} />
          )}
        </div>

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
