import type { App, Measurement, Mode, RenderMode } from './app';
import { Implant, reserveImplantIds } from './implant';
import { Frame, Vec2, Vec3 } from './math';
import { Nerve, reserveNerveIds } from './nerve';
import type { AiLayer, Cut, Segment } from './segment';
import { Volume, VolumeInfo } from './volume';
import { readZip, writeZip } from './zip';
import { Placement, Scan, ScanKind, reserveScanIds } from './scans';
import type { Affine } from './register';
import type { ViewState } from './views/View';
import { WaxTooth, Waxup, newGeo } from './waxup/waxup';
import { ensureLibrary, loadedLibrary, type ToothLibrary } from './waxup/library';

/**
 * Project file = ZIP with
 *   project.json – plan, orientation and view state
 *   volume.raw   – the CBCT voxels (int16 little endian, x fastest)
 *   scans/<id>.bin – intraoral scan meshes
 *   ai/cls.bin, ai/margin.bin – automatic segmentation (class and margin per voxel of its grid)
 */
const FORMAT = 'quick-dicom-planning-project';
const VERSION = 1;

interface ProjectFile {
  format: string;
  version: number;
  savedAt: string;
  volume: { dims: [number, number, number]; spacing: Vec3; info: VolumeInfo };
  state: {
    mode: Mode;
    O: Vec3;
    frame: Frame;
    psi: [number, number, number];
    X: Vec3;
    crop: { min: Vec3; max: Vec3 };
    cropEdited: boolean;
    wl: { center: number; width: number };
    mprTool: App['mprTool'];
    rightDrag: App['rightDrag'];
    /** active curve (kept for older versions of the app) */
    curve: Vec2[] | null;
    /** all panoramic curves (newer projects) */
    curves?: { name: string; ctrl: Vec2[]; nav: { s: number; focusC: number; panoOffset: number; panoVs: ViewState | null } }[];
    activeCurve?: number;
    s: number;
    focusC: number;
    crossSpacing: number;
    panoMode: 'slab' | 'slice';
    panoSlab: number;
    panoSlice: number;
    panoOffset: number;
    tangAngle: number;
    implants: Implant[];
    selectedId: number | null;
    defaultDiameter: number;
    defaultTapered?: boolean;
    defaultLength: number;
    placeParallel: boolean;
    vr: { mode: RenderMode; lo: number; hi: number };
    measurements: Measurement[];
    views: ViewState[];
    camera3d: { right: Vec3; up: Vec3; fwd: Vec3; target: Vec3 };
    /** index into app.views of the maximized view, or -1 */
    maximized: number;
    // segmentation & nerves (optional: older projects have none)
    segments?: Segment[];
    cuts?: Cut[];
    nerves?: Nerve[];
    activeSegId?: number | null;
    activeNerveId?: number | null;
    showUnsegmented?: boolean;
    showSegOverlay?: boolean;
    showCurveAxial?: boolean;
    showCurveCross?: boolean;
    cutDepth?: number | null;
    // intraoral scans (meshes in scans/<id>.bin)
    scans?: SavedScan[];
    activeScanId?: number | null;
    showScanContours?: boolean;
    /** automatic segmentation grid (data in ai/cls.bin and ai/margin.bin) */
    ai?: Omit<AiLayer, 'cls' | 'margin'> | null;
    /** waxup: library teeth (shaped ones' vertices in waxup/<fdi>.f32, library coordinates) */
    waxup?: SavedWaxup;
  };
}

interface SavedWaxup {
  library: string;
  placement: Waxup['placement'];
  teeth: { fdi: number; T: Affine; shaped: boolean }[];
  color: [number, number, number];
  opacity: number;
  visible: { upper: boolean; lower: boolean };
  contours: boolean;
}

interface SavedScan {
  id: number;
  name: string;
  kind: ScanKind;
  fileName: string;
  transform: Affine | null;
  placement: Placement | null;
  color: [number, number, number];
  vertexColors: boolean;
  opacity: number;
  visible: boolean;
  /** layout of scans/<id>.bin: float32 xyz × vertices, uint32 × 3 × triangles, then rgb bytes if hasCol */
  vertices: number;
  triangles: number;
  hasCol: boolean;
}

