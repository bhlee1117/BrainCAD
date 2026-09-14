/**
 * The surgical planning sheet (blueprint §6, EXPORT).
 *
 * Produced as a self-contained HTML document rather than a PDF: it opens in
 * any browser, prints to PDF from there, and — crucially — can be read years
 * later without BrainCAD. A plan that outlives the software that made it is
 * worth more than one that does not.
 *
 * The sheet leads with provenance and caveats rather than burying them, because
 * the numbers on it are derived from an averaged atlas and someone reading it
 * at a rig needs to know that before they read the coordinates.
 */

import { formatClearance, type SceneCollisionReport } from '../collision/check.ts'
import {
  DISTANCE_LABEL,
  measurementComponents,
  measurementDistanceMm,
  type Measurement,
} from '../measure/measure.ts'
import { angleFromVerticalDeg } from '../objects/placement.ts'
import { KIND_LABEL, type SceneObject } from '../objects/model.ts'
import type { ProjectFile } from './schema.ts'

export interface SheetInput {
  readonly project: ProjectFile
  readonly objects: readonly SceneObject[]
  readonly measurements: readonly Measurement[]
  readonly collision: SceneCollisionReport | null
  /** Data URL of a 3D view capture, when one was taken. */
  readonly screenshot: string | null
  /** Simulated views down each objective's own axis. */
  readonly objectiveViews: readonly {
    readonly name: string
    readonly dataUrl: string
    readonly fieldOfViewMm: number
    readonly workingDistanceMm: number
  }[]
  /** Data overlays shown with the plan. */
  readonly overlays: readonly {
    readonly name: string
    readonly experimentId: number
    readonly threshold: number
    readonly pointCount: number
    readonly evidence: string
    readonly citation: string
    readonly url: string | null
    readonly resolutionUm: number
    readonly caveats: readonly string[]
  }[]
  /** Region acronym at each target, keyed by target id. */
  readonly targetRegions: Readonly<Record<string, string>>
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const fmt = (v: number, digits = 2) => (v >= 0 ? '+' : '') + v.toFixed(digits)

function targetRows(input: SheetInput): string {
  if (input.project.targets.length === 0) {
    return '<tr><td colspan="5" class="empty">No targets defined.</td></tr>'
  }
  return input.project.targets
    .map(
      (t) => `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td class="n">${fmt(t.coord.ap)}</td>
        <td class="n">${fmt(t.coord.ml)}</td>
        <td class="n">${fmt(t.coord.dv)}</td>
        <td>${escapeHtml(input.targetRegions[t.id] ?? '—')}</td>
      </tr>`,
    )
    .join('')
}

function objectRows(input: SheetInput): string {
  if (input.objects.length === 0) {
    return '<tr><td colspan="7" class="empty">No objects placed.</td></tr>'
  }
  return input.objects
    .map((o) => {
      const obliquity = angleFromVerticalDeg(o.orientation)
      return `<tr>
        <td>${escapeHtml(o.name)}</td>
        <td>${escapeHtml(KIND_LABEL[o.kind])}</td>
        <td class="n">${fmt(o.target.ap)}</td>
        <td class="n">${fmt(o.target.ml)}</td>
        <td class="n">${fmt(o.target.dv)}</td>
        <td class="n">${fmt(o.orientation.apTiltDeg, 1)} / ${fmt(o.orientation.mlTiltDeg, 1)} / ${fmt(o.orientation.rollDeg, 1)}</td>
        <td class="n">${obliquity.toFixed(1)}°</td>
      </tr>`
    })
    .join('')
}

function dimensionRows(input: SheetInput): string {
  const withSpecs = input.objects.filter((o) => o.spec)
  if (withSpecs.length === 0) return ''

  const rows = withSpecs
    .map((o) => {
      const params = Object.entries(o.spec!.params as unknown as Record<string, number>)
        .map(([key, value]) => `${escapeHtml(key.replace(/Mm$/, ''))} ${value}`)
        .join(', ')
      return `<tr><td>${escapeHtml(o.name)}</td><td>${escapeHtml(params)}</td></tr>`
    })
    .join('')

  return `<h2>Object dimensions <span class="unit">(mm)</span></h2>
    <table><thead><tr><th>Object</th><th>Parameters</th></tr></thead><tbody>${rows}</tbody></table>`
}

function collisionSection(input: SheetInput): string {
  const report = input.collision
  if (!report) {
    return `<div class="callout callout--unknown">
      Collision checking was not run for this plan. That is not a statement that the plan is clear.
    </div>`
  }

  const worstLabel =
    report.worst === 'safe'
      ? 'No collisions detected'
      : report.worst === 'near'
        ? 'Clearance below the configured threshold'
        : report.worst === 'collision'
          ? 'COLLISION DETECTED'
          : 'Some pairs could not be evaluated'

  const rows = report.pairs
    .filter((p) => p.state !== 'safe' || p.clearanceMm !== null)
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.aLabel)} ↔ ${escapeHtml(p.bLabel)}</td>
        <td>${p.state}</td>
        <td class="n">${formatClearance(p.clearanceMm)}</td>
      </tr>`,
    )
    .join('')

  return `<div class="callout callout--${report.worst}"><strong>${worstLabel}.</strong>
      ${report.limiting ? `Limiting pair: ${escapeHtml(report.limiting.aLabel)} ↔ ${escapeHtml(report.limiting.bLabel)} at ${formatClearance(report.limiting.clearanceMm)}.` : ''}
      Checked ${report.checkedPairs} pair(s) at a ${input.project.collisionSettings.warnClearanceMm} mm warning threshold.
    </div>
    ${rows ? `<table><thead><tr><th>Pair</th><th>State</th><th>Clearance</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`
}

