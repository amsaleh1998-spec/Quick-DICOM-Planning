# Quick DICOM Planning

A lightweight, browser-only viewer for quick dental implant planning on CBCT scans.
Everything runs locally in the browser – no data is uploaded anywhere.

## Features

**Import**
- Open a DICOM series as files, as a folder, or by drag & drop (folders are searched recursively).
- Uncompressed DICOM (implicit/explicit VR little endian) and compressed DICOM: **JPEG Lossless** (1.2.840.10008.1.2.4.57 /
  .70, common for CBCT), **JPEG-LS** (.80 / .81), **JPEG 2000** (.90 / .91), **RLE** (1.2.840.10008.1.2.5) and **JPEG
  Baseline** (.50) – single- or multi-frame, signed or unsigned. Compressed slices are decoded in parallel web workers
  (the WASM decoders load only when needed). File names don't matter: files
  without a `.dcm` extension (e.g. `IM000001`) and "raw" files without the 128-byte preamble/DICM header are detected
  from their content; non-DICOM files in the folder (DICOMDIR, `._*`, `.DS_Store`, text, images …) are ignored. Slices are sorted by
  position and the volume is re-oriented to patient axes (LPS).
- "Demo volume" generates a synthetic phantom to try the app: a mandible (missing lower-left first molar, mandibular canals)
  and a maxilla with a palate whose teeth touch the lower teeth in occlusion, on a slightly tilted occlusal plane.

**Patient & DICOM metadata**
- The patient's last and first name (from the DICOM Patient's Name, `LAST^FIRST`) are shown in the toolbar and in the
  Patient panel, with ID, birth date and sex. The names can be edited (e.g. for anonymised scans) and are saved with
  the project and used for the project file name.
- *DICOM tags* opens every attribute of the series' first file – tag, name, VR, value – with search (also inside
  sequences), expandable sequences and *Copy all*.

**MPR / Reorient**
- Axial, coronal and sagittal views with a linked crosshair. Hold **Shift** to make the crosshair follow the mouse.
- **Ctrl+Alt+drag** in a view (or the *Rotate* tool) rotates the other two planes around that view's axis, like 3D Slicer.
  *Straighten views* shows the rotated frame axis-aligned in all views; *Reset rotation* undoes it.
- **Crop** tool: drag the edges of the blue box in any view.
- **Apply rotate + crop** resamples the volume into the rotated, cropped frame (smaller and faster to work with).
  Any existing curve/implants are carried over.

**3D render** (WebGL2, in both layouts)
- GPU ray-casting with adjustable lower/upper thresholds: *Surface* (shaded iso-surface), *Translucent* and *MIP*.
- Automatic bone threshold from the histogram, view presets (front/back/left/right/top/bottom), drag to orbit.
- **Middle-click** any surface to make that point the centre of rotation (the view does not jump; mouse orbit, zoom and
  the SpaceMouse then pivot around it; a marker shows the centre while rotating). Middle-drag still pans.
- **Reset view** (⟲ in the 3D view, the 3D panel button, or double-click) restores the initial position and the
  rotation centre.
- Implants and abutments are drawn in 3D; the crop box clips the rendering (e.g. to hide the opposing jaw).

**Segmentation** (3D render panel → *Segmentation*; works in both layouts)
- Adjust the 3D *lower/upper threshold* until the structures are separated, add a segment (*+ Maxilla*, *+ Mandible*,
  *+ Tooth*, *+ Implant*, *+ Other*) and click the structure in the 3D view or in any slice. The connected voxels within the
  threshold range are grown into a coloured 3D object (volume shown in cm³). Click more places to add disconnected parts;
  *Undo click*, *Clear*, *Use current threshold* (re-grow with the current thresholds) and *Delete* are in the segment box.
- Add as many segments as needed. Clicking inside an existing segment carves the new one out of it – e.g. raise the
  threshold and click a tooth or an existing implant inside the jaw.
- Each segment can be shown/hidden and recoloured; *3D: show bone that is not segmented* switches off everything else, so
  e.g. only the maxilla remains. Segments are tinted (with outlines) in all slices, and the status bar names the segment
  under the cursor. Surface, translucent and MIP rendering all respect the visibility.
- **Separation cuts** for jaws/teeth that still touch: *Draw cut*, click points along the gap, double-click/Enter to finish.
  Drawn in the **panoramic** the cut is a curved sheet that follows the arch (ideal between the jaws); drawn in any
  **slice** it is the line extruded along the slice normal. *Reach* limits a cut to ± 2–20 mm around the slice it was
  drawn on (for a local contact) or lets it run through the whole volume. Region growing cannot cross a cut, and every
  segment is re-grown automatically when cuts change. The cut traces are drawn (orange) in all views.

