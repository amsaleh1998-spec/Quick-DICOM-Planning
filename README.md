# Quick DICOM Planning

A lightweight, browser-only viewer for quick dental implant planning on CBCT scans.
Everything runs locally in the browser – no data is uploaded anywhere.

## Interface

- **Start screen**: drop a CBCT (files, folder, ZIP or project), use the buttons, or reopen a scan from **Recent**
  (Chrome / Edge remember the files you opened through *Open*; reopening may ask for read access again).
- **Top bar** (one row): the **patient chip** (name and scan date; click for ID, birth date, the editable name, volume
  details and *DICOM tags*) · **Open ▾** (files, folder, project, demo, recent) · **Save** · **Export ▾** (STL, project) ·
  the steps **① Reorient / ② Plan** · undo / redo · *Ruler* / *Clear* · window / level · **⚙ Settings** (mouse or
  trackpad and the trackpad guide, right-drag zoom or brightness, *Open scans directly in ② Plan*, SpaceMouse, install
  app, double-click helper) · **?** (every shortcut, also with the **?** key).
- **Left rail**: one side panel at a time – Reorient (step ①), Curve, Implants, Nerves (step ②), Segments and Scans
  (both steps). Click the open icon again (or the arrow at the bottom) to hide the panel and give the views the full
  width. Each panel lists its objects (eye = show / hide) and below that the settings of the selected one; rarely used
  options sit in collapsed sections.
- **View settings in the views**: the 3D view's header has the rendering mode and thresholds (*Surface 796+ ▾*) and the
  view direction (*View ▾*); the panoramic's header has *Slab / Slice* and the thickness, slice position and
  cross-section spacing (*12 mm · sections 2 mm ▾*).
- **Status bar**: a one-line hint for the open panel, messages, and the value under the cursor.

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
- The patient's last and first name (from the DICOM Patient's Name, `LAST^FIRST`) are shown in the patient chip (top
  bar); click it for ID, birth date and sex. The names can be edited (e.g. for anonymised scans) and are saved with
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