function measurementRows(input: SheetInput): string {
  if (input.measurements.length === 0) {
    return '<tr><td colspan="6" class="empty">No measurements saved.</td></tr>'
  }
  return input.measurements
    .map((m) => {
      const d = measurementDistanceMm(m)
      const c = measurementComponents(m)
      return `<tr>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.a.snappedTo ?? 'free point')} → ${escapeHtml(m.b.snappedTo ?? 'free point')}</td>
        <td>${escapeHtml(DISTANCE_LABEL[m.kind])}</td>
        <td class="n">${d.toFixed(3)}</td>
        <td class="n">${Math.round(d * 1000)}</td>
        <td class="n">${fmt(c.ap, 2)} / ${fmt(c.ml, 2)} / ${fmt(c.dv, 2)}</td>
      </tr>`
    })
    .join('')
}

/**
 * Simulated views down each objective's optical axis.
 *
 * Captioned with the caveat it needs: this shows *geometric occlusion* — what
 * physically blocks the light path — and is not an optical simulation. It says
 * nothing about scattering, aberration or depth of field.
 */
function objectiveViewSection(input: SheetInput): string {
  if (input.objectiveViews.length === 0) return ''

  const figures = input.objectiveViews
    .map(
      (view) => `<figure class="objview">
        <img src="${view.dataUrl}" alt="Simulated view through ${escapeHtml(view.name)}">
        <figcaption>
          <strong>${escapeHtml(view.name)}</strong><br>
          ${view.fieldOfViewMm.toFixed(2)} mm field · ${view.workingDistanceMm.toFixed(1)} mm working distance
        </figcaption>
      </figure>`,
    )
    .join('')

  return `<h2>View through the objective</h2>
    <div class="objviews">${figures}</div>
    <p class="caveat">
      Geometric occlusion only — what physically blocks the light path, rendered orthographically
      down the optical axis from the front element. Not an optical simulation: it does not model
      scattering, aberration, depth of field or the effect of any intervening optic.
    </p>`
}

/**
 * Overlay provenance.
 *
 * Given its own section, above the scene capture, because a reader looking at a
 * spray of projection points over a target needs to know before anything else
 * that it is one animal's measurement and not a prediction for theirs.
 */
function overlaySection(input: SheetInput): string {
  if (input.overlays.length === 0) return ''

  const blocks = input.overlays
    .map(
      (overlay) => `<div class="overlay">
        <strong>${escapeHtml(overlay.name)}</strong>
        <span class="evidence">${escapeHtml(overlay.evidence)}</span>
        <div class="overlay__meta">${overlay.pointCount.toLocaleString()} points above density ${overlay.threshold.toFixed(2)} · ${overlay.resolutionUm} µm grid</div>
        <div class="overlay__cite">${escapeHtml(overlay.citation)}${
          overlay.url ? ` — ${escapeHtml(overlay.url)}` : ''
        }</div>
        <ul>${overlay.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
      </div>`,
    )
    .join('')

  return `<h2>Data overlays</h2>${blocks}`
}

