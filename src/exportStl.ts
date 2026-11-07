// "Export STL" dialog: 3D render surface at the current threshold, segments, implants, abutments
// and nerve canals as STL files (one per object in a ZIP, or all in one STL).

import type { App } from './app';
import { formatPatientName } from './dicomMeta';
import { Implant, implantParts } from './implant';
import { addScaled, fromFrame, Vec3 } from './math';
import { nervePath } from './nerve';
import type { CropSpec } from './render';
import { cropTester } from './segment';
import { scanWorld } from './scans';
import { invert } from './register';
import { ScalarGrid, Tris, concatTris, coneMesh, fillCavities, isoSurface, meshToTris, smoothMesh, stlBytes, transformTris, tubeMesh } from './stl';
import type { Volume } from './volume';
import { toothWorld } from './waxup/waxup';
import { writeZip } from './zip';

export interface ExportHooks {
  showLoading(text: string, f: number): void;
  hideLoading(): void;
  setStatus(msg: string, error?: boolean): void;
  deliver(blob: Blob, filename: string, type: { description: string; accept: Record<string, string[]> }): Promise<boolean>;
}

/** Keep sampled grids below this many samples (memory / time). */
export const MAX_SAMPLES = 60_000_000;

interface Item {
  key: string;
  label: string;
  /** file name part */
  name: string;
  checked: boolean;
  build: (opts: BuildOpts, progress: (f: number) => void) => Promise<Tris>;
}

interface BuildOpts {
  /** sampling step of bone surfaces in CT voxels (1 = full CT resolution) */
  step: number;
  solid: boolean;
  /** Taubin smoothing of bone surfaces */
  smooth: boolean;
}

const safe = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '_') || 'object';

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Field of the 3D render: inside ⇔ lo ≤ value ≤ hi (and inside the crop box). */
export function thresholdField(vol: Volume, lo: number, hi: number, crop: CropSpec | null, step: number): ScalarGrid {
  const { nx, ny, nz, spacing: sp, data } = vol;
  let lo3: Vec3 = [0, 0, 0];
  let hi3: Vec3 = [nx - 1, ny - 1, nz - 1];
  if (crop) {
    const mn: Vec3 = [Infinity, Infinity, Infinity];
    const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const q: Vec3 = [c & 1 ? crop.max[0] : crop.min[0], c & 2 ? crop.max[1] : crop.min[1], c & 4 ? crop.max[2] : crop.min[2]];
      const w = fromFrame(q, crop.origin, crop.frame);
      for (let a = 0; a < 3; a++) {
        mn[a] = Math.min(mn[a], w[a] / sp[a]);
        mx[a] = Math.max(mx[a], w[a] / sp[a]);
      }
    }
    lo3 = [0, 1, 2].map((a) => Math.max(0, Math.floor(mn[a]))) as Vec3;
    hi3 = [0, 1, 2].map((a, i) => Math.min([nx, ny, nz][i] - 1, Math.ceil(mx[a]))) as Vec3;
  }
  let st = step;
  const dims = () => [0, 1, 2].map((a) => Math.floor((hi3[a] - lo3[a]) / st) + 3);
  while (dims().reduce((x, y) => x * y, 1) > MAX_SAMPLES) st++;
  const [sx, sy, sz] = dims();
  const s = new Float32Array(sx * sy * sz).fill(-Infinity);
  const inCrop = cropTester(crop);
  const isoLo = lo - 0.5;
  const isoHi = hi + 0.5;
  const nxy = nx * ny;
  for (let c = 1; c < sz - 1; c++) {
    const k = lo3[2] + (c - 1) * st;
    if (k > hi3[2]) continue;
    for (let b = 1; b < sy - 1; b++) {
      const j = lo3[1] + (b - 1) * st;
      if (j > hi3[1]) continue;
      for (let a = 1; a < sx - 1; a++) {
        const i = lo3[0] + (a - 1) * st;
        if (i > hi3[0]) continue;
        if (crop && !inCrop(i * sp[0], j * sp[1], k * sp[2])) continue;
        const v = data[i + j * nx + k * nxy];
        s[a + b * sx + c * sx * sy] = Math.min(v - isoLo, isoHi - v);
      }
    }
  }
  return {
    nx: sx,
    ny: sy,
    nz: sz,
    s,
    origin: [(lo3[0] - st) * sp[0], (lo3[1] - st) * sp[1], (lo3[2] - st) * sp[2]],
    step: [st * sp[0], st * sp[1], st * sp[2]],
  };
}

