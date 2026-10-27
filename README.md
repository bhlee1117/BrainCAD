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
| **+** | Back-trace: what projects to the target, driven from the number pad | ✅ done |
| **+** | Hub map: a second camera-locked brain painted with whole-connectome convergence | ✅ done |

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

### Back-tracing: what projects *to* the target

Every other connectivity view runs forwards — pick a source, see where its
axons go. Planning a recording or a prism asks the opposite question: *this* is
the coordinate I can reach, so what talks to it? The BACKTRACE tab answers it,
and pairs it with six number-pad keys so the target can be walked around while
the answer updates.

       7   8↑D  9↗P          8 dorsal   2 ventral
       4←M  5   6→L          4 medial   6 lateral
       1↙A  2↓V  3           1 anterior 9 posterior

Dorsal and ventral run up and down the pad, anterior and posterior along its
diagonal, so the hand learns the mapping from the key positions. Shift is ×10.
The legend doubles as buttons, because a phone has no number pad.

**Medial and lateral are relative to the midline, not to the sign of ML.** At
ML −1.5, "lateral" is *more* negative. Keys defined as plain ±ML would reverse
their meaning between hemispheres — correct on the right, backwards on the
left — which is the sort of thing noticed only after a plan has been built on
it. Medial travel stops at the midline rather than crossing it.

#### It is anterograde data read backwards, and the UI says so

There is no retrograde dataset at the Allen Institute to query; the corpus is
entirely anterograde. `mouse_connectivity_target_spatial` inverts it — of the
~2500 injections, which deposit signal at this voxel? — and reports their
injection sites. That is a sound way to ask "what projects here" and it differs
from real retrograde tracing in ways that change the reading, so all of them
are on screen: it is limited to where Allen injected, signal is bulk density so
fibres of passage count the same as terminals, and an experiment injected *at*
the target saturates near 1.0.

That last one is not hypothetical. At dorsal CA1 the top row is a CA1 injection
at density 0.9999 — the tracer sitting on the seed, not a projection to it.
Those rows are **flagged, not dropped**, because dropping them would also cost
the target its CA3 input: a CA3 injection large enough to label Schaffer
collaterals spills across the boundary too, and no rule separates the two. The
flag is computed from the sphere-equivalent radius of Allen's reported
injection volume, doubled because injections run long along the pipette track.
The user can see the overlap and judge it; the software cannot.

#### Validated against anatomy, not against itself

The seed point is the part that can be silently wrong: a swapped axis searches
a different part of the brain and returns a well-formed, confident list of the
wrong regions. `real-retrograde.test.ts` runs against a recorded real response
for dorsal CA1 and asserts the seed the app computes is the one the fixture was
fetched with, then that the answer is textbook hippocampal afferents — CA3
(Schaffer collaterals), DG, subiculum, NDB (the septohippocampal input) and
ENTl (the temporoammonic path). The last two are the discriminating check:
they sit nowhere near the hippocampus, so they could only appear together if
the seed is right.

Moving the target re-runs it, and the result follows the anatomy: nudging from
CA1 down to DV −3.35 lands in **PO**, and the sources become **RT** and
**SSp-bfd** — the thalamic reticular nucleus and the barrel field, which is
what projects to posterior thalamus.

#### The number pad became WASD

W and S move the target away and toward you, A and D to the animal's left and
right, Q and E down and up — the pair either side of W, taking the axis WASD
cannot reach, as a 3D editor's fly mode does it. Shift is ×10, and the legend
doubles as buttons for a touch screen.

Bound by `KeyboardEvent.code`, so the mapping follows the key's position rather
than the letter printed on it and survives AZERTY. Left and right are the
animal's, a plain sign on ML: an earlier version made this pair medial/lateral,
measured from the midline, which is more anatomical and is not what A and D mean
to a hand.

#### A second brain, on the same camera

