# BrainCAD

**3D stereotaxic planning for injections, implants, and optical access.**

> Put the atlas and the experimental rig into the same 3D space.

**Live: https://bhlee1117.github.io/BrainCAD/**

A browser-based planning workspace for mouse neuroscience experiments. BrainCAD
places the mouse brain atlas, stereotaxic targets, pipettes, cannulas, prisms,
objectives and custom hardware into one manipulable 3D scene, so you can answer:
*can I reach this location with this object, at this angle, without colliding
with anything?*

> **BrainCAD is a research planning tool.** Verify coordinates, skull levelling,
> object dimensions and surgical access experimentally before use. CCFv3 is an
> averaged reference brain; live-animal coordinates differ.

---

## Status

| Milestone | Scope | State |
|---|---|---|
| **M0** | Asset pipeline, coordinate core, landmark validation | ✅ done |
| **M1** | Atlas viewer, AP/ML/DV entry, region lookup, slice views | ✅ done |
| **M2** | Primitives, STL/OBJ/GLB import, pivot/anchor, gizmos | ✅ done |
| **M3** | Mesh collision, clearance, two-point measurement | ✅ done |
| **M4** | Project save/load, planning-sheet export, angle sweep | ✅ done |
| **M5** | Mobile bottom-sheet layout, polish | ✅ done |
| **+** | Objective view render, axon projection overlays | ✅ done |
| **+** | Built-in hardware models, section planes, viewport capture | ✅ done |

## Quick start

```bash
npm install
npm run atlas:fetch   # one-time: downloads and processes atlas assets (~10 MB out)
npm run dev
```

Then open the URL Vite prints. `npm test` runs the validation suite;
`npm run build` produces a static bundle deployable to GitHub Pages.

## Architecture

BrainCAD is a **fully static site — no backend.** All atlas assets are fetched
from `public/atlas/`, so nothing leaves the browser and deployment is a file
copy.

```
scripts/fetch-atlas.mjs   Build-time: download → decimate → public/atlas/
src/atlas/                Coordinate system, volume, ontology, loaders
src/scene/                three.js world transform and 3D viewport
src/ui/                   Panels and slice views
src/state/                Application store (mirrors the project data model)
```

### The annotation volume does the heavy lifting

`annotation_50.nrrd` is **880 KB** and carries a structure id for every voxel of
the mouse brain at 50 µm. That single file answers region lookup at a target,
all three orthogonal slice views, the list of structures a trajectory crosses,
and brain-surface entry detection — with no additional geometry.

### Coordinate profiles are cited data, never constants

Nothing in BrainCAD hard-codes a bregma position or an atlas-to-stereotaxic
scaling factor. Published values disagree, and every lab has its own
calibration. Each `CoordinateProfile` carries a citation, a confidence level
(`published` / `community-convention` / `user-calibrated`) and explicit caveats,
all surfaced in the UI and stored in the project file.

Two profiles ship today:

- **Allen CCFv3 (50 µm)** — the default, matching the bundled annotation volume.
  Its bregma placement is a *community convention*, not an Allen definition, and
  is labelled as such.
