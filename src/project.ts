import type { App, Measurement, Mode, RenderMode } from './app';
import { ArchCurve } from './curve';
import { Implant, reserveImplantIds } from './implant';
import { Frame, Vec2, Vec3 } from './math';
import { Nerve, reserveNerveIds } from './nerve';
import type { Cut, Segment } from './segment';
import { Volume, VolumeInfo } from './volume';
import { readZip, writeZip } from './zip';
import type { ViewState } from './views/View';

/**
 * Project file = ZIP with
 *   project.json – plan, orientation and view state
 *   volume.raw   – the CBCT voxels (int16 little endian, x fastest)
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
    curve: Vec2[] | null;
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
    cutDepth?: number | null;
  };
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
      cutDepth: app.cutDepth,
    },
  };
  const json = new TextEncoder().encode(JSON.stringify(file, null, 1));
  const raw = new Uint8Array(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength);
  return writeZip(
    [
      { name: 'project.json', data: json },
      { name: 'volume.raw', data: raw },
    ],
    onProgress,
  );
}

export interface LoadedProject {
  volume: Volume;
  file: ProjectFile;
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
  return { volume: new Volume([nx, ny, nz], file.volume.spacing, data, file.volume.info), file };
}

/**
 * Restore the plan and view state. Call after app.setVolume(volume) and after
 * switching the layout to `file.state.mode`.
 */
export function applyProjectState(app: App, file: ProjectFile) {
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
  app.curve = st.curve ? new ArchCurve(st.curve) : null;
  app.s = st.s;
  app.focusC = st.focusC;
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
  app.cutDepth = st.cutDepth ?? null;
  app.activeSegId = st.activeSegId ?? null;
  app.activeNerveId = st.activeNerveId ?? null;
  const nerves = (st.nerves ?? []).map((n) => ({ ...n, pts: n.pts.map((p) => [...p] as Vec3) }));
  reserveNerveIds(Math.max(0, ...nerves.map((n) => n.id)));
  app.restoreSegmentation(st.segments ?? [], st.cuts ?? [], nerves);
  app.onWindowChange();
  app.changed();
}