The matrix answers "which structures project here" as a ranked list, which is
the right shape for reading one value and the wrong shape for *where are the
hubs?* A list cannot show that three of the top five sources are neighbours in
one lobe. So the BACKTRACE tab can open a second viewport beside the first,
locked to the same camera — orbit either and both turn — showing the same brain
painted with retrograde strength, with the target marked in both.

**It paints the section views by default, not a second brain.** The strip of
coronal/sagittal/horizontal sections already under the viewport is recoloured
by strength, because a hub map is read for *what a hub sits next to* and in 3D
that answer is behind whatever is in front of it. The sections go through the
existing slice renderer with a different structure colour table, so the
crosshair, the slice indices and the readouts are the same code — the only
change is what the lookup returns. A second brain beside the first, locked to
the same camera, is still one dropdown away and is the better surface for the
routes view, which a section cannot show.

Recolouring cost the crosshair its legibility: the accent it is drawn in is the
same warm orange as the ramp's bright end, so the target vanished exactly where
the map was most interesting. It now carries a dark halo, which works on both
colourings.

On the 3D surface a checkbox switches what it draws, and the two answer
different questions:

- **Regions** paints the **convergence matrix** — across the whole connectome,
  which regions is everything aimed at. This does **not** move when the target
  moves. That is what makes it a hub map rather than a second drawing of the
  back-trace, and the target on it is a reference mark, nothing more.
- **Routes** draws the traced paths into the current target, which do move.

The convergence matrix is built at build time by
`scripts/fetch-connectivity-matrix.mjs` (`npm run connectivity:fetch`) and
bundled: 586 queries against the Allen API once, rather than 586 queries the
user waits through. It stores, per target structure, the strongest projection
density reaching it from each *other* structure — one value per source, not per
experiment, because counting experiments ranks how often the Allen Institute
injected somewhere rather than the anatomy. Self-projection and same-lineage
pairs are dropped: an injection into CA3 "projecting into" CA3 is the injection
site at saturation, and left in it dominates every structure's own average.

It measures either **count** (how many regions project in — the region many
places aim at) or **mean** (the average strength of those projections — the
region the places that do aim at it aim at *hard*). A thalamic relay and a small
nucleus with one massive input are both hubs in different senses, and no single
number says both.

**Ipsilateral and contralateral are kept apart.** An earlier build asked Allen
for `hemisphere_id=3` — one pooled number per structure — which painted every
region identically on both halves and made the map symmetric by construction
rather than by anatomy. It is not a small difference: a single CA3 experiment
deposits 0.089 in one CA1 and 0.216 in the other. Both hemispheres are fetched
and each experiment's own injection side decides which is ipsilateral, which
matters because Allen injects the right hemisphere in 98% of cases. Left is ipsilateral in both grains, and the sections say so on themselves
rather than only in the caption: coronal and horizontal carry `ipsi` and
`contra` under their two halves, and a sagittal section — which is one
hemisphere, not two — is named by the one it was taken in, or `midline` when it
sits on it. The median
structure receives contralaterally from 0.58× as many regions as ipsilaterally,
and the spread is the interesting part: the midline thalamic nuclei come out
near 0.95, zona incerta at 0.53.

#### Underneath the parcellation: the voxel grain

The structure matrix's grain is also its ceiling. A dense input zone in one
corner of a region, a cluster straddling an annotation boundary, a gradient
across a nucleus — all averaged away before BrainCAD saw the number. So the
same question is also asked of the raw 100 µm `projection_density` grids, all
2,331 of them, accumulated per voxel by `npm run voxel:fetch` into a 4.6 MB
blob (2 MB over the wire).

It is worth being clear that **the pixels get bigger**: 100 µm against the
annotation's 50. What changes is that each one is a measurement at that place
rather than an average over the region containing it — which is what lets
cortical layers, and hot spots the parcellation never drew, appear at all.

Whether there was anything to find was tested before the full download, on a
300-experiment sample stratified across source structures. Half the structures
turned out to have a 95th percentile at least twice their own median, and —
the part that matters — 91% of those hot voxels sat in clusters of 20 or more.
Shuffling the values *within* each structure, which preserves the distribution
and destroys the arrangement, dropped that to 18% and fragmented 3,237 clusters
into 30,889. The variation is spatial, not a heavy tail.

