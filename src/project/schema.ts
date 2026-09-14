/**
 * The `.braincad.json` project format.
 *
 * A project file is a surgical plan someone may reopen months later, hand to a
 * collaborator, or cite in a methods section. That imposes two requirements
 * beyond "it round-trips":
 *
 *  - **It must be validated on load.** A hand-edited or truncated file must
 *    fail loudly, not load silently with a bregma of `undefined` and place
 *    every target at the origin.
 *  - **It must be versioned from the first release.** A migration path added
 *    later cannot rescue files written before there was a version number.
 */

import { z } from 'zod'

/** Bumped whenever the shape changes in a way older readers cannot handle. */
export const PROJECT_FORMAT_VERSION = 1

const stereotaxic = z.object({
  ap: z.number().finite(),
  ml: z.number().finite(),
  dv: z.number().finite(),
})

const orientation = z.object({
  apTiltDeg: z.number().finite(),
  mlTiltDeg: z.number().finite(),
  rollDeg: z.number().finite(),
})

const target = z.object({
  id: z.string().min(1),
  name: z.string(),
  coord: stereotaxic,
  notes: z.string().default(''),
  visible: z.boolean().default(true),
})

const primitiveParams = z.object({
  kind: z.enum(['pipette', 'cannula', 'prism', 'objective']),
  params: z.record(z.string(), z.number().finite()),
})

const customSource = z.object({
  filename: z.string(),
  format: z.string(),
  unit: z.enum(['mm', 'um', 'cm', 'm', 'in']),
  scale: z.number().finite(),
  origin: z.enum(['file', 'center', 'base']),
  triangleCount: z.number().int().nonnegative(),
  // Absent in files written before built-in models existed; those can only
  // have been user imports, which is exactly what null means.
  builtinId: z.string().nullable().default(null),
})

const sceneObject = z.object({
  id: z.string().min(1),
  kind: z.enum(['pipette', 'cannula', 'prism', 'objective', 'headbar', 'custom']),
  name: z.string(),
  spec: primitiveParams.nullable().default(null),
  source: customSource.nullable().default(null),
  target: stereotaxic,
  orientation,
  pivotMode: z.enum(['default', 'anchor', 'custom']).default('default'),
  pivotCustom: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  color: z.string(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  collision: z.boolean(),
  // Older files predate this flag. They default to off, matching what the
  // app now does everywhere else — anatomy is not a collision partner unless
  // an object is explicitly opted in.
  anatomyCollision: z.boolean().default(false),
  notes: z.string().default(''),
})

const measurePoint = z.object({
  coord: stereotaxic,
  snap: z.enum(['free', 'mesh-surface', 'target', 'object-anchor', 'object-pivot']),
  snappedTo: z.string().nullable(),
})

const measurement = z.object({
  id: z.string().min(1),
  name: z.string(),
  a: measurePoint,
  b: measurePoint,
  kind: z.enum(['euclidean', 'surface', 'along-object', 'along-trajectory']),
  visible: z.boolean().default(true),
})

const collisionSettings = z.object({
  warnClearanceMm: z.number().nonnegative(),
  toleranceMm: z.number().nonnegative(),
  exactQueryWindowMm: z.number().positive(),
})

/**
 * The coordinate profile is stored in full rather than by id alone.
 *
 * Profiles are editable and may be lab-calibrated, so a file that referenced
 * one only by name could silently resolve to different numbers on another
 * machine — the same class of error the template-space guard exists to
 * prevent. Recording the values makes the plan self-describing; `profileId`
 * is kept alongside so a matching built-in can still be recognised.
 */
const coordinateProfileSnapshot = z.object({
  id: z.string(),
  label: z.string(),
  bregma: z.object({
    i0: z.number(),
    i1: z.number(),
    i2: z.number(),
  }),
  spaceShape: z.tuple([z.number(), z.number(), z.number()]),
  resolutionUm: z.number().positive(),
  dvReference: z.enum(['bregma-plane', 'skull-surface', 'pial-surface']),
  citation: z.string(),
  confidence: z.enum(['published', 'community-convention', 'user-calibrated']),
})

export const projectSchema = z.object({
  format: z.literal('braincad'),
  version: z.number().int().positive(),
  metadata: z.object({
    name: z.string(),
    notes: z.string().default(''),
    created: z.string(),
    modified: z.string(),
    software: z.string(),
  }),
  coordinateProfile: coordinateProfileSnapshot,
  atlas: z.object({
    id: z.string(),
    resolutionUm: z.number().positive(),
    orientation: z.string(),
    citation: z.string(),
  }),
  anatomyVisibility: z.object({
    showBrain: z.boolean(),
    brainOpacity: z.number().min(0).max(1),
    visibleStructureIds: z.array(z.number().int()),
  }),
  targets: z.array(target),
  objects: z.array(sceneObject),
  measurements: z.array(measurement),
  collisionSettings,
  cameraState: z
    .object({
      position: z.tuple([z.number(), z.number(), z.number()]),
      target: z.tuple([z.number(), z.number(), z.number()]),
    })
    .nullable()
    .default(null),
})

export type ProjectFile = z.infer<typeof projectSchema>

export interface ParseResult {
  readonly ok: boolean
  readonly project: ProjectFile | null
  readonly errors: readonly string[]
  /** Non-fatal notes the user should still see after a successful load. */
  readonly warnings: readonly string[]
}

/**
 * Parse and validate a project file.
 *
 * Returns errors rather than throwing, because the caller is a file picker and
 * the user needs to be told which field was wrong — not shown a stack trace.
 */
export function parseProject(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      project: null,
      errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    }
  }

  const parsed = projectSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      project: null,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
      warnings: [],
    }
  }

  const warnings: string[] = []
  const project = parsed.data

  if (project.version > PROJECT_FORMAT_VERSION) {
    warnings.push(
      `This file was written by a newer version of BrainCAD (format ${project.version}, ` +
        `this build reads ${PROJECT_FORMAT_VERSION}). Anything it does not recognise has been dropped.`,
    )
  }

  // Imported geometry lives outside the file, so a reopened project cannot
  // rebuild it. Saying so is better than rendering an object that is not there.
  // Built-in models are the exception: they ship with the app, so recording
  // which one was used is enough to restore the mesh exactly.
  const missingGeometry = project.objects.filter(
    (o) => o.kind === 'custom' && !o.source?.builtinId,
  )
  if (missingGeometry.length > 0) {
    warnings.push(
      `${missingGeometry.length} imported object(s) reference files that are not stored in ` +
        `the project (${missingGeometry.map((o) => o.source?.filename ?? o.name).join(', ')}). ` +
        `Re-import them to restore their geometry.`,
    )
  }

  if (project.coordinateProfile.confidence === 'community-convention') {
    warnings.push(
      `Coordinates in this plan use "${project.coordinateProfile.label}", whose bregma ` +
        `placement is a community convention rather than a published measurement.`,
    )
  }

  return { ok: true, project, errors: [], warnings }
}

/** Suggested filename for a project. */
export function projectFilename(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'plan'
  return `${slug}.braincad.json`
}