async function surface(g: ScalarGrid | null, opts: BuildOpts, progress: (f: number) => void): Promise<Tris> {
  if (!g) return new Float32Array(0);
  if (opts.solid) fillCavities(g);
  const mesh = await isoSurface(g, (f) => progress(opts.smooth ? f * 0.8 : f));
  if (opts.smooth) await smoothMesh(mesh, 12, 0.5, -0.53, (f) => progress(0.8 + 0.2 * f));
  return meshToTris(mesh);
}

function implantSolid(app: App, imp: Implant, kind: 'implant' | 'abutment'): Tris {
  const shown = { ...imp, hidden: false, abutmentHidden: false };
  const parts = implantParts(shown, app.abutmentDir(shown)).filter((p) => p.kind === kind);
  return concatTris(
    parts.map((p) => coneMesh(addScaled(p.center, p.axis, -p.half), addScaled(p.center, p.axis, p.half), p.r0, p.r1)),
  );
}

function collectItems(app: App): { groups: { title: string; items: Item[] }[]; base: string } {
  const vol = app.vol!;
  const groups: { title: string; items: Item[] }[] = [];
  const segs = app.seg.segments.filter((s) => s.voxels > 0);

  const lo = app.vr.lo;
  const hi = Math.max(app.vr.lo + 1, app.vr.hi);
  const crop = app.cropIsFull() ? null : app.cropSpec();
  groups.push({
    title: '3D render',
    items: [
      {
        key: 'render',
        label: `Surface at the current threshold (${lo} – ${hi}${crop ? ', inside the crop box' : ''})`,
        name: `3D_surface_${lo}-${hi}`,
        checked: segs.length === 0,
        build: (o, pr) => surface(thresholdField(vol, lo, hi, crop, o.step), o, pr),
      },
    ],
  });
  if (segs.length)
    groups.push({
      title: 'Segments',
      items: segs.map((sg) => ({
        key: `seg${sg.id}`,
        label: sg.name,
        name: sg.name,
        checked: true,
        build: (o, pr) => surface(app.seg.segmentField(sg, o.step, MAX_SAMPLES), o, pr),
      })),
    });
  if (app.implants.length) {
    const items: Item[] = [];
    for (const imp of app.implants) {
      const nm = imp.name || `Implant ${imp.id}`;
      const dims = `Ø${imp.diameter.toFixed(1)}${imp.apicalDiameter != null ? `/${imp.apicalDiameter.toFixed(1)}` : ''} × ${imp.length.toFixed(1)} mm`;
      items.push({
        key: `imp${imp.id}`,
        label: `${nm} (${dims})`,
        name: nm,
        checked: !imp.hidden,
        build: async () => implantSolid(app, imp, 'implant'),
      });
      if (imp.abutment)
        items.push({
          key: `ab${imp.id}`,
          label: `MUA on ${nm} (GH ${imp.abutment.gingivalHeight} mm${imp.abutment.angle ? `, ${imp.abutment.angle}°` : ''})`,
          name: `${nm}_MUA`,
          checked: !imp.hidden && !imp.abutmentHidden,
          build: async () => implantSolid(app, imp, 'abutment'),
        });
    }
    groups.push({ title: 'Implants & abutments', items });
  }
  const placedScans = app.scans.filter((sc) => sc.transform);
  if (placedScans.length)
    groups.push({
      title: 'Intraoral scans (aligned)',
      items: placedScans.map((sc) => ({
        key: `scan${sc.id}`,
        label: `${sc.name} (${(sc.mesh.idx.length / 3).toLocaleString()} triangles)`,
        name: sc.name,
        checked: sc.visible,
        build: async () => {
          const w = scanWorld(sc)!;
          const idx = sc.mesh.idx;
          const out = new Float32Array(idx.length * 3);
          for (let t = 0; t < idx.length; t++) {
            const v = idx[t] * 3;
            out[t * 3] = w.pos[v];
            out[t * 3 + 1] = w.pos[v + 1];
            out[t * 3 + 2] = w.pos[v + 2];
          }
          return out;
        },
      })),
    });
  const wax = app.wax.model.teeth;
  if (wax.length)
    groups.push({
      title: 'Waxup',
      items: (['upper', 'lower'] as const)
        .map((jaw) => ({ jaw, teeth: wax.filter((t) => t.jaw === jaw) }))
        .filter((j) => j.teeth.length)
        .map(({ jaw, teeth }) => ({
          key: `wax-${jaw}`,
          label: `${jaw === 'upper' ? 'Upper' : 'Lower'} teeth (${teeth.map((t) => t.fdi).sort((a, b) => a - b).join(', ')})`,
          name: `Waxup_${jaw}`,
          checked: app.wax.visible[jaw],
          build: async () =>
            concatTris(
              teeth.map((t) => {
                const w = toothWorld(t);
                const out = new Float32Array(t.idx.length * 3);
                for (let i = 0; i < t.idx.length; i++) out.set(w.pos.subarray(t.idx[i] * 3, t.idx[i] * 3 + 3), i * 3);
                return out;
              }),
            ),
        })),
    });
  const nerves = app.nerves.filter((n) => n.pts.length >= 2);
  if (nerves.length)
    groups.push({
      title: 'Nerve canals',
      items: nerves.map((n) => ({
        key: `nerve${n.id}`,
        label: `${n.name} (Ø${n.diameter.toFixed(1)} mm)`,
        name: n.name,
        checked: n.visible,
        build: async () => tubeMesh(nervePath(n), n.diameter / 2),
      })),
    });
  const who = formatPatientName(vol.info.patientName);
  return { groups, base: who ? safe(who.replace(',', '')) : 'scan' };
}