/** Render the planning sheet as a standalone HTML document. */
export function renderPlanningSheet(input: SheetInput): string {
  const { project } = input
  const profile = project.coordinateProfile

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.metadata.name)} — BrainCAD planning sheet</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 13px/1.55 ui-sans-serif, -apple-system, system-ui, sans-serif;
    color: #16202b; background: #fff; max-width: 900px;
  }
  h1 { font-size: 24px; margin: 0 0 2px; letter-spacing: -0.02em; }
  .sub { color: #5d6b7a; margin: 0 0 20px; }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em;
    color: #5d6b7a; margin: 26px 0 7px; border-bottom: 1px solid #dfe5ea; padding-bottom: 5px;
  }
  h2 .unit { text-transform: none; letter-spacing: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eef2f5; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: #5d6b7a; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, Menlo, monospace; }
  td.empty { color: #8b97a6; font-style: italic; }
  .meta { display: grid; grid-template-columns: 150px 1fr; gap: 3px 14px; }
  .meta dt { color: #5d6b7a; }
  .meta dd { margin: 0; }
  .callout { padding: 10px 13px; border-radius: 6px; margin: 10px 0; border: 1px solid; }
  .callout--safe { background: #eef8f1; border-color: #9ed4b3; }
  .callout--near { background: #fdf5e3; border-color: #e3c884; }
  .callout--collision { background: #fdecea; border-color: #e4a49c; }
  .callout--unknown { background: #f1f3f5; border-color: #cfd6dd; }
  .notice {
    border: 2px solid #c0392b; background: #fdecea; color: #8c2a1e;
    padding: 12px 15px; border-radius: 6px; margin: 0 0 22px;
  }
  .caveats { margin: 6px 0 0; padding-left: 18px; color: #5d6b7a; font-size: 12px; }
  img.capture { width: 100%; border: 1px solid #dfe5ea; border-radius: 6px; margin-top: 8px; }
  .objviews { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 8px; }
  .objview { margin: 0; width: 220px; }
  .objview img { width: 220px; height: 220px; border-radius: 50%; background: #000; display: block; }
  .objview figcaption { font-size: 11px; color: #5d6b7a; margin-top: 6px; line-height: 1.4; }
  .caveat { font-size: 11px; color: #5d6b7a; margin-top: 10px; }
  .overlay { border-left: 3px solid #c0392b; background: #fdf3f1; padding: 10px 13px; border-radius: 0 6px 6px 0; margin-bottom: 10px; }
  .overlay .evidence { display: inline-block; margin-left: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; background: #e8eef3; color: #33424f; padding: 1px 7px; border-radius: 100px; }
  .overlay__meta { font-size: 11px; color: #5d6b7a; margin-top: 3px; }
  .overlay__cite { font-size: 11px; margin-top: 5px; }
  .overlay ul { margin: 6px 0 0; padding-left: 18px; font-size: 11px; color: #5d6b7a; }
  footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #dfe5ea; color: #8b97a6; font-size: 11px; }
  @media print { body { padding: 0; } .callout, .notice { break-inside: avoid; } }
</style>
</head>
<body>

<h1>${escapeHtml(project.metadata.name)}</h1>
<p class="sub">BrainCAD surgical planning sheet · generated ${escapeHtml(project.metadata.modified)}</p>

<div class="notice">
  <strong>Research planning tool.</strong> Verify coordinates, skull levelling, object dimensions
  and surgical access experimentally before use. CCFv3 is an averaged reference brain and
  live-animal coordinates differ. A collision-free plan is not a guarantee of surgical success.
</div>

${project.metadata.notes ? `<h2>Notes</h2><p>${escapeHtml(project.metadata.notes)}</p>` : ''}

<h2>Coordinate frame</h2>
<dl class="meta">
  <dt>Profile</dt><dd>${escapeHtml(profile.label)} <em>(${escapeHtml(profile.confidence)})</em></dd>
  <dt>Bregma (voxels)</dt><dd>${profile.bregma.i0}, ${profile.bregma.i1}, ${profile.bregma.i2}</dd>
  <dt>Volume</dt><dd>${profile.spaceShape.join(' × ')} at ${profile.resolutionUm} µm</dd>
  <dt>DV referenced to</dt><dd>${escapeHtml(profile.dvReference.replace('-', ' '))}</dd>
  <dt>Atlas</dt><dd>${escapeHtml(project.atlas.citation)}</dd>
  <dt>Source</dt><dd>${escapeHtml(profile.citation)}</dd>
</dl>

<h2>Targets <span class="unit">(mm relative to bregma)</span></h2>
<table>
  <thead><tr><th>Name</th><th>AP</th><th>ML</th><th>DV</th><th>Region</th></tr></thead>
  <tbody>${targetRows(input)}</tbody>
</table>

<h2>Objects</h2>
<table>
  <thead><tr>
    <th>Name</th><th>Type</th><th>AP</th><th>ML</th><th>DV</th>
    <th>AP/ML/Roll tilt</th><th>Off vertical</th>
  </tr></thead>
  <tbody>${objectRows(input)}</tbody>
</table>

${dimensionRows(input)}

<h2>Collision and clearance</h2>
${collisionSection(input)}

<h2>Measurements</h2>
<table>
  <thead><tr>
    <th>Name</th><th>From → to</th><th>Kind</th><th>mm</th><th>µm</th><th>ΔAP / ΔML / ΔDV</th>
  </tr></thead>
  <tbody>${measurementRows(input)}</tbody>
</table>

${overlaySection(input)}

${objectiveViewSection(input)}

${input.screenshot ? `<h2>Scene</h2><img class="capture" src="${input.screenshot}" alt="3D scene capture">` : ''}

<footer>
  ${escapeHtml(project.metadata.software)} · format ${project.version} ·
  created ${escapeHtml(project.metadata.created)}
</footer>

</body>
</html>`
}

/** Suggested filename for a planning sheet. */
export function sheetFilename(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'plan'
  return `${slug}-planning-sheet.html`
}
