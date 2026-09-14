/**
 * Built-in hardware models.
 *
 * A parametric primitive is the right description of a pipette: the numbers
 * *are* the part. It is the wrong description of a Nikon objective, a bonded
 * microprism or a lab's own headplate — those are physical objects whose
 * shape carries information no parameter list reproduces, and whose clearances
 * are the whole question an optical-access plan asks. A barrel approximated as
 * a cylinder answers "does a 29 mm tube fit"; the real mesh answers "does *this
 * objective* fit", which is different by the width of a knurled collar.
 *
 * So these three ship as meshes. What they do *not* ship as is anonymous
 * imported geometry, because an STL states neither where its functional point
 * is nor which way it is pointing, and those two facts are what BrainCAD places
 * hardware by. Each model therefore declares, alongside the file:
 *
 *  - `fileToLocal`, the rotation carrying the file's axes onto BrainCAD's local
 *    convention (instrument down −Y, functional end at the origin);
 *  - `anchorFile`, the point that must land on the AP/ML/DV target, named in
 *    the file's own coordinates so it can be checked against the CAD;
 *  - why that point and not another.
 *
 * Those declarations are not comments. `builtins.test.ts` loads the real STLs
 * and asserts each anchor sits where this file says it does — that the prism's
 * imaging face ends up on the +Z plane the placement solve expects, that the
 * objective's focal point is exactly one working distance in front of the front
 * element, that the headbar's opening is centred on the origin. A transform
 * that is wrong by a rotation renders a plausible-looking part in a wrong pose,
 * which is precisely the class of error a plan cannot survive.
 */

import { BufferGeometry, Matrix4, Vector3 } from 'three'

import { MM_PER_UNIT, parseGeometry, type SourceUnit } from './import.ts'
import { registerCustomGeometry, type CustomSource, type SceneObject } from './model.ts'
import type { BuiltPrimitive, ObjectKind, PrimitiveParams } from './primitives.ts'

/** URL of a bundled model, honouring the deploy base path. */
export function modelUrl(file: string): string {
  return `${import.meta.env.BASE_URL}models/${file}`.replace(/([^:])\/{2,}/g, '$1/')
}

/**
 * A 3×3 rotation, row-major, mapping file axes onto BrainCAD local axes.
 *
 * Stated as a matrix rather than as Euler angles because the question being
 * answered is "where does the file's +X end up", and a matrix answers it by
 * inspection: each row is one local axis written in file components.
 */
export type Basis3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
]

export interface BuiltinModel {
  readonly id: string
  /** The semantic kind, so optics, collision defaults and the sheet all apply. */
  readonly kind: ObjectKind
  readonly label: string
  readonly hint: string
  /** Filename under `public/models/`. */
  readonly file: string
  readonly unit: SourceUnit
  readonly fileToLocal: Basis3
  /** The point placed on the target, in the file's own coordinates. */
  readonly anchorFile: readonly [number, number, number]
  /** Rotation centre in file coordinates; null means "the anchor". */
  readonly pivotFile: readonly [number, number, number] | null
  /**
   * Parametric spec kept alongside the mesh.
   *
   * Only for the objective, and only because the optical model needs numbers
   * the mesh does not carry: a working distance and a field diameter are
   * properties of the optic and the scan path, not of the solid. The mesh
   * still supplies the geometry — see `resolveGeometry`.
   */
  readonly spec: PrimitiveParams | null
  readonly provenance: string
  /** Facts about this part the user should see before trusting a clearance. */
  readonly caveats: readonly string[]
}

/**
 * Nikon CFI LWD Plan Fluorite 16×W.
 *
 * File frame: optical axis is +X, pointing toward the sample; the front element
 * face is the +X extreme at x = 38.4810, the M-thread shoulder is at the far end.
 * The body is a 28.96 mm barrel with a 35.05 mm collar near the back and a nose
 * tapering to 6.35 mm at the front.
 *
 * The anchor is the focal point, 3.0 mm (the catalogue working distance) in
 * front of the front element, so placing the objective on a target puts its
 * focal plane there — the question optical-access planning actually asks.
 * A cross-check that the file is the objective it claims to be: the catalogue
 * parfocal distance is 75 mm, and the mounting collar in the mesh sits 75.0 mm
 * behind that focal point, to within 0.15 mm.
 */