let modal: HTMLDivElement | null = null;

/** `preset.scanId`: that scan + all implants and abutments, in that scan's own coordinates. */
export function showExportStl(app: App, hooks: ExportHooks, preset?: { scanId: number }) {
  if (!app.vol) {
    hooks.setStatus('Open a CBCT first.', true);
    return;
  }
  const { groups, base } = collectItems(app);
  const all = groups.flatMap((g) => g.items);
  modal?.remove();
  modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal export-stl" role="dialog" aria-modal="true" aria-labelledby="xs-title">
      <header>
        <h2 id="xs-title">Export STL</h2>
        <button class="modal-close" title="Close (Esc)">×</button>
      </header>
      <p class="muted">${
        app.vol.info.patientAffine
          ? 'Millimetres, in the <b>original DICOM patient coordinates</b> (LPS, as in the DICOM files) – the STL files line up with this CBCT in other software (exocad, 3Shape, Blue Sky Plan, 3D Slicer …) and with each other.'
          : 'Millimetres, in this scan’s own coordinates – the files line up with each other. (This scan has no DICOM position information, so the original DICOM coordinates are not available.)'
      }</p>
      ${groups
        .map(
          (g) => `<h4>${esc(g.title)}</h4>
        ${g.items.map((it) => `<label class="check"><input type="checkbox" data-k="${it.key}" ${it.checked ? 'checked' : ''}/> ${esc(it.label)}</label>`).join('')}`,
        )
        .join('')}
      <h4>Coordinates</h4>
      <label class="check">Export in
        <select id="xs-coords">
          <option value="dicom">${app.vol.info.patientAffine ? 'CBCT – DICOM patient coordinates' : 'CBCT coordinates'}</option>
          ${app.scans
            .filter((sc) => sc.transform)
            .map((sc) => `<option value="scan${sc.id}" ${preset?.scanId === sc.id ? 'selected' : ''}>Intraoral scan: ${esc(sc.name)} (coordinates of its file)</option>`)
            .join('')}
        </select>
      </label>
      <p class="muted small" id="xs-coords-note"></p>
      <h4>Options</h4>
      <label class="check">Detail of bone surfaces
        <select id="xs-step">
          <option value="1" selected>High – full CT resolution</option>
          <option value="2">Medium (≈ 4× smaller files)</option>
          <option value="3">Low (≈ 9× smaller files)</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="xs-smooth" checked /> Smooth surfaces (removes the voxel staircase, keeps the size)</label>
      <label class="check"><input type="checkbox" id="xs-solid" checked /> Solid models (fill closed hollow spaces inside the bone)</label>
      <label class="check"><input type="radio" name="xs-files" value="zip" checked /> One STL file per object (ZIP)</label>
      <label class="check"><input type="radio" name="xs-files" value="one" /> Everything in one STL file</label>
      <footer><span class="muted small" id="xs-info"></span><button class="primary" id="xs-go">Export</button></footer>
    </div>`;
  document.body.append(modal);
  const m = modal;
  const close = () => {
    m.remove();
    if (modal === m) modal = null;
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  m.addEventListener('pointerdown', (e) => {
    if (e.target === m) close();
  });
  m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = close;
  const info = m.querySelector<HTMLSpanElement>('#xs-info')!;
  const selected = () => all.filter((it) => m.querySelector<HTMLInputElement>(`input[data-k="${it.key}"]`)?.checked);
  const updateInfo = () => {
    const n = selected().length;
    info.textContent = n ? `${n} object${n > 1 ? 's' : ''} selected` : 'Nothing selected';
    m.querySelector<HTMLButtonElement>('#xs-go')!.disabled = !n;
  };
  const coordsSel = m.querySelector<HTMLSelectElement>('#xs-coords')!;
  const coordsScan = () => app.scans.find((sc) => `scan${sc.id}` === coordsSel.value && sc.transform) ?? null;
  const updateCoords = () => {
    const sc = coordsScan();
    m.querySelector('#xs-coords-note')!.textContent = sc
      ? `Everything is placed in the coordinate system of “${sc.fileName}”: the scan comes out exactly as in its original file, and the implants and abutments line up with that file in lab / guide-design software.`
      : 'The files line up with the CBCT (and with each other) in other software.';
  };
  coordsSel.onchange = updateCoords;
  updateCoords();
  if (preset) {
    for (const cb of m.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-k]'))
      cb.checked = cb.dataset.k === `scan${preset.scanId}` || /^(imp|ab)\d+$/.test(cb.dataset.k ?? '');
  }
  m.addEventListener('change', updateInfo);
  updateInfo();

  m.querySelector<HTMLButtonElement>('#xs-go')!.onclick = async () => {
    const items = selected();
    const opts: BuildOpts = {
      step: Number(m.querySelector<HTMLSelectElement>('#xs-step')!.value) || 1,
      solid: m.querySelector<HTMLInputElement>('#xs-solid')!.checked,
      smooth: m.querySelector<HTMLInputElement>('#xs-smooth')!.checked,
    };
    const combined = m.querySelector<HTMLInputElement>('input[name="xs-files"][value="one"]')!.checked;
    const inScan = coordsScan();
    close();
    // world -> output coordinates: DICOM patient (LPS), or the chosen scan's file coordinates
    const affine = inScan ? invert(inScan.transform!) : app.vol?.info.patientAffine;
    const space = !inScan && affine ? 'LPS' : null;
    try {
      const meshes: { name: string; tris: Tris }[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const label = `Building ${it.label}…`;
        hooks.showLoading(label, i / items.length);
        await new Promise((r) => setTimeout(r, 0));
        const tris = await it.build(opts, (f) => hooks.showLoading(label, (i + f) / items.length));
        if (affine) transformTris(tris, affine);
        if (tris.length) meshes.push({ name: it.name, tris });
      }
      if (!meshes.length) {
        hooks.setStatus('Nothing to export – the selected objects are empty.', true);
        return;
      }
      const totalTris = meshes.reduce((a, x) => a + x.tris.length / 9, 0);
      hooks.showLoading('Writing STL…', 0.95);
      await new Promise((r) => setTimeout(r, 0));
      let blob: Blob;
      let filename: string;
      let type: { description: string; accept: Record<string, string[]> };
      const stlType = { description: 'STL mesh', accept: { 'model/stl': ['.stl'] } };
      if (combined || meshes.length === 1) {
        const tris = meshes.length === 1 ? meshes[0].tris : concatTris(meshes.map((x) => x.tris));
        const nm = meshes.length === 1 ? meshes[0].name : 'export';
        blob = new Blob([stlBytes(tris, nm, space) as BlobPart], { type: 'model/stl' });
        filename = `${base}_${safe(nm)}.stl`;
        type = stlType;
      } else {
        const used = new Set<string>();
        const entries = meshes.map((x) => {
          let fn = `${base}_${safe(x.name)}.stl`;
          for (let n = 2; used.has(fn); n++) fn = `${base}_${safe(x.name)}_${n}.stl`;
          used.add(fn);
          return { name: fn, data: stlBytes(x.tris, x.name, space) };
        });
        blob = await writeZip(entries, (f) => hooks.showLoading('Compressing…', 0.95 + 0.05 * f));
        filename = `${base}_STL${inScan ? `_${safe(inScan.name)}-coords` : ''}.zip`;
        type = { description: 'ZIP of STL files', accept: { 'application/zip': ['.zip'] } };
      }
      hooks.hideLoading();
      const ok = await hooks.deliver(blob, filename, type);
      hooks.setStatus(
        ok
          ? `Exported ${meshes.length} object${meshes.length > 1 ? 's' : ''} (${Math.round(totalTris).toLocaleString()} triangles) as ${filename} – ${(blob.size / 1e6).toFixed(1)} MB, ${affine ? 'DICOM patient coordinates' : 'scan coordinates'}`
          : 'Export cancelled',
      );
    } catch (e) {
      console.error(e);
      hooks.setStatus(`STL export failed: ${(e as Error).message}`, true);
    } finally {
      hooks.hideLoading();
    }
  };
}