Two things the voxel map shows that the structure map hid, both real:

- **White matter is bright.** A tract carries the axons of many sources, so it
  genuinely has high convergence by this measure — convergence of *passage*
  rather than of termination. The structure map buried this inside one "fiber
  tracts" block.
- **Laterality, before it was corrected.** Accumulated raw, the map was
  brighter on whichever side the needle went in. Each experiment is now
  mirrored so its injection lies on the **left**, making left ipsilateral and
  right contralateral throughout, the same convention the structure matrix
  uses.

The scale needs a percentile rather than a maximum: counts run to 1,772 against
a median of 52, so scaling to the brightest voxels renders the rest of the brain
as one dark mass.

Both grains paint through **one per-pixel path**. The slice renderer used to
take a structure-id colour table, which stopped being expressible the moment a
structure's value depended on which half of the brain a pixel was in. Now every
pixel asks which voxel it is — through the same flip rules the image was built
with — and that voxel is looked up in whichever map is selected.

**The corpus is the app's corpus.** The raw unionize table also carries rows
from the Alzheimer, aged-cohort, retina and target-defined studies — for CA1,
two thirds of all rows — and pooling those into "the mouse connectome" would mix
separate experiments with different animals and aims. The script enumerates
experiments through the same service the forward search uses, which costs 293
extra cheap queries and buys the guarantee that every tab is talking about the
same set of experiments.

Two things about the painting are worth stating:

- **The grain is the ontology's, not the volume's.** The finest thing Allen
  reports is the structure an experiment was injected into, so every voxel of
  CA3 takes CA3's value and edges fall on structure boundaries — that is where
  the information actually changes. Matching runs *up* the tree, because the
  annotation volume labels voxels "Field CA3, pyramidal layer" while the
  injection is reported against "Field CA3"; matching on equality left the brain
  unpainted while the list beside it confidently named CA3.
- **It is not additively blended, and the first version was.** Overlapping
  voxels summed, so a thick region blew out to white and the colour encoded how
  much tissue lay along the view ray rather than how strong the input was — the
  whole brain read as a hub. With depth, a pixel shows the nearest painted voxel
  and its colour is a strength and nothing else.

The ramp rises monotonically in luminance from deep indigo to near-white, so the
ordering survives greyscale and a colour-blind reader; a test asserts that
rather than trusting the stops. It is normalised against the strongest value
present, not against 1.0 — a target whose best input is 0.08 would otherwise
render entirely at the dark end — so the caption always states what the
brightest colour stands for.

#### The routes are drawn, and they are interpolations

Each row carries Allen's polyline from the seed voxel back to the injection
site, which is what makes a *visible* back-trace possible — one `LineSegments`
for the whole trace, coloured per structure from the Allen ontology and shaded
by that source's strength at the target.

One value for the whole route, and deliberately **not** the per-point density
Allen attaches to the path. That field looked like the obvious thing to use and
is almost entirely zero: a CA3 experiment delivering 0.981 at the target
carries `[0, 0, 0, 0, 0, 0, 0, 0, 0.386, 0]` along its path — nine zeros, one
value beside the injection, and a zero at the target itself, which is the one
place the row's own number says the signal is strongest. It is not the same
quantity on the same scale. Shading by it drew every route at the brightness
floor with a single bright segment near its far end: a picture of where Allen's
sampler happened to find signal rather than of anything anatomical. It is a route through a density field,
not a traced axon; the MouseLight overlay is the thing to reach for when an
individual arbor matters.

The search is slow — 5–15 seconds for a hippocampal seed — so the elapsed time
is shown rather than a spinner that is indistinguishable from a hang, and raw
responses are cached by seed point so stepping back over a coordinate is
instant. A dropped connection retries instead of surfacing a bare
`TypeError: Failed to fetch`.

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