**Automatic segmentation (AI)** (Segments panel → *Automatic (AI) – Run…*) – see
[Automatic segmentation](#automatic-segmentation-dentalsegmentator) below: maxilla & upper skull, mandible, upper teeth,
lower teeth and mandibular canals in one go, with the DentalSegmentator model by Dot et al. (2024).

**Segmentation** (Segments panel → *Segment by threshold, separation cuts*; works in both steps)
- Adjust the 3D *lower/upper threshold* until the structures are separated, add a segment (*+ Maxilla*, *+ Mandible*,
  *+ Tooth*, *+ Implant*, *+ Other*) and click the structure in the 3D view or in any slice. The connected voxels within the
  threshold range are grown into a coloured 3D object (volume shown in cm³). Click more places to add disconnected parts;
  Ctrl+Z takes back a click; *Clear*, *Use current threshold* (re-grow with the current thresholds) and *Delete* are in the segment box.
- Add as many segments as needed. Clicking inside an existing segment carves the new one out of it – e.g. raise the
  threshold and click a tooth or an existing implant inside the jaw.
- Each segment has a **3D opacity** slider (in its box): see-through segments show what lies inside or behind them –
  teeth roots, canals, nerves, implants, intraoral scans. Maxilla and mandible start at 70 %, everything else opaque.
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
- While tracing, drag a point to move it, double-click a point to delete it, Ctrl+Z takes back the last one.
- Implants report their surface-to-surface distance to each nerve (the implant as it is: flat platform and apex, tapered
  side; the canal as a tube of its diameter); closer than 2 mm is flagged (⚠ in the list).

**3Dconnexion SpaceMouse** (⚙ Settings)
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
- **Several panoramic curves**, e.g. one for the maxilla and one for the mandible: *+ New curve* draws another one
  (scroll the axial view to that jaw's level first). The active curve drives the panoramic, cross-sections and
  tangential view; each curve keeps its own axial level, position, panoramic slice offset and zoom. Switch in the
  *Panoramic curves* list or by clicking a dimmed curve in the axial view; selecting an implant in the implant list
  switches to the curve it belongs to. Curves can be renamed (Maxilla / Mandible suggestions), redrawn and deleted,
  and are all saved in projects.
- Panoramic reconstruction along the curve, switchable between a thick **slab** and a thin **slice** (separate adjustable
  thicknesses; switch in the panoramic view's header). The mouse wheel in the panoramic moves the slice
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
- **Undo / redo**: Ctrl+Z (⌘Z) undoes any change of the plan – implants (moves, tilts, sizes, abutments, adding /
  deleting), panoramic curves, segments (clicks, cuts, colours, opacity, automatic segmentation), nerve points, scans
  (placement, appearance, deleting) and rulers – in one unlimited history; Ctrl+Shift+Z or Ctrl+Y (⇧⌘Z) redoes. Every
  click or drag is one step, typing in a field becomes a step once you pause. Also the ↶ ↷ buttons in the top bar.
  Not part of the history: how the scan is viewed (slices, zoom, window / level, 3D thresholds, show / hide) and
  *Apply* in ① Reorient, which resamples the volume and starts a new history.
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
  that phone, and *Mobile version* in ⚙ Settings (`?ui=mobile`) switches back. Memory/GPU budgets are lower on
  phones (series above ~110 M voxels are downsampled on load).

**Projects (pause and continue later)**
- *Save* (or **Ctrl+S**) writes one `.qdp.zip` file to your computer containing the CBCT voxels and the complete
  plan: orientation/rotation, crop box, window/level, panoramic curve and slice settings, implants and abutments,
  segments (clicks, thresholds, colours, visibility), separation cuts, traced nerves, measurements, zoom/pan of every
  view, the 3D camera and which view was maximized. Segments are re-grown from their clicks when the project is opened.
- *Open ▾ → Project* (or drag the file onto the page, or pick it under *Recent*) restores everything exactly as it was.
- The file is a normal ZIP: `project.json` (plan + view state) and `volume.raw` (int16, little endian, x fastest;
  dimensions/spacing in `project.json`).

**Measurements**
- *Ruler* (top bar or **R**): click the first point, then the second point on any slice – MPR, axial, cross-sections,
  tangential, or the panoramic (distances on the developed panoramic surface). The tool then switches off; ruler ends can
  be dragged at any time to adjust them. Hover a ruler and press Delete (or double-click it) to remove it, *Clear* removes
  all, Esc cancels a ruler in progress. A ruler shows on the slice it was drawn on.
- Abutments: generic multi-unit abutments (straight, 17°, 30°) with 1–5 mm gingival height and adjustable rotation.
  Profile: Ø3.5 mm at the implant widening to Ø4.8 mm at the gingival level, then a 2.5 mm head tapering to Ø3 mm,
  followed by a Ø3 × 15 mm prosthetic axis (shown translucent, not clickable) along the abutment direction; *Auto-align* picks angulation + rotation that bring the abutment closest to vertical. Abutment-to-abutment
  angles are listed next to the implant angles.

**Mac trackpad** (⚙ Settings → Input → Trackpad; chosen automatically on a Mac, with a built-in *Trackpad guide* shown on first visit)
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
⚙ Settings can make right-drag adjust brightness/contrast instead · Shift+drag or middle-drag = pan ·
Alt/middle-drag = pan (also Shift-drag outside the MPR) · F = fit all views ·
M or the ⤢ button = maximize/restore a view · Esc = cancel / deselect / leave the segmentation tool ·
Enter = finish a cut · Del = delete selected implant.

## Automatic segmentation (DentalSegmentator)

*Segments* panel → **Automatic (AI) – Run…** segments the **maxilla & upper skull**, the **mandible**, the
**upper teeth**, the **lower teeth** and the **mandibular canals** of a CBCT or CT with
**[DentalSegmentator](https://doi.org/10.1016/j.jdent.2024.105130)**, the open deep-learning model by Gauthier Dot et al.
It runs entirely in the browser (ONNX Runtime Web – on the graphics card with WebGPU in Chrome / Edge, otherwise on the
CPU); the scan is never uploaded. The model (62 MB) and the runtime are served by this app's own site (no other
server, CDN or Zenodo at run time), downloaded on first use, checked (SHA-256) and kept in the browser cache – later
runs work offline.

- **Region**: the whole scan or the crop box (faster; the network still sees 10 mm of context around the box and
  writes labels only inside it).
- **Quality**: *Standard* uses overlapping tiles exactly like nnU-Net (tile step 0.5); *Fast* uses non-overlapping
  tiles (about 4× quicker; on a test CBCT the result agreed with Standard at Dice 0.94–0.98).
- The run happens in a background worker with progress, time estimate and *Cancel*; *Run in background* lets you keep
  working.
- The dialog names the graphics card that will be used. **Laptops with two GPUs**: Chrome / Edge on Windows use the GPU
  that Windows assigns to the browser program, not the one a web page asks for, so they often run on the slow integrated
  Intel graphics. Windows assigns GPUs per program and the installed app runs inside its browser, so to give **only
  this app** the NVIDIA card, install it from **Microsoft Edge** and set just Edge to *High performance* in Windows
  *Settings → System → Display → Graphics* (Chrome stays on the integrated graphics); run the double-click helper again
  so it opens scans in the Edge copy (it prefers the Edge copy when the app is installed in both browsers). The dialog
  shows these steps when it detects integrated Intel graphics.
- The result appears as five ordinary segments (marked *AI*): show / hide, recolour, rename, delete, add parts by
  clicking, use them as the CBCT surface when aligning intraoral scans, and export them with *Export STL*. Their
  surfaces are smooth (the network's class margins are interpolated, not the voxel staircase). They are saved in
  projects and follow *Apply rotate + crop*. Running it again replaces the previous automatic segments. Afterwards
  *3D: show bone that is not segmented* is switched off, so only the segmented structures remain (the jaws slightly
  see-through).

Fidelity: the pre- and post-processing of nnU-Net is re-implemented (crop to the non-zero region, resampling to the
model's 0.43 × 0.31 × 0.43 mm grid, CT normalisation, sliding window with Gaussian weighting, logits resampled back
before the argmax). On a public test CBCT (3D Slicer's *PreDentalSurgery* sample) the browser version agreed with
the official nnU-Net prediction on 99.92 % of the voxels (Dice 0.986–0.992 for bone and teeth, 0.968 for the canals).
Like any automatic method it can be wrong (metal artefacts, unusual anatomy, low dose) – **check every segment**.

**Credits – please cite when you use the results:**

- Dot G, et al. DentalSegmentator: robust open source deep learning-based CT and CBCT image segmentation.
  *Journal of Dentistry* (2024). doi:[10.1016/j.jdent.2024.105130](https://doi.org/10.1016/j.jdent.2024.105130)
- Model weights: Dot G. *DentalSegmentator nnU-Net pretrained model for CBCT image segmentation.* Zenodo (2024).
  doi:[10.5281/zenodo.10829675](https://doi.org/10.5281/zenodo.10829675) – licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The copy in `public/models/dentalsegmentator/` is converted
  to ONNX with half-precision weights (see the README there for all changes; conversion scripts in
  `tools/dentalsegmentator/`).
- Isensee F, Jaeger PF, Kohl SAA, Petersen J, Maier-Hein KH. nnU-Net: a self-configuring method for deep
  learning-based biomedical image segmentation. *Nat Methods* 2021;18(2):203-211.
  doi:[10.1038/s41592-020-01008-z](https://doi.org/10.1038/s41592-020-01008-z)
- The same model for 3D Slicer: [SlicerDentalSegmentator](https://github.com/gaudot/SlicerDentalSegmentator).

## Intraoral scans

**Intraoral scans** (Scans panel → *Import…*, or drop the file on the viewer) imports upper/lower jaw scans,
antagonists and wax-ups as STL (binary/ASCII), PLY (binary/ASCII, with vertex colours, e.g. TRIOS exports) or OBJ.
The type is guessed from the file name (upper / lower / wax-up …) and can be changed. Each scan is then placed:

- **Original position** – the file is already in this CBCT's coordinates (DICOM patient coordinates, e.g. an STL
  exported from Quick DICOM Planning or another planning software).
- **Copy the alignment of** an already aligned scan – scans from the same scanner session (upper, lower, bite) share
  one coordinate system and a wax-up usually keeps the coordinates of its jaw scan, so e.g. the lower jaw scan and
  the upper wax-up copy the alignment of the upper jaw scan.
- **Align to the CBCT** in a two-pane workspace (scan | CBCT). The CBCT side is the surface you choose: any segment
  (e.g. *Maxilla*) or the *3D render at the current threshold* (inside the crop box); closed hollow spaces are filled
  so only the outer surface is matched.
  - **Points** (like Blue Sky Plan, RealGuide, exoplan): click a point on the scan, then the same point on the CBCT;
    at least 3 pairs. The fit is refined on the surface around the points (or on the painted areas).
  - **Surfaces** (like coDiagnostiX): paint the areas of the scan that are visible in the CBCT (tooth surfaces, not
    gingiva or metal artefacts) and press *Match* – the position is searched automatically (rotations around the
    occlusal axis and heights, then ICP). For partial arches, or if the match is reported as uncertain, switch to
    *Points* and click 1–2 matching points as a guide.
  - The result is shown on the CBCT surface coloured by distance (green < 0.3 mm …) with the share of the matched
    area within 0.5 mm; *Accept* keeps it.

Placed scans are drawn in the 3D view (composited with the volume and implants) and as outlines in every slice, the
cross-sections, the tangential view and the panoramic; colour, opacity, scan colours, visibility and outlines can be
changed per scan. They are saved in projects, follow *Apply rotate + crop*, and can be exported with *Export STL*
(aligned, in DICOM coordinates).

## Export STL

**Export ▾ → STL** (top bar) writes binary STL files in millimetres in the **original DICOM patient coordinates**
(LPS, as in ImagePositionPatient; the header carries `SPACE=LPS` for 3D Slicer), so the models line up with the CBCT
in other software and with each other. The mapping is recorded when the series is loaded (axis reordering, flips,
downsampling), follows *Apply rotate + crop* and is saved in projects. Series without position information (and the
demo phantom) export in the scan's own coordinates instead.

- **3D render** – the surface at the current 3D threshold range, limited to the crop box when one is set
- **Segments** – each segment's bone surface (follows the CT values at the segment's threshold, closed against
  neighbouring segments and cuts)
- **Implants** (truncated cones with their real platform/apex diameters and length) and **MUAs** (collar + angled head)
- **Nerve canals** – tubes along the traced centre line with the canal diameter

Options: detail of bone surfaces – **High** (default: sampled at the full CT resolution, even when the segmentation
label grid is downsampled for large scans), Medium (~4× smaller files) or Low (~9×); *Smooth surfaces* (Taubin
smoothing, removes the voxel staircase without shrinking the model); *Solid models* (fills closed hollow spaces
inside the bone for smaller printable models); one STL per object in a ZIP or everything in a single STL. Surfaces
are extracted with marching tetrahedra into a shared-vertex mesh, so they are closed, manifold and consistently
oriented.

## Open DICOM files by double-clicking (Windows)

The app can be installed from Chrome or Microsoft Edge and then registered for `.dcm`, `.dicom`, `.dic` and `.ima` files:

1. Open the app in Chrome or Edge and click **Install app** in ⚙ Settings (or the install icon in the address bar /
   ⋯ → *Apps* → *Install this site as an app*).
2. Double-click a `.dcm` file in Explorer. The first time, Windows asks which app to use: choose
   **Quick DICOM Planning** and tick *Always*. The browser may also ask once to allow the app to open these files.
3. **One-time setup:** the first time, the app asks you to choose the folder where your scans are saved
   (e.g. `D:\CBCT` – the higher up, the better). The app remembers it. From then on, double-clicking any scan inside
   that folder loads the whole series straight away – no question, no folder window. (A web app is never handed the
   other files of a folder by itself; the remembered folder access is what makes this possible.) If Chrome/Edge
   later asks again, choose **Allow on every visit**. Selecting several files in Explorer and pressing Enter opens
   exactly those files.

**Never be asked (Windows helper).** Browsers only ever hand a web app the one file that was double-clicked, so
the steps above need the scans folder once. To skip even that, download
[`Install-QuickDICOM-Helper.cmd`](public/windows/Install-QuickDICOM-Helper.cmd) (also linked in the app: ⚙ Settings → *Install app*
dialog, or *Never ask again…* on the launch banner) and run it once. It installs for the current Windows user only
(no admin rights, files in `%LOCALAPPDATA%\QuickDICOMPlanning`), registers *Quick DICOM Planning (whole series)* for
`.dcm/.dicom/.dic/.ima`, and opens the *Open with* dialog: choose it and tick *Always*. On a double-click it packs
all files of that folder into one uncompressed bundle (a ZIP named `.dcm` in `%USERPROFILE%\QuickDICOMPlanning\bundles`,
cleaned up after 12 h) and starts the installed app with it, so the whole series opens with no prompt. (Chrome and Edge
do not let web apps read files under AppData / the temp folder or in hidden dot-folders of the user folder, so the
bundle must live in a plain folder; the Mac helper uses `~/QuickDICOMPlanning/bundles`.) If the app is installed in both
Chrome and Edge, the helper opens the Edge copy. It finds the app through the browser's file-type registration or,
when the browser has not registered it (yet), through the app's Start menu / desktop shortcut. `uninstall.cmd` in the same folder removes it. The app also opens any ZIP of DICOM files (drag & drop or *Open files*).

**macOS.** Install the app from Chrome or Edge the same way; in Finder select a `.dcm` file → *File → Get Info* →
*Open with: Quick DICOM Planning* → *Change All…*. To skip the folder question there too, run the Mac helper once in
Terminal (also shown in the app under ⚙ Settings → *Install app* / *Mac helper*):

```bash
curl -fsSL https://amsaleh1998-spec.github.io/Quick-DICOM-Planning/mac/install-helper.sh | bash
```

It builds *Quick DICOM Planning (whole series)* in `~/Applications` (an AppleScript droplet, current user only, no
password), registers it for `.dcm/.dicom/.dic/.ima` and tries to make it the default (otherwise: Get Info → Open
with → Change All…). A double-click packs the file's folder with `zip -0` into the temp folder and opens the installed
web app with it. macOS may ask once per protected location (Documents, Desktop, Dropbox …) to allow folder access.
Log: `~/Library/Application Support/QuickDICOMPlanning/log.txt`; remove with `uninstall.sh` in the same folder.

Files without an extension cannot be associated in Windows; open their folder with *Open folder* or drag & drop.
The installed app also works offline.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static build in dist/ (relative paths, can be hosted anywhere, e.g. GitHub Pages)
```

`node scripts/make-test-dicom.mjs <dir>` writes a small synthetic DICOM series for testing the loader.
`python3 scripts/make-compressed-dicom.py <dir>` (python-gdcm, pydicom) turns it into compressed variants of every
supported transfer syntax; the lossless ones must load with identical voxels.

### Tests

```bash
npm test           # unit tests (vitest, in node, about a second)
npm run test:e2e   # browser tests of the built app (Playwright, Chromium; run npm run build first)
npm run test:all   # type check, unit tests, build and browser tests – what CI runs
```

The first time, install the test browser: `npx playwright install chromium`.

- **Unit tests** (`tests/unit/`): DICOM loading (with and without preamble / extensions) and the patient coordinates
  of every voxel, coordinates kept through reorientation and crop, segment STL export (closed, outward-facing, right
  volume, at the right place in DICOM patient coordinates), implant solids, scan alignment (point pairs, ICP) and
  placement in original coordinates, implant / nerve distances, panoramic curves, STL / PLY / OBJ import, ZIP
  (projects), the automatic segmentation engine (tiling, axes, blending – with a stand-in for the network whose answer
  is known) and the undo history.
- **Browser tests** (`tests/e2e/`): opening a DICOM series, planning, segmenting, importing a scan, the export dialog,
  saving and reopening a project, undo / redo of every kind of change, Recent after drag & drop, keyboard, settings,
  the mobile version. Every test fails on a script error in the page.

The test files (a synthetic DICOM series with a made-up patient, an arch-shaped surface scan) are generated when the
tests run. `.github/workflows/test.yml` runs all tests on every branch and pull request; the deployment below runs
them too and publishes nothing when one fails (the Playwright report is kept as an artifact of the run).

### Public deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` checks (type check, unit and browser tests), builds the app and publishes it to
GitHub Pages on every push to `main` (or manually from the Actions tab) – only when every check passes. One-time setup: repository **Settings → Pages → Build and deployment → Source:
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
| `src/main.ts` | Desktop entry: top bar, window / level, and the redraw that refreshes every panel when the state changes |
| `src/ui/shell.ts` | The `App` instance, status bar, loading overlay and small HTML helpers shared by all panels |
| `src/ui/layout.ts` | The two layouts, mode tabs, panel rail and start screen visibility |
| `src/ui/files.ts`, `src/ui/save.ts` | Opening scans and projects (Open menu, Recent, drag & drop, files double-clicked in Explorer / Finder), saving and file delivery |
| `src/ui/install.ts` | Install app and the Windows / Mac double-click helper |
| `src/ui/reorientPanel.ts`, `curvePanel.ts`, `implantsPanel.ts`, `segmentsPanel.ts`, `nervesPanel.ts`, `scansPanel.ts` | One module per side panel: its controls and its refresh |
| `src/ui/viewSettings.ts`, `settings.ts`, `patient.ts` | Settings inside the 3D / panoramic views, the ⚙ Settings popover (input, SpaceMouse), the patient chip |
| `src/history.ts`, `src/planHistory.ts` | Undo / redo: one history of the plan, split into channels (implants, curves, segments, nerves, scans, rulers) |
| `src/ui/undoUi.ts`, `keyboard.ts` | Undo / redo buttons and keyboard shortcuts |
| `src/ui/rail.ts`, `src/ui/popover.ts`, `src/ui/help.ts`, `src/ui/viewTools.ts`, `src/ui/recent.ts` | Interface building blocks: panel rail, menus, shortcut sheet, view header tools, recent scans |
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
| `src/meshio.ts`, `src/scans.ts` | STL / PLY / OBJ readers, scan model (placement, appearance, world-space cache) |
| `src/register.ts`, `src/alignUi.ts`, `src/meshViewer.ts`, `src/meshgl.ts` | Scan alignment: point pairs (Horn), k-d tree ICP, automatic surface matching; placement dialog and two-pane alignment workspace; WebGL mesh rendering |
| `src/views/scanContours.ts` | Scan outlines in planar views and the panoramic |
| `src/stl.ts`, `src/exportStl.ts` | STL export: marching-tetrahedra iso-surfaces, cavity filling, cone/tube solids, binary STL writer, export dialog |
| `src/ai/dsPlan.ts`, `src/ai/dsEngine.ts` | DentalSegmentator: nnU-Net constants, tile grid, Gaussian weights; sliding-window engine (tile input, blending ring buffer, resampling to the label grid) |
| `src/ai/dsWorker.ts`, `src/ai/dentalSegmentator.ts` | Model download/cache, ONNX Runtime Web (WebGPU / WebAssembly) in a worker; dialog, progress and credits |
| `public/models/dentalsegmentator/`, `tools/dentalsegmentator/` | The converted model (CC BY 4.0, Dot et al.) and the conversion scripts |

## Limitations

- Not decoded yet: JPEG Extended 12-bit (.51), HTJ2K, deflated transfer syntax and colour images – convert first, e.g.
  `gdcmconv --raw in.dcm out.dcm`.
- Very large volumes (> ~260 M voxels) are downsampled ×2 on load to fit in browser memory.
- Segmentation labels use the same grid as the 3D texture (≤ 48 M voxels), so very large scans are segmented at reduced
  resolution.
- The automatic segmentation needs a desktop browser; without WebGPU it runs on the CPU and can take a long time for
  a large field of view (use the crop box or *Fast*).
- Not a medical device; for demonstration/educational use only.