export const OBJECTIVE_N16XLWD: BuiltinModel = {
  id: 'objective-n16xlwd-pf',
  kind: 'objective',
  label: 'Nikon 16× LWD',
  hint: 'N16XLWD-PF · NA 0.80 · WD 3.0 mm · anchored at the focal point',
  file: 'objective-n16xlwd-pf.stl',
  unit: 'mm',
  // local x = file y, local y = −file x, local z = file z.
  // Carries file +X (toward the sample) onto local −Y (down).
  fileToLocal: [0, 1, 0, -1, 0, 0, 0, 0, 1],
  anchorFile: [41.4809989929, 0, 0],
  pivotFile: null,
  spec: {
    kind: 'objective',
    params: {
      // Catalogue optics. Only these two are read once a mesh is present; the
      // rest describe the parametric stand-in and are kept at the measured
      // values of this part so the two never contradict each other.
      workingDistanceMm: 3.0,
      fieldOfViewMm: 1.0,
      barrelDiameterMm: 28.96,
      frontDiameterMm: 6.35,
      noseLengthMm: 15.0,
      barrelLengthMm: 61.96,
      safetyMarginMm: 0,
    },
  },
  provenance: 'Nikon CFI LWD Plan Fluorite 16×W, NA 0.80, WD 3.0 mm, parfocal 75 mm.',
  caveats: [
    'The mesh is the objective body only. A water-immersion cone, retaining ring or ' +
      'correction-collar grip will occupy more space than this.',
    'Field of view depends on the scan system, not the objective alone — set it to ' +
      'your own measured field.',
  ],
}

/**
 * Right-angle microprism bonded to a #1 coverglass.
 *
 * File frame: the assembly descends along −Z. A 3.0 mm ⌀ × 0.17 mm coverslip
 * caps it at z ∈ [−0.17, 0]; below sits the glass, whose 45° hypotenuse runs
 * from (1.7843, −1.0) to (0.2843, −2.5) in XZ and turns the light path through
 * a right angle. The 1.5 mm square imaging aperture is therefore the −X face
 * over z ∈ [−2.5, −1.0], and the tip is at z = −2.5.
 *
 * The anchor is the centre of that aperture, not the centre of the glass: the
 * meaningful coordinate is the tissue the prism images — a cortical layer, a
 * hippocampal stratum — which is what the aperture faces. The transform lands
 * the aperture on the local +Z plane, matching `prismImagingFace()`, so roll
 * aims a built-in prism exactly as it aims a parametric one.
 */
export const MICROPRISM: BuiltinModel = {
  id: 'microprism-1500',
  kind: 'prism',
  label: 'Microprism + coverslip',
  hint: '1.5 mm right-angle prism on a 3 mm coverglass · anchored on the imaging face',
  file: 'microprism.stl',
  unit: 'mm',
  // local x = −file y, local y = file z, local z = −file x.
  // Carries file −Z (the insertion direction) onto local −Y, and the imaging
  // face normal, file −X, onto local +Z.
  fileToLocal: [0, -1, 0, 0, 0, 1, -1, 0, 0],
  anchorFile: [0.2843387127, 0, -1.75],
  pivotFile: null,
  spec: null,
  provenance:
    'Bonded assembly: 1.5 mm right-angle microprism, 3.0 mm ⌀ × 0.17 mm coverglass.',
  caveats: [
    'Dimensions are the design geometry, not a measurement of the prism in your hand; ' +
      'bonded assemblies vary by the thickness of the adhesive layer.',
    'The imaging aperture is the 1.5 mm face; the coverslip overhangs it and is what ' +
      'will contact the skull.',
  ],
}

