# Quick DICOM Planning

A lightweight, browser-only viewer for quick dental implant planning on CBCT scans.
Everything runs locally in the browser – no data is uploaded anywhere.

## Features

**Import**
- Open a DICOM series as files, as a folder, or by drag & drop (folders are searched recursively).
- Uncompressed DICOM (implicit/explicit VR little endian), single- or multi-frame. Slices are sorted by
  position and the volume is re-oriented to patient axes (LPS).
- "Demo volume" generates a synthetic mandible (with a missing molar and a slightly tilted occlusal plane) to try the app.

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
- Implants and abutments are drawn in 3D; the crop box clips the rendering (e.g. to hide the opposing jaw).

**Implant planning**
- Axial view: draw the panoramic curve (click along the arch from patient right to left, double-click/Enter to finish).
  Drag control points to edit, double-click the curve to insert a point, double-click a point to remove it.
- Panoramic reconstruction along the curve, switchable between a thick **slab** and a thin **slice** (separate adjustable
  thicknesses; switch in the sidebar or inside the panoramic view). The mouse wheel in the panoramic moves the slice
  position buccal (up) / lingual (down); Alt+wheel moves the cross-sections along the curve. *Center* puts it back on the curve.
- Three cross-sections perpendicular to the curve (adjustable spacing); wheel moves them along the curve.
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
- Tapered implants: tick *Tapered* and set the apex diameter (default 1 mm narrower than the platform), or drag the
  apical half of the side outline; the coronal half still sets the platform diameter. The apex is never wider than the
  platform.
- Implants can be renamed (name field, or double-click a name in the implant list); names appear in the views,
  the angle table and saved projects.
- While an implant is selected, the cross-sections follow it: moving, tilting or resizing it re-centres the middle
  cross-section on the implant (scrolling to neighbouring sections stays free).
- New implants can be placed parallel to the selected one, and any implant can be made parallel to another.
- Angulation: inclination of each implant, a pairwise angle table (per jaw), and angles between neighbouring implants in the panoramic.

**Projects (pause and continue later)**
- *Save project* (or **Ctrl+S**) writes one `.qdp.zip` file to your computer containing the CBCT voxels and the complete
  plan: orientation/rotation, crop box, window/level, panoramic curve and slice settings, implants and abutments,
  measurements, zoom/pan of every view, the 3D camera and which view was maximized.
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

**Common mouse controls**: wheel = scroll / navigate · Ctrl+wheel or right-drag (down = in, up = out) = zoom;
the toolbar switch makes right-drag adjust brightness/contrast instead · Shift+drag or middle-drag = pan ·
Alt/middle-drag = pan (also Shift-drag outside the MPR) · F = fit all views ·
M or the ⤢ button = maximize/restore a view · Esc = cancel / deselect · Del = delete selected implant.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (relative paths, can be hosted anywhere, e.g. GitHub Pages)
```

`node scripts/make-test-dicom.mjs <dir>` writes a small synthetic DICOM series for testing the loader.

### Public deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds the app and publishes it to GitHub Pages on every push to `main`
(or manually from the Actions tab). One-time setup: repository **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The site is then served at `https://<owner>.github.io/Quick-DICOM-Planning/`. The app is fully
static – scans are processed in the visitor's browser and never uploaded.

## Code layout

| File | Purpose |
| --- | --- |
| `src/dicom.ts` | DICOM parsing (dicom-parser), series grouping, slice sorting, volume assembly |
| `src/volume.ts` | Volume class, trilinear sampling, resampling (apply rotate/crop), demo phantom |
| `src/render.ts` | CPU reslicing of planes/lines with optional slab (average/MIP) and crop |
| `src/curve.ts` | Panoramic curve (centripetal Catmull-Rom, arc-length parametrised) |
| `src/app.ts` | Application state: orientation frame, crop, curve, implants, tangential plane |
| `src/views/View.ts` | Base view (canvas, zoom/pan/W-L), planar view, implant rasterisation & dragging |
| `src/views/MprView.ts` | Axial/coronal/sagittal MPR with Slicer-style rotation and crop box |
| `src/views/PlanViews.ts` | Planning axial, panoramic, cross-section and tangential views |
| `src/views/View3D.ts` | WebGL2 volume ray-caster with thresholds and ray-traced implants |
| `src/implant.ts` | Implant/abutment model (platform/apex, MUA geometry) |
| `src/views/implantEdit.ts` | Shared implant editing: move, C/A rotation handles, diameter/length dragging |

## Limitations

- Compressed transfer syntaxes (JPEG, JPEG 2000, RLE) are not decoded – convert first, e.g. `gdcmconv --raw in.dcm out.dcm`.
- Very large volumes (> ~260 M voxels) are downsampled ×2 on load to fit in browser memory.
- Not a medical device; for demonstration/educational use only.