**Nerve canal (inferior alveolar nerve)**
- *Trace right / left nerve*, then click the centre of the canal on the cross-sections (scroll along the curve), the
  panoramic or any MPR slice, in any order – each point is inserted where it fits along the path. The points are joined
  into a smooth tube (default Ø 2.5 mm, adjustable).
- The nerve is shown in every view: its exact cross-section/outline in planar slices, a projected band in the
  panoramic, and a yellow tube in 3D that stays visible (as a ghost) through the bone.
- While tracing, drag a point to move it, double-click a point to delete it, *Undo point* takes back the last one.
- Implants report their surface-to-surface distance to each nerve; closer than 2 mm is flagged (⚠ in the list).

**3Dconnexion SpaceMouse** (3D render panel)
- *Connect SpaceMouse* once (Chrome / Edge, via WebHID: wired, wireless and Universal Receiver models); afterwards it
  reconnects automatically. Browsers without WebHID are supported only if they expose the device as a game controller.
- Object mode – the model follows the cap: tilt / twist = rotate (any axis), push sideways = pan, pull up / push down =
  zoom. Left button = fit / reset, right button = next standard view (front, right, back, left, top, bottom).
- Speed slider and *Invert rotation* / *Invert pan / zoom*, remembered in the browser.
- The 3Dconnexion driver also turns cap motion into mouse-wheel scrolling/zooming for browsers; those wheel events are
  ignored while the cap is moved, so the two inputs do not fight. Motion is lightly smoothed.

**Implant planning**
- Axial view: draw the panoramic curve by holding the left button and dragging along the arch (a point is placed
  every 5 mm, the stroke is lightly smoothed and the curve finishes on release), or click point by point from patient
  right to left and double-click / Enter to finish.
  Drag control points to edit, double-click the curve to insert a point, double-click a point to remove it.
- Panoramic reconstruction along the curve, switchable between a thick **slab** and a thin **slice** (separate adjustable
  thicknesses; switch in the sidebar or inside the panoramic view). The mouse wheel in the panoramic moves the slice
  position buccal (up) / lingual (down); Alt+wheel moves the cross-sections along the curve. *Center* puts it back on the curve.
- Three cross-sections perpendicular to the curve (adjustable spacing); each wheel notch moves them exactly 1 mm along
  the curve. The *Curve* button in the axial view shows / hides the blue curve there (curve points can only be
  edited while it is shown); the *Curve* button in the cross-sections shows / hides their blue guide lines (hidden by default).
- Tangential view: a plane tangential to the curve that rotates 360° on mouse wheel.
  When an implant is selected the view pivots around the implant axis, keeping the implant vertical.
- Implants are simple cylinders with a platform (coronal, shown as a bright band) and an apex, with a dashed line along
  the axis. *Add upper implant* (apex up) or *Add lower implant* (apex down), then click in any planning view.
- Editing in any planning view: drag the body to move; drag the side outline to change the diameter; drag the apical end
  to change the length (the platform stays fixed). Dragging is damped (half speed) for fine control, and the value
  being changed is shown live on the implant for 5 seconds – click it to type an exact value. The selected implant has two rotation handles placed beyond its ends:
  **C** (coronal) rotates around the apex, **A** (apical) rotates around the platform.
- *Show prosthetic axis* (per implant): a Ø3 × 15 mm guide from the MUA top, or from the implant platform along the
  implant axis when there is no MUA. Adding an MUA switches it on; it can be turned off.
- Implants are tapered by default (apex 1 mm narrower than the platform; untick *New implants tapered* for cylinders).
  Per implant: tick *Tapered* and set the apex diameter (default 1 mm narrower than the platform), or drag the
  apical half of the side outline; the coronal half still sets the platform diameter. The apex is never wider than the
  platform.
- **Undo / redo**: Ctrl+Z (⌘Z) undoes implant changes – moves, tilts, resizing, typed values, adding / deleting,
  abutment changes – with unlimited history; Ctrl+Shift+Z or Ctrl+Y (⇧⌘Z) redoes. A whole drag is one step. Also as
  Undo / Redo buttons above the implant list.
- **Show / hide**: the eye button in the implant list hides an implant (with its abutment and axis); the **MUA** button
  hides only its abutment. Hidden items are not drawn in any view (including 3D) and cannot be clicked; *Show all*
  brings everything back. Visibility is saved with the project and is not part of the undo history.