- **Perens 2023 stereotaxic MRI (25 µm)** — landmark positions from
  [Perens et al. 2023](https://doi.org/10.1007/s12021-023-09623-9), measured from
  12 micro-CT-imaged skulls. Better provenance, but it describes a *different*
  template volume, which is not yet bundled.

A profile is only valid for the volume it describes. Pairing the Perens bregma
with the Allen volume would produce coordinates that look entirely plausible and
are wrong by millimetres, so `assertProfileMatchesSpace` refuses the
combination outright rather than trusting convention.

### Validation

`src/atlas/real-atlas.test.ts` runs against the actual downloaded atlas and
asserts that published stereotaxic coordinates land in the structures they are
published for — dorsal CA1 in the hippocampal formation, dorsal striatum in the
caudoputamen, VTA in the midbrain, barrel cortex layers appearing in
superficial-to-deep order. Self-consistency tests cannot catch an axis swap or a
sign flip; these can, and did:

- The NRRD layout is **first-axis-fastest**, not C order. Read as C order the
  data does not error — it silently scrambles anatomy. Caught because olfactory
  bulb voxels appeared spread across the whole volume instead of at the anterior
  pole.
- Allen structure ids are sparse and reach **614,454,277**, so a colour table
  indexed by id would need 2.4 GB. Caught only on real data; the unit-test
  fixture's ids were all small.

### Pivot and anchor are a scene-graph shape, not a maths library

Every object declares two points in its own local space: the **pivot** it
rotates about, and the **anchor** that must land on the chosen AP/ML/DV target.
They are frequently different — a cannula rotates about its collar but is
specified by its tip; a prism is specified by its imaging face, not the centre
of the glass. Keeping them separate reduces placement to one line:

```
t = target − pivot − R·(anchor − pivot)
```

With no rotation this collapses to `target − anchor`; when pivot and anchor
coincide it becomes rotation about the target itself. Both are asserted in the
tests, along with the defining property: whatever the pivot and whatever the
rotation, the anchor lands exactly on the target.

The 3D gizmo and the numeric fields are two views of that same state. Dragging
hands back a quaternion, which `quaternionToOrientation` converts into the AP
tilt / ML tilt / roll a manipulator actually speaks — round-tripped in tests, so
dragging and typing can never disagree.

### Collision: the box test prunes, it does not measure

Clearance runs on `three-mesh-bvh`: `intersectsGeometry` for the boolean,
`closestPointToGeometry` for the separation. A bounding-box test rejects distant
pairs first — but a box encloses its mesh, so the box gap *under-estimates* true
surface clearance. Reporting it as the clearance would put a quietly wrong
number in front of the user, so pairs beyond the exact-query window report a
labelled lower bound (`> 5 mm`) and close pairs are always measured properly.

Attaching `boundsTree` to both operands and passing `maxThreshold` took a
representative query from **1109 ms to 78 ms**; a loose perf test guards it,
because this runs during a drag.

Two behaviours are pinned by tests rather than left implicit:

- **Containment is not intersection.** An object floating entirely inside a
  closed mesh, touching nothing, reads as clear. That is correct for anatomy
  checks — an implant *enters* through the surface — but would matter for a
  fully-enclosed exclusion volume.
- **Anatomy is not a collision partner.** Clearance is checked object against
  object only. The atlas is an averaged reference brain, not the skull in front
  of you, so a hit against its surface is not evidence at the sub-millimetre
  scale the rest of the report works at — and left on, the one object that was
  always going to touch tissue keeps the whole report red and buries the pairs
  that matter. It survives as a per-object opt-in, because an exclusion volume
  drawn as an atlas structure is a legitimate thing to check against.

### Axon projection overlays

Connectivity data loads straight from the Allen Mouse Brain Connectivity Atlas
with no proxy: both the query endpoint and the grid download serve HTTPS with
`Access-Control-Allow-Origin: *`, so BrainCAD stays a static site.

It needs no registration step at all. A projection-density volume is NRRD at
100 µm with shape 132 × 80 × 114 — `13.2 × 8.0 × 11.4 mm`, *identical* to the
annotation volume's extent at exactly half the linear resolution. The same
parser, coordinate profile and world transform apply unchanged.

Thresholded voxels become a point cloud (one draw call, per-vertex colour on a
single-hue density ramp). Three choices worth noting:

- **Capping keeps the densest voxels, never a random subsample** — thinning
  uniformly would erase a faint tract while barely touching a dense one.
- **Points sit at voxel centres**, because a corner is 50 µm off the tissue it
  represents.
- **The threshold is always displayed**, since absence of points means "below
  the cut", not "no projection".

`src/overlays/real-projection.test.ts` validates against a committed real volume:
it maps the densest projection voxel back through the coordinate profile and
asserts the annotation volume reports grey matter there. A cloud registered half
a millimetre off would still look like a plausible spray of axons.

Per blueprint §13, every overlay carries evidence class, citation, source link,
registration space and resolution — and those travel into the planning sheet.
Connectivity data is *measured*, but measured from one injection in one animal;
it is not a prediction for yours, and the interface keeps saying so.

### Built-in hardware models

Three parts ship as meshes in `public/models/` — a Nikon CFI LWD Plan Fluorite
16×W, a 1.5 mm right-angle microprism bonded to a 3 mm coverglass, and an 8 mm
headplate. A parametric primitive is the right description of a pipette, where
the numbers *are* the part. It is the wrong description of these, where the
clearance being asked about is the width of a knurled collar or the overhang of
a coverslip.

Geometry is therefore orthogonal to kind: a mesh registered for an object wins
over its spec, so a bundled objective is still an `objective` — it still gets an
objective view, still carries a working distance into the planning sheet — while
drawing the real barrel. Only the *shape* comes from the file.

An STL states neither where its functional point is nor which way it points, and
those are exactly the two facts BrainCAD places hardware by. So each model
declares, next to the file, the rotation onto the local convention and the
anchor in the file's own coordinates, with the reason for that anchor and not
another:

| Part | Anchor | Because |
|---|---|---|
| Objective | Focal point, 3.0 mm in front of the front element | Placing it on a target puts the focal plane there |
| Microprism | Centre of the 1.5 mm imaging aperture | The meaningful coordinate is the tissue it images |
| Headbar | Centre of the 8 mm opening, on the skull-contact face | Placing it centres the craniotomy and rests the plate at that DV |

`builtins.test.ts` loads the real STLs and checks every one of those claims
against the geometry: the prism's aperture straddles the anchor evenly (found
via the 45° hypotenuse, which is what decides where the aperture starts and
stops), the headbar's bore is 4.000 mm from the origin all the way round, the
objective's front element is exactly one working distance up. It also checks
something the file could not state: the objective's mounting collar sits 75 mm
behind the anchor, the catalogue parfocal distance, which is independent
evidence that the anchor is the focus and not the tip.