/**
 * Headplate with an 8 mm opening and two clamp arms.
 *
 * File frame: a 1.0 mm plate lying in XZ, top face at y = 0 and skull-contact
 * face at y = −1, so the file's +Y is already BrainCAD's dorsal and no rotation
 * is needed. The opening is 8.000 mm ⌀ centred at (40.539, −24.446); the arms
 * carry 1.40 mm ⌀ holes 15.80 mm apart.
 *
 * The anchor is the centre of the opening *on the skull-contact face*, so
 * placing the headbar at a coordinate centres the craniotomy on it and rests
 * the plate at that DV.
 */
export const HEADBAR: BuiltinModel = {
  id: 'headbar-8mm',
  kind: 'headbar',
  label: 'Headbar',
  hint: '8 mm opening, 1 mm plate · anchored at the opening, on the skull face',
  file: 'headbar.stl',
  unit: 'mm',
  fileToLocal: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  anchorFile: [40.5389, -1, -24.4463],
  pivotFile: null,
  spec: null,
  provenance: 'Lab headplate, 8.00 mm opening, 1.00 mm plate, 15.80 mm arm-hole spacing.',
  caveats: [
    'The file carries no anatomical orientation, so its own X and Z are read as ML and ' +
      'AP unchanged: the arms come out anterior to the opening. Roll 180° if your ' +
      'headbar is fitted the other way round.',
    'The plate is modelled flat. A real headplate is bonded to a curved skull through a ' +
      'layer of cement, so contact is not the plane this draws.',
  ],
}

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  MICROPRISM,
  OBJECTIVE_N16XLWD,
  HEADBAR,
]

export function builtinModel(id: string): BuiltinModel | null {
  return BUILTIN_MODELS.find((m) => m.id === id) ?? null
}

/** The rotation, as a three.js matrix. */
export function fileToLocalMatrix(model: BuiltinModel): Matrix4 {
  const [a, b, c, d, e, f, g, h, i] = model.fileToLocal
  // `set` takes arguments row-wise, which is how `fileToLocal` is written.
  return new Matrix4().set(a, b, c, 0, d, e, f, 0, g, h, i, 0, 0, 0, 0, 1)
}

/**
 * Place parsed file geometry into BrainCAD's local millimetre frame.
 *
 * Separated from the fetch so it can be tested against the real STLs in Node,
 * where there is no network and no WebGL.
 */
export function toLocalFrame(model: BuiltinModel, fileGeometry: BufferGeometry): BuiltPrimitive {
  const scale = MM_PER_UNIT[model.unit]
  const rotation = fileToLocalMatrix(model)

  const anchorLocal = new Vector3(...model.anchorFile)
    .multiplyScalar(scale)
    .applyMatrix4(rotation)

  const geometry = fileGeometry.clone()
  geometry.scale(scale, scale, scale)
  geometry.applyMatrix4(rotation)
  geometry.translate(-anchorLocal.x, -anchorLocal.y, -anchorLocal.z)
  geometry.computeBoundingBox()
  geometry.computeVertexNormals()

  const pivot = model.pivotFile
    ? new Vector3(...model.pivotFile)
        .multiplyScalar(scale)
        .applyMatrix4(rotation)
        .sub(anchorLocal)
    : new Vector3(0, 0, 0)

  // How far the part reaches back along its axis from the anchor — the "far
  // end" the properties panel reports and the length the axis line is drawn
  // at. Measured from the mesh rather than declared, so it cannot disagree
  // with the geometry.
  const lengthMm = Math.max(0, geometry.boundingBox?.max.y ?? 0)

  return {
    geometry,
    pivot,
    anchor: new Vector3(0, 0, 0),
    axis: new Vector3(0, -1, 0),
    lengthMm,
  }
}