- Implants can be renamed (name field, or double-click a name in the implant list); names appear in the views,
  the angle table and saved projects.
- While an implant is selected, the cross-sections follow it: moving, tilting or resizing it re-centres the middle
  cross-section on the implant (scrolling to neighbouring sections stays free).
- New implants can be placed parallel to the selected one, and any implant can be made parallel to another.
- Angulation: inclination of each implant, a pairwise angle table (per jaw), and angles between neighbouring implants in the panoramic.

**Mobile version** (`mobile.html`, opens automatically on phones)
- Open DICOM files, a project saved on the desktop (`.qdp.zip`, with implants, segments and nerves) or the demo.
- **MPR** tab: axial, coronal, sagittal and 3D on one screen (2 × 2, or in a row in landscape); ⤢ shows one view full
  screen. *Rotate axes*: drag around the centre of a view to tilt the other two planes (like the desktop Rotate tool);
  *Straighten* and *Reset* as on the desktop.
- **Plan** tab: axial, panoramic and three cross-sections. *Draw curve*, tap along the arch (patient right → left),
  *Undo point*, *Done*; drag a curve point to adjust it, *Clear curve* to start over.
- **3D** tab: the 3D view full screen.
- **Ruler** (MPR and Plan toolbars): drag from the start to the end point, or tap the start, then the end – in any slice
  or the panoramic. Drag a ruler end to adjust it, double-tap a ruler to delete it, *Clear rulers* removes all.
  Measurements are shared with the desktop version through project files.
- Touch: swipe to scroll slices (panoramic: left/right along the arch, up/down buccal/lingual; cross-sections: along the
  arch; axial planning view: level), tap to move the crosshair / pick a position, pinch to zoom, two fingers to pan,
  double-tap to fit. 3D: drag to rotate.
- Settings sheet: implant list (tap to jump to its cross-section; nerve-distance warnings), segment and nerve visibility,
  brightness/contrast, 3D mode/threshold/view presets. Implants, segmentation and nerve tracing are edited on the desktop.
- Phones are sent to it before the desktop page renders; *Full desktop version* (`index.html?ui=desktop`) is remembered on
  that phone, and *Mobile version* in the desktop toolbar (`?ui=mobile`) switches back. Memory/GPU budgets are lower on
  phones (series above ~110 M voxels are downsampled on load).

**Projects (pause and continue later)**
- *Save project* (or **Ctrl+S**) writes one `.qdp.zip` file to your computer containing the CBCT voxels and the complete
  plan: orientation/rotation, crop box, window/level, panoramic curve and slice settings, implants and abutments,
  segments (clicks, thresholds, colours, visibility), separation cuts, traced nerves, measurements, zoom/pan of every
  view, the 3D camera and which view was maximized. Segments are re-grown from their clicks when the project is opened.
- *Open project* (or drag the file onto the page / *Open files*) restores everything exactly as it was.
- The file is a normal ZIP: `project.json` (plan + view state) and `volume.raw` (int16, little endian, x fastest;
  dimensions/spacing in `project.json`).

**Measurements**
- *Ruler* (toolbar or **R**): click the first point, then the second point on any slice – MPR, axial, cross-sections,
  tangential, or the panoramic (distances on the developed panoramic surface). The tool then switches off; ruler ends can
  be dragged at any time to adjust them. Hover a ruler and press Delete (or double-click it) to remove it, *Clear* removes
  all, Esc cancels a ruler in progress. A ruler shows on the slice it was drawn on.
- Abutments: generic multi-unit abutments (straight, 17°, 30°) with 1–5 mm gingival height and adjustable rotation.
  Profile: Ø3.5 mm at the implant widening to Ø4.8 mm at the gingival level, then a 2.5 mm head tapering to Ø3 mm,
  followed by a Ø3 × 15 mm prosthetic axis (shown translucent, not clickable) along the abutment direction; *Auto-align* picks angulation + rotation that bring the abutment closest to vertical. Abutment-to-abutment
  angles are listed next to the implant angles.

**Mac trackpad** (Input → Trackpad; chosen automatically on a Mac, with a built-in *Trackpad guide* shown on first visit)
- Two-finger swipe: scroll slices (smoothly, ~28 px per slice); panoramic: up/down = slice position, left/right = along
  the curve; tangential: rotate; 3D: orbit.
- Pinch: zoom (Chrome/Firefox ctrl+wheel and Safari gesture events). ⌘ + swipe: pan. ⇧ + swipe: brightness/contrast.
- Two-finger click-drag = right-drag. ⌥⌘ + drag rotates MPR planes (Control-click is treated as a modified click).