function scanBytes(sc: Scan): Uint8Array {
  const { pos, idx, col } = sc.mesh;
  const out = new Uint8Array(pos.byteLength + idx.byteLength + (col ? col.byteLength : 0));
  out.set(new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), 0);
  out.set(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength), pos.byteLength);
  if (col) out.set(col, pos.byteLength + idx.byteLength);
  return out;
}

function scanFromBytes(meta: SavedScan, data: Uint8Array): Scan {
  // copy into aligned buffers
  const nv = meta.vertices * 3;
  const nt = meta.triangles * 3;
  const pos = new Float32Array(data.slice(0, nv * 4).buffer);
  const idx = new Uint32Array(data.slice(nv * 4, nv * 4 + nt * 4).buffer);
  const col = meta.hasCol ? data.slice(nv * 4 + nt * 4, nv * 4 + nt * 4 + nv) : null;
  const { vertices: _v, triangles: _t, hasCol: _h, ...rest } = meta;
  return { ...rest, mesh: { pos, idx, col } };
}

export function projectFileName(app: App): string {
  const raw = app.vol?.info.patientName?.replace(/\^/g, ' ').trim() || 'project';
  const base = raw.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'project';
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.qdp.zip`;
}

export async function buildProject(app: App, onProgress?: (f: number) => void): Promise<Blob> {
  const vol = app.vol;
  if (!vol) throw new Error('Nothing to save – load a volume first.');
  const maxIdx = app.views.findIndex((v) => v.el.classList.contains('max'));
  const file: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    volume: { dims: vol.dims, spacing: vol.spacing, info: vol.info },
    state: {
      mode: app.mode,
      O: app.O,
      frame: app.frame,
      psi: app.psi,
      X: app.X,
      crop: app.crop,
      cropEdited: app.cropEdited,
      wl: app.wl,
      mprTool: app.mprTool,
      rightDrag: app.rightDrag,
      curve: app.curve?.ctrl ?? null,
      ...(() => {
        const c = app.curvesForSave();
        return { curves: c.list, activeCurve: c.active };
      })(),
      s: app.s,
      focusC: app.focusC,
      crossSpacing: app.crossSpacing,
      panoMode: app.panoMode,
      panoSlab: app.panoSlab,
      panoSlice: app.panoSlice,
      panoOffset: app.panoOffset,
      tangAngle: app.tangAngle,
      implants: app.implants,
      selectedId: app.selectedId,
      defaultDiameter: app.defaultDiameter,
      defaultTapered: app.defaultTapered,
      defaultLength: app.defaultLength,
      placeParallel: app.placeParallel,
      vr: app.vr,
      measurements: app.measurements.filter((m) => m !== app.pendingMeasurement?.m),
      views: app.views.map((v) => ({ ...v.vs })),
      camera3d: app.view3d.getCamera(),
      maximized: maxIdx,
      segments: app.seg.segments,
      cuts: app.seg.cuts,
      nerves: app.nerves,
      activeSegId: app.activeSegId,
      activeNerveId: app.activeNerveId,
      showUnsegmented: app.showUnsegmented,
      showSegOverlay: app.showSegOverlay,
      showCurveAxial: app.showCurveAxial,
      showCurveCross: app.showCurveCross,
      cutDepth: app.cutDepth,
      scans: app.scans.map((sc) => ({
        id: sc.id,
        name: sc.name,
        kind: sc.kind,
        fileName: sc.fileName,
        transform: sc.transform,
        placement: sc.placement,
        color: sc.color,
        vertexColors: sc.vertexColors,
        opacity: sc.opacity,
        visible: sc.visible,
        vertices: sc.mesh.pos.length / 3,
        triangles: sc.mesh.idx.length / 3,
        hasCol: !!sc.mesh.col,
      })),
      activeScanId: app.activeScanId,
      showScanContours: app.showScanContours,
      ai: (() => {
        const a = app.seg.ai;
        if (!a) return null;
        const { cls: _c, margin: _m, ...meta } = a;
        return meta;
      })(),
      waxup: app.wax.model.teeth.length
        ? {
            library: 'generic',
            placement: app.wax.model.placement,
            teeth: app.wax.model.teeth.map((t) => ({ fdi: t.fdi, T: t.T, shaped: t.geo !== 0 })),
            color: app.wax.color,
            opacity: app.wax.opacity,
            visible: app.wax.visible,
            contours: app.wax.contours,
          }
        : undefined,
    },
  };
  const json = new TextEncoder().encode(JSON.stringify(file, null, 1));
  const raw = new Uint8Array(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength);
  return writeZip(
    [
      { name: 'project.json', data: json },
      { name: 'volume.raw', data: raw },
      ...app.scans.map((sc) => ({ name: `scans/${sc.id}.bin`, data: scanBytes(sc) })),
      ...app.wax.model.teeth
        .filter((t) => t.geo !== 0)
        .map((t) => ({ name: `waxup/${t.fdi}.f32`, data: new Uint8Array(t.pos.buffer.slice(t.pos.byteOffset, t.pos.byteOffset + t.pos.byteLength)) })),
      ...(app.seg.ai
        ? [
            { name: 'ai/cls.bin', data: app.seg.ai.cls },
            { name: 'ai/margin.bin', data: app.seg.ai.margin },
          ]
        : []),
    ],
    onProgress,
  );
}

export interface LoadedProject {
  volume: Volume;
  file: ProjectFile;
  /** binary entries (scans/<id>.bin …) */
  entries: Map<string, Uint8Array>;
}

export async function readProject(buf: ArrayBuffer): Promise<LoadedProject> {
  const entries = await readZip(buf);
  const json = entries.get('project.json');
  const raw = entries.get('volume.raw');
  if (!json || !raw) throw new Error('This ZIP is not a Quick DICOM Planning project.');
  const file = JSON.parse(new TextDecoder().decode(json)) as ProjectFile;
  if (file.format !== FORMAT) throw new Error('This ZIP is not a Quick DICOM Planning project.');
  if (file.version > VERSION) throw new Error('The project was saved by a newer version of the app.');
  const [nx, ny, nz] = file.volume.dims;
  if (raw.byteLength !== nx * ny * nz * 2) throw new Error('Project volume data is incomplete.');
  const data = new Int16Array(raw.buffer, raw.byteOffset, nx * ny * nz);
  return { volume: new Volume([nx, ny, nz], file.volume.spacing, data, file.volume.info), file, entries };
}

/**
 * Restore the plan and view state. Call after app.setVolume(volume) and after
 * switching the layout to `file.state.mode`.
 */
export function applyProjectState(app: App, file: ProjectFile, entries?: Map<string, Uint8Array>) {
  const st = file.state;
  app.O = st.O;
  app.frame = st.frame;
  app.psi = st.psi;
  app.X = st.X;
  app.crop = st.crop;
  app.cropEdited = st.cropEdited;
  app.wl = st.wl;
  app.mprTool = st.mprTool;
  app.rightDrag = st.rightDrag;
  app.s = st.s;
  app.focusC = st.focusC;
  if (st.curves?.length) app.restoreCurves(st.curves, st.activeCurve ?? 0);
  else app.restoreCurves(st.curve ? [{ name: 'Curve 1', ctrl: st.curve }] : [], 0); // older single-curve projects
  app.crossSpacing = st.crossSpacing;
  app.panoMode = st.panoMode;
  app.panoSlab = st.panoSlab;
  app.panoSlice = st.panoSlice;
  app.panoOffset = st.panoOffset;
  app.tangAngle = st.tangAngle;
  app.implants = st.implants.map((i) => ({
    ...i,
    apicalDiameter: i.apicalDiameter ?? null,
    abutment: i.abutment ?? null,
    // projects saved before the toggle showed the axis exactly when an MUA was present
    showProstheticAxis: i.showProstheticAxis ?? !!i.abutment,
    hidden: i.hidden ?? false,
    abutmentHidden: i.abutmentHidden ?? false,
  }));
  reserveImplantIds(Math.max(0, ...app.implants.map((i) => i.id)));
  app.selectedId = st.selectedId;
  app.defaultDiameter = st.defaultDiameter;
  app.defaultTapered = st.defaultTapered ?? true;
  app.defaultLength = st.defaultLength;
  app.placeParallel = st.placeParallel;
  app.vr = { ...st.vr };
  app.setMeasurements(st.measurements ?? []);
  st.views.forEach((vs, i) => {
    const v = app.views[i];
    if (v) {
      Object.assign(v.vs, vs, { fitted: true });
      v.syncSize(); // saved with another window size: keep the field of view
    }
  });
  if (st.camera3d) app.view3d.setCamera(st.camera3d);
  for (const v of app.views) v.invalidate();
  const mv = app.views[st.maximized];
  if (mv && !mv.el.classList.contains('max')) app.toggleMaximize(mv);
  app.showUnsegmented = st.showUnsegmented ?? true;
  app.showSegOverlay = st.showSegOverlay ?? true;
  app.showCurveAxial = st.showCurveAxial ?? true;
  app.showCurveCross = st.showCurveCross ?? false;
  app.cutDepth = st.cutDepth ?? null;
  app.activeSegId = st.activeSegId ?? null;
  app.activeNerveId = st.activeNerveId ?? null;
  const nerves = (st.nerves ?? []).map((n) => ({ ...n, pts: n.pts.map((p) => [...p] as Vec3) }));
  reserveNerveIds(Math.max(0, ...nerves.map((n) => n.id)));
  let ai: AiLayer | null = null;
  const aiCls = entries?.get('ai/cls.bin');
  const aiMargin = entries?.get('ai/margin.bin');
  if (st.ai && aiCls && aiMargin) {
    const n = st.ai.nx * st.ai.ny * st.ai.nz;
    if (aiCls.length === n && aiMargin.length === n) ai = { ...st.ai, cls: aiCls.slice(), margin: aiMargin.slice() };
  }
  // automatic segments without their data (damaged project) are dropped
  const segments = (st.segments ?? []).filter((g) => !g.ai || ai);
  app.restoreSegmentation(segments, st.cuts ?? [], nerves, ai);
  app.scans = [];
  for (const meta of st.scans ?? []) {
    const data = entries?.get(`scans/${meta.id}.bin`);
    if (data) app.scans.push(scanFromBytes(meta, data));
  }
  reserveScanIds(Math.max(0, ...app.scans.map((x) => x.id)));
  app.activeScanId = st.activeScanId ?? null;
  app.showScanContours = st.showScanContours ?? true;
  restoreWaxup(app, st.waxup, entries);
  app.resetHistory();
  app.markSaved();
  app.onWindowChange();
  app.changed();
}


/** Whether the project has waxup teeth (the tooth library must be loaded before restoring it). */
export function projectHasWaxup(file: ProjectFile): boolean {
  return !!file.state.waxup?.teeth.length;
}

function restoreWaxup(app: App, saved: SavedWaxup | undefined, entries?: Map<string, Uint8Array>) {
  app.wax.clear();
  if (!saved?.teeth.length) return;
  const apply = (lib: ToothLibrary) => {
    const m = app.wax.model;
    m.lib = lib;
    m.placement = saved.placement;
    m.teeth = saved.teeth
      .filter((t) => lib.teeth.has(t.fdi))
      .map((s): WaxTooth => {
        const tpl = lib.teeth.get(s.fdi)!;
        const data = s.shaped ? entries?.get(`waxup/${s.fdi}.f32`) : undefined;
        const ok = data && data.byteLength === tpl.pos.byteLength;
        return { fdi: s.fdi, jaw: tpl.jaw, idx: tpl.idx, T: s.T, pos: ok ? new Float32Array(data.slice().buffer) : tpl.pos, geo: ok ? newGeo() : 0 };
      });
    app.wax.color = saved.color;
    app.wax.opacity = saved.opacity;
    app.wax.visible = { ...saved.visible };
    app.wax.contours = saved.contours;
  };
  const lib = loadedLibrary();
  if (lib) apply(lib);
  else
    // not loaded yet (mobile): restore when it is, as part of the opened project
    void ensureLibrary().then((l) => {
      apply(l);
      app.resetHistory();
      app.markSaved();
    });
}