/**
 * Downloaded model files, keyed by id.
 *
 * The bytes are cached, not the geometry: every placed instance needs its own
 * BufferGeometry, because the geometry registry disposes what it holds when an
 * object is deleted and a shared buffer would take every other instance with
 * it. Re-parsing an STL costs microseconds; re-downloading 600 kB does not.
 */
const fileCache = new Map<string, Promise<ArrayBuffer>>()

async function modelBytes(model: BuiltinModel, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cached = fileCache.get(model.id)
  if (cached) return cached

  const pending = (async () => {
    const url = modelUrl(model.file)
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`Failed to load ${model.label}: HTTP ${response.status}`)
    return response.arrayBuffer()
  })()

  // A failed fetch must not be cached, or a transient network error would
  // make the model permanently unavailable for the rest of the session.
  pending.catch(() => fileCache.delete(model.id))
  fileCache.set(model.id, pending)
  return pending
}

/** Fetch, parse and place a built-in model, ready to register as geometry. */
export async function loadBuiltinModel(
  model: BuiltinModel,
  signal?: AbortSignal,
): Promise<{ built: BuiltPrimitive; triangleCount: number }> {
  const bytes = await modelBytes(model, signal)
  // The STL loader only reads the buffer, so the cached bytes stay reusable
  // across every instance placed from this model.
  const parsed = parseGeometry(bytes, 'stl')
  const built = toLocalFrame(model, parsed.geometry)
  parsed.geometry.dispose()
  return { built, triangleCount: parsed.triangleCount }
}

/**
 * A fresh copy of a model's spec.
 *
 * Copied so that editing a placed objective's field of view cannot reach back
 * into the shared model constant and change it for every future instance.
 * Written as a switch rather than a spread so the discriminated union
 * survives; a spread widens `kind` and loses the pairing with `params`.
 */
export function builtinSpec(model: BuiltinModel): PrimitiveParams | null {
  const spec = model.spec
  if (!spec) return null
  switch (spec.kind) {
    case 'pipette':
      return { kind: 'pipette', params: { ...spec.params } }
    case 'cannula':
      return { kind: 'cannula', params: { ...spec.params } }
    case 'prism':
      return { kind: 'prism', params: { ...spec.params } }
    case 'objective':
      return { kind: 'objective', params: { ...spec.params } }
  }
}

/** Provenance record written into the project file for a placed built-in. */
export function builtinSource(model: BuiltinModel, triangleCount: number): CustomSource {
  return {
    filename: model.file,
    format: 'stl',
    unit: model.unit,
    scale: 1,
    // The model's own transform has already placed the origin; the import
    // pipeline's origin modes do not apply and must not be re-run.
    origin: 'file',
    triangleCount,
    builtinId: model.id,
  }
}

export interface HydrationResult {
  readonly restored: number
  /** Names of objects whose built-in model could not be restored, with why. */
  readonly failures: readonly string[]
}

/**
 * Re-attach geometry to every object that came from a built-in model.
 *
 * Called after opening a project. An imported STL cannot be recovered this way
 * — the file is on the user's disk — but a built-in ships with the app, so a
 * reopened plan gets its real hardware back rather than a gap and a warning.
 */
export async function hydrateBuiltinGeometry(
  objects: readonly SceneObject[],
): Promise<HydrationResult> {
  const wanted = objects.filter((o) => o.source?.builtinId)
  let restored = 0
  const failures: string[] = []

  await Promise.all(
    wanted.map(async (object) => {
      const model = builtinModel(object.source!.builtinId!)
      if (!model) {
        failures.push(
          `"${object.name}" uses model "${object.source!.builtinId}", which this build ` +
            `does not have.`,
        )
        return
      }
      try {
        const { built } = await loadBuiltinModel(model)
        registerCustomGeometry(object.id, built)
        restored += 1
      } catch (error) {
        failures.push(
          `"${object.name}" (${model.label}): ` +
            (error instanceof Error ? error.message : String(error)),
        )
      }
    }),
  )

  return { restored, failures }
}