**Every view**
- Maximizing / restoring a view (or resizing the browser window) keeps its field of view, so the image scales with the
  window instead of needing to be zoomed again.
- A vertical scroll bar on the right of each 2D view: slice position (MPR), level (planning axial), position along the
  arch (cross-sections), buccal/lingual slice position (panoramic, ±15 mm) and angle (tangential). Click to jump, drag
  to scroll; down moves the same way as the mouse wheel. Works with touch on phones.

**Common mouse controls**: wheel = scroll / navigate · Ctrl+wheel or right-drag (down = in, up = out) = zoom;
the toolbar switch makes right-drag adjust brightness/contrast instead · Shift+drag or middle-drag = pan ·
Alt/middle-drag = pan (also Shift-drag outside the MPR) · F = fit all views ·
M or the ⤢ button = maximize/restore a view · Esc = cancel / deselect / leave the segmentation tool ·
Enter = finish a cut · Del = delete selected implant.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (relative paths, can be hosted anywhere, e.g. GitHub Pages)
```

`node scripts/make-test-dicom.mjs <dir>` writes a small synthetic DICOM series for testing the loader.
`python3 scripts/make-compressed-dicom.py <dir>` (python-gdcm, pydicom) turns it into compressed variants of every
supported transfer syntax; the lossless ones must load with identical voxels.

### Public deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds the app and publishes it to GitHub Pages on every push to `main`
(or manually from the Actions tab). One-time setup: repository **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The site is then served at `https://<owner>.github.io/Quick-DICOM-Planning/`. The app is fully
static – scans are processed in the visitor's browser and never uploaded.

## Code layout

| File | Purpose |
| --- | --- |
| `src/codecs.ts`, `src/decodePool.ts`, `src/decodeWorker.ts` | Compressed DICOM decoders and the parallel decode workers |
| `src/dicom.ts` | DICOM parsing (dicom-parser), series grouping, slice sorting, volume assembly |
| `src/dicomMeta.ts` | Tag dictionary, metadata extraction, patient-name helpers |
| `src/tagViewer.ts` | Searchable DICOM tag viewer |
| `src/volume.ts` | Volume class, trilinear sampling, resampling (apply rotate/crop), demo phantom |
| `src/render.ts` | CPU reslicing of planes/lines with optional slab (average/MIP) and crop |
| `src/curve.ts` | Panoramic curve (centripetal Catmull-Rom, arc-length parametrised) |
| `src/app.ts` | Application state: orientation frame, crop, curve, implants, tangential plane |
| `src/views/View.ts` | Base view (canvas, zoom/pan/W-L), planar view, implant rasterisation & dragging |
| `src/views/MprView.ts` | Axial/coronal/sagittal MPR with Slicer-style rotation and crop box |
| `src/views/PlanViews.ts` | Planning axial, panoramic, cross-section and tangential views |
| `src/views/View3D.ts` | WebGL2 volume ray-caster with thresholds, segment labels, ray-traced implants and nerve tubes |
| `src/segment.ts` | Label grid, threshold region growing (seeds replayed in order), separation cuts (plane / panoramic) |
| `src/nerve.ts` | Nerve canal model: point insertion, smooth centre line, implant-to-nerve distance |
| `mobile.html`, `src/mobile.ts`, `src/mobile.css` | Phone UI: MPR / Plan / 3D layouts, touch gestures, settings sheet |
| `src/uiMode.ts` | Phone detection and the desktop/mobile preference (mirrored inline in `index.html`) |
| `src/spacemouse.ts` | 3Dconnexion SpaceMouse input (WebHID reports, game-controller fallback) |
| `src/views/overlays.ts` | 2D overlays: segment tint/outlines, cut traces, nerve tube sections and projections |
| `src/implant.ts` | Implant/abutment model (platform/apex, MUA geometry) |
| `src/views/implantEdit.ts` | Shared implant editing: move, C/A rotation handles, diameter/length dragging |

## Limitations

- Not decoded yet: JPEG Extended 12-bit (.51), HTJ2K, deflated transfer syntax and colour images – convert first, e.g.
  `gdcmconv --raw in.dcm out.dcm`.
- Very large volumes (> ~260 M voxels) are downsampled ×2 on load to fit in browser memory.
- Segmentation labels use the same grid as the 3D texture (≤ 48 M voxels), so very large scans are segmented at reduced
  resolution. Segments cannot be exported (e.g. as STL) yet.
- Not a medical device; for demonstration/educational use only.