This matters more than dimensional checks on a builder. A wrong dimension shows
up as a visibly wrong shape. A wrong *rotation* renders the correct part,
convincingly, ninety degrees from the truth — and every clearance measured
against it is confidently wrong.

Placed built-ins record their model id in the project file, so reopening a plan
restores the real geometry rather than the "re-import your STL" warning a
user-supplied file still gets.

### Section planes and captures

A 3D view of a plan is mostly occlusion, and turning down opacity trades one
unreadable image for another. Three clipping planes — one per stereotaxic axis,
each naming the half it removes in anatomical words rather than as a sign —
cut the scene open the way a drawing does. Two things are stated in the UI
rather than left to be discovered: the cut is display only, so collision and
measurement still see the whole solid, and three.js does not cap a clipped
surface, so a sectioned barrel shows its inside wall rather than a filled
cross-section.

The planning sheet's four fixed viewpoints are comparable between plans, which
is why they are fixed — but they cannot show the oblique angle a user spent
minutes finding, at which the prism, the craniotomy and the objective all read
at once. So the current camera can be captured too, at print resolution. It is
rendered offscreen rather than read back from the canvas, because the
interactive context has no `preserveDrawingBuffer` and the drawing buffer is
already cleared by the time a button handler runs. Any active section is written
into the capture's caption, since a sectioned view otherwise looks exactly like
an intact preparation that happens to be transparent.

### Mesh format

Atlas meshes ship as `.msh`, a trivial header + positions + indices container
(see `scripts/fetch-atlas.mjs`). Normals are deliberately omitted — they are
exactly as large as the position data and three.js recomputes them in
milliseconds, so shipping them would double every download. User-supplied
geometry uses standard STL/OBJ/GLB loaders instead.

## Data sources

- Allen Mouse Brain Common Coordinate Framework v3 — Wang et al. (2020),
  *Cell* 181(4):936-953.
- Perens et al. (2023), *Neuroinformatics* 21(2):269-286 —
  skull-derived stereotaxic coordinate system.

## Related tools

[Pinpoint](https://pinpoint.virtualbrainlab.org/) (browser trajectory planning),
[Urchin](https://github.com/VirtualBrainLab/Urchin) (Python-driven Unity
renderer), [brainrender](https://github.com/brainglobe/brainrender) (Python
atlas visualisation), and
[bregma·lambda](https://github.com/matiasandina/bregmalambda). BrainCAD's
distinct aim is the *CAD* half: pivot-aware hardware placement, optical access,
and collision-checked implant geometry.
