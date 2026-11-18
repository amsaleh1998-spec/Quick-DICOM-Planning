// Placing intraoral scans in the CBCT: placement dialog (original position, copy the alignment of
// another scan, or align) and the alignment workspace (points / surfaces, like Blue Sky Plan,
// RealGuide, exoplan or coDiagnostiX).

import type { App } from './app';
import { MAX_SAMPLES, thresholdField } from './exportStl';
import type { Vec3 } from './math';
import { vertexNormals } from './meshio';
import { Marker, MeshViewer, ViewerMesh } from './meshViewer';
import {
  Affine, FitStats, Target, apply, fitRigid, fitStats, globalMatch, icp, scanOcclusalAxis, subsample, subsampleSame, thinPoints,
} from './register';
import { SCAN_KINDS, Scan, ScanKind, guessJaw, originalTransform, placementLabel, scanNormals } from './scans';
import { fillCavities, isoSurface, smoothMesh } from './stl';

export interface AlignHooks {
  setStatus(msg: string, error?: boolean): void;
  showLoading(text: string, f: number): void;
  hideLoading(): void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function modalShell(cls: string, html: string, onClose?: () => void): { root: HTMLDivElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(root);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  const close = () => {
    onClose?.();
    root.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  window.addEventListener('keydown', onKey, true);
  return { root, close };
}

// ---- placement dialog ----------------------------------------------------------------

/** Ask how to place a (new or existing) scan. */
export function showPlacement(app: App, scan: Scan, hooks: AlignHooks) {
  const aligned = app.scans.filter((s) => s !== scan && s.transform);
  const hasDicom = !!app.vol?.info.patientAffine;
  const { root, close } = modalShell(
    'scan-place',
    `<header><h2>Place “${esc(scan.name)}”</h2><button class="modal-close" title="Close (Esc)">×</button></header>
    <p class="muted">${esc(scan.fileName)} · ${(scan.mesh.idx.length / 3).toLocaleString()} triangles</p>
    <label class="row">Type
      <select id="pl-kind">${SCAN_KINDS.map((k) => `<option value="${k.kind}" ${k.kind === scan.kind ? 'selected' : ''}>${k.label}</option>`).join('')}</select>
    </label>
    <label class="check opt"><input type="radio" name="pl" value="align" checked />
      <span><b>Align to the CBCT</b> – choose matching points or surfaces on the scan and on the CBCT.</span></label>
    <label class="check opt ${aligned.length ? '' : 'disabled'}"><input type="radio" name="pl" value="copy" ${aligned.length ? '' : 'disabled'} />
      <span><b>Copy the alignment of</b>
        <select id="pl-copy" ${aligned.length ? '' : 'disabled'}>${aligned.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') || '<option>no aligned scan yet</option>'}</select><br />
        <span class="muted">Scans exported from the same scanner session (upper, lower, bite) share one coordinate system, and a wax-up usually keeps the coordinates of its jaw scan – so they line up with the scan that is already aligned.</span></span></label>
    <label class="check opt"><input type="radio" name="pl" value="original" />
      <span><b>Original position</b> – the file is already in this CBCT’s coordinates${hasDicom ? ' (DICOM patient coordinates, e.g. exported from Quick DICOM Planning or another planning software)' : ' (this scan has no DICOM position information: its own coordinates are used)'}.</span></label>
    <footer><span></span><button class="primary" id="pl-go">Continue</button></footer>`,
  );
  root.querySelector<HTMLButtonElement>('.modal-close')!.onclick = close;
  const kindSel = root.querySelector<HTMLSelectElement>('#pl-kind')!;
  kindSel.onchange = () => {
    const k = SCAN_KINDS.find((x) => x.kind === kindSel.value)!;
    const wasDefault = SCAN_KINDS.some((x) => x.kind === scan.kind && x.color.join() === scan.color.join());
    scan.kind = kindSel.value as ScanKind;
    if (wasDefault) scan.color = [...k.color];
    if (/^(Upper jaw|Lower jaw|Antagonist|Wax-up|Other)/.test(scan.name)) scan.name = k.label + scan.name.replace(/^(Upper jaw|Lower jaw|Antagonist|Wax-up|Other)/, '');
    app.changed();
  };
  root.querySelector<HTMLButtonElement>('#pl-go')!.onclick = () => {
    const how = root.querySelector<HTMLInputElement>('input[name="pl"]:checked')!.value;
    close();
    if (how === 'original') {
      scan.transform = originalTransform(app.vol?.info.patientAffine);
      scan.placement = { method: 'original' };
      hooks.setStatus(`${scan.name}: placed in its original position.`);
      app.changed();
    } else if (how === 'copy') {
      const src = app.scans.find((s) => s.id === Number(root.querySelector<HTMLSelectElement>('#pl-copy')!.value));
      if (src?.transform) {
        scan.transform = src.transform.slice();
        scan.placement = { method: 'copy', from: src.name };
        hooks.setStatus(`${scan.name}: copied the alignment of ${src.name}.`);
        app.changed();
      }
    } else showAlignment(app, scan, hooks);
  };
}

// ---- CBCT target surfaces -------------------------------------------------------------

interface TargetChoice {
  key: string;
  label: string;
  /** the automatic segmentation's class (3 = upper teeth, 4 = lower teeth …) */
  aiCls?: number;
  build: (progress: (f: number) => void) => Promise<{ pos: Float32Array; idx: Uint32Array } | null>;
}

function targetChoices(app: App): TargetChoice[] {
  const vol = app.vol!;
  const out: TargetChoice[] = [];
  for (const sg of app.seg.segments.filter((s) => s.voxels > 0)) {
    out.push({
      key: `seg${sg.id}`,
      label: `Segment: ${sg.name}`,
      aiCls: sg.ai?.cls,
      build: async (pr) => {
        // full CT resolution, smoothed (same quality as the High STL export)
        const g = app.seg.segmentField(sg, 1, MAX_SAMPLES);
        if (!g) return null;
        fillCavities(g);
        const m = await isoSurface(g, (f) => pr(f * 0.8));
        await smoothMesh(m, 10, 0.5, -0.53, (f) => pr(0.8 + f * 0.2));
        return m;
      },
    });
  }
  const lo = app.vr.lo;
  const hi = Math.max(app.vr.lo + 1, app.vr.hi);
  const crop = app.cropIsFull() ? null : app.cropSpec();
  out.push({
    key: 'render',
    label: `3D render at the current threshold (${lo} – ${hi}${crop ? ', inside the crop box' : ''})`,
    build: async (pr) => {
      const g = thresholdField(vol, lo, hi, crop, 1);
      fillCavities(g);
      const m = await isoSurface(g, (f) => pr(f * 0.8));
      await smoothMesh(m, 10, 0.5, -0.53, (f) => pr(0.8 + f * 0.2));
      return m;
    },
  });
  return out;
}

// ---- alignment workspace --------------------------------------------------------------

interface Pair {
  scan?: Vec3;
  world?: Vec3;
}

const PAINT: [number, number, number] = [255, 140, 40];

/** Painted selection on a viewer mesh: vertex mask + colours, with a hashed vertex grid for the brush. */
class PaintLayer {
  readonly mask: Uint8Array;
  count = 0;
  private col: Uint8Array;
  private start: Uint32Array;
  private items: Uint32Array;
  private static CELL = 1.5;
  private static BUCKETS = 1 << 20;
  constructor(
    private mesh: ViewerMesh,
    private viewer: MeshViewer,
    private base: Uint8Array,
  ) {
    const P = mesh.pos;
    const n = P.length / 3;
    this.mask = new Uint8Array(n);
    this.col = base.slice();
    mesh.col = this.col;
    // CSR buckets of vertex indices
    const B = PaintLayer.BUCKETS;
    const cnt = new Uint32Array(B + 1);
    const bucketOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const b = this.bucket(Math.floor(P[i * 3] / PaintLayer.CELL), Math.floor(P[i * 3 + 1] / PaintLayer.CELL), Math.floor(P[i * 3 + 2] / PaintLayer.CELL));
      bucketOf[i] = b;
      cnt[b + 1]++;
    }
    for (let b = 0; b < B; b++) cnt[b + 1] += cnt[b];
    this.start = cnt.slice();
    this.items = new Uint32Array(n);
    const fill = cnt.slice(0, B);
    for (let i = 0; i < n; i++) this.items[fill[bucketOf[i]]++] = i;
  }
  private bucket(x: number, y: number, z: number) {
    return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (PaintLayer.BUCKETS - 1);
  }
  /** Paint (or erase) every vertex within r mm of p. */
  paint(p: Vec3, r: number, erase: boolean) {
    const P = this.mesh.pos;
    const C = PaintLayer.CELL;
    const r2 = r * r;
    const n = Math.ceil(r / C);
    const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C), cz = Math.floor(p[2] / C);
    for (let dx = -n; dx <= n; dx++)
      for (let dy = -n; dy <= n; dy++)
        for (let dz = -n; dz <= n; dz++) {
          const b = this.bucket(cx + dx, cy + dy, cz + dz);
          for (let k = this.start[b]; k < this.start[b + 1]; k++) {
            const i = this.items[k];
            const d2 = (P[i * 3] - p[0]) ** 2 + (P[i * 3 + 1] - p[1]) ** 2 + (P[i * 3 + 2] - p[2]) ** 2;
            if (d2 > r2 || (erase ? !this.mask[i] : this.mask[i])) continue;
            this.mask[i] = erase ? 0 : 1;
            this.count += erase ? -1 : 1;
            for (let c = 0; c < 3; c++)
              this.col[i * 3 + c] = erase ? this.base[i * 3 + c] : Math.round(this.base[i * 3 + c] * 0.35 + PAINT[c] * 0.65);
          }
        }
    this.viewer.updateColors(this.mesh, this.col);
  }
  /** Select the vertices within each patch (centre, radius); the active patch is tinted brighter. */
  setPatches(patches: { c: Vec3; r: number }[], active: number) {
    this.mask.fill(0);
    this.count = 0;
    this.col.set(this.base);
    const P = this.mesh.pos;
    const C = PaintLayer.CELL;
    patches.forEach((pt, pi) => {
      const tint = pi === active ? [255, 120, 20] : PAINT;
      const mix = pi === active ? 0.75 : 0.6;
      const r2 = pt.r * pt.r;
      const n = Math.ceil(pt.r / C);
      const cx = Math.floor(pt.c[0] / C), cy = Math.floor(pt.c[1] / C), cz = Math.floor(pt.c[2] / C);
      for (let dx = -n; dx <= n; dx++)
        for (let dy = -n; dy <= n; dy++)
          for (let dz = -n; dz <= n; dz++) {
            const b = this.bucket(cx + dx, cy + dy, cz + dz);
            for (let k = this.start[b]; k < this.start[b + 1]; k++) {
              const i = this.items[k];
              const d2 = (P[i * 3] - pt.c[0]) ** 2 + (P[i * 3 + 1] - pt.c[1]) ** 2 + (P[i * 3 + 2] - pt.c[2]) ** 2;
              if (d2 > r2) continue;
              if (!this.mask[i]) this.count++;
              this.mask[i] = 1;
              for (let c = 0; c < 3; c++) this.col[i * 3 + c] = Math.round(this.base[i * 3 + c] * (1 - mix) + tint[c] * mix);
            }
          }
    });
    this.viewer.updateColors(this.mesh, this.col);
  }

  clear() {
    this.mask.fill(0);
    this.count = 0;
    this.col.set(this.base);
    this.viewer.updateColors(this.mesh, this.col);
  }
  /** Painted vertices (and their normals) as flat arrays, plus their centroid. */
  selection(nrm: Float32Array): { pos: Float32Array; nrm: Float32Array; center: Vec3 } {
    const P = this.mesh.pos;
    const pos = new Float32Array(this.count * 3);
    const nn = new Float32Array(this.count * 3);
    const c: Vec3 = [0, 0, 0];
    let o = 0;
    for (let i = 0; i < this.mask.length; i++) {
      if (!this.mask[i]) continue;
      for (let k = 0; k < 3; k++) {
        pos[o + k] = P[i * 3 + k];
        nn[o + k] = nrm[i * 3 + k];
        c[k] += P[i * 3 + k];
      }
      o += 3;
    }
    const n = Math.max(1, this.count);
    return { pos, nrm: nn, center: [c[0] / n, c[1] / n, c[2] / n] };
  }
}

export function showAlignment(app: App, scan: Scan, hooks: AlignHooks) {
  if (!app.vol) return;
  const choices = targetChoices(app);
  // the jaw: from the type, or from the name (e.g. "Waxup_lower.stl")
  const jaw = scan.kind === 'upper' || scan.kind === 'lower' ? scan.kind : guessJaw(`${scan.fileName} ${scan.name}`);
  const defaultJaw = jaw ?? 'upper';
  // align to that jaw's teeth from the automatic segmentation (the surfaces an intraoral scan
  // shows); otherwise a segment named like the jaw; otherwise the 3D render
  const want = defaultJaw === 'upper' ? /maxill|upper/i : /mandib|lower/i;
  const teeth = jaw ? choices.find((c) => c.aiCls === (jaw === 'upper' ? 3 : 4)) : undefined;
  const defChoice = teeth ?? choices.find((c) => want.test(c.label)) ?? choices[choices.length - 1];
  const { root, close } = modalShell(
    'scan-align',
    `<header>
      <h2>Align “${esc(scan.name)}” to the CBCT</h2>
      <div class="sa-tabs" role="tablist">
        <button data-mode="points" class="active">Points</button>
        <button data-mode="surface">Surfaces</button>
      </div>
      <button class="modal-close" title="Cancel (Esc)">×</button>
    </header>
    <div class="sa-bar">
      <label>CBCT surface <select id="sa-target">${choices.map((c) => `<option value="${c.key}" ${c === defChoice ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
      <label>Jaw <select id="sa-jaw"><option value="upper" ${defaultJaw === 'upper' ? 'selected' : ''}>Upper</option><option value="lower" ${defaultJaw === 'lower' ? 'selected' : ''}>Lower</option></select></label>
      <span class="sa-surface-only small" id="sa-patch-info"></span>
      <button id="sa-undo-patch" class="sa-surface-only">Undo patch</button>
      <button id="sa-clear-paint" class="sa-surface-only">Clear patches</button>
      <button id="sa-undo" class="sa-points-only">Undo point</button>
      <button id="sa-clear-pts" class="sa-points-only">Clear points</button>
    </div>
    <div class="sa-panes"></div>
    <div class="sa-help muted small" id="sa-help"></div>
    <footer>
      <span id="sa-result" class="small"></span>
      <span class="sa-actions">
        <label class="check small sa-points-only"><input type="checkbox" id="sa-refine" checked /> Refine on the surface</label>
        <button id="sa-match" class="primary">Match</button>
        <button id="sa-accept" class="primary hidden">Accept</button>
      </span>
    </footer>`,
    () => {
      left.dispose();
      right.dispose();
    },
  );
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const panes = $('.sa-panes');
  const left = new MeshViewer('Intraoral scan');
  const right = new MeshViewer('CBCT');
  panes.append(left.el, right.el);
  let mode: 'points' | 'surface' = 'points'; // pairs of points by default; surfaces on the other tab
  // surface patches: patch i on the scan corresponds to patch i on the CBCT
  type Patch = { c: Vec3; r: number };
  const scanPatches: Patch[] = [];
  const cbctPatches: Patch[] = [];
  const patchClicks: ('scan' | 'cbct')[] = [];
  let activeScan = -1;
  let activeCbct = -1;
  let patchR = 3;
  const pairs: Pair[] = [];
  const clicks: ('scan' | 'world')[] = [];
  const nv = scan.mesh.pos.length / 3;
  let target: Target | null = null;
  let targetMesh: ViewerMesh | null = null;
  let targetLabel = '';
  let result: { T: Affine; stats: FitStats; method: 'points' | 'surface' } | null = null;
  let busy = false;

  // scan pane mesh (scan coordinates); vertex colours carry the painting
  const baseCol = new Uint8Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const c = scan.vertexColors && scan.mesh.col ? [scan.mesh.col[i * 3], scan.mesh.col[i * 3 + 1], scan.mesh.col[i * 3 + 2]] : scan.color;
    baseCol[i * 3] = c[0];
    baseCol[i * 3 + 1] = c[1];
    baseCol[i * 3 + 2] = c[2];
  }
  const scanMesh: ViewerMesh = {
    key: 'scan', pos: scan.mesh.pos, nrm: scanNormals(scan.mesh), idx: scan.mesh.idx, col: null, color: scan.color,
    opacity: 1, vertexColors: true, pickable: true,
  };
  left.setMeshes([scanMesh]);
  const occ = scanOcclusalAxis(scan.mesh.pos, scanMesh.nrm);
  left.fit([-occ.axis[0], -occ.axis[1], -occ.axis[2]]);

  const scanPaint = new PaintLayer(scanMesh, left, baseCol);
  left.updateColors(scanMesh, scanMesh.col!);
  let targetPaint: PaintLayer | null = null;
  const refreshPatches = () => {
    scanPaint.setPatches(scanPatches, activeScan);
    targetPaint?.setPatches(cbctPatches, activeCbct);
    markers();
    update();
  };
  /** Click on a surface in Surfaces mode: select the patch under it, or add a new one. */
  const patchClick = (side: 'scan' | 'cbct', p: Vec3) => {
    clearResult();
    const list = side === 'scan' ? scanPatches : cbctPatches;
    let i = list.findIndex((q) => Math.hypot(p[0] - q.c[0], p[1] - q.c[1], p[2] - q.c[2]) < q.r);
    if (i < 0) {
      list.push({ c: p, r: patchR });
      patchClicks.push(side);
      i = list.length - 1;
    }
    if (side === 'scan') activeScan = i;
    else activeCbct = i;
    refreshPatches();
  };
  /** Wheel over a pane in Surfaces mode: grow (scroll up) or shrink the selected patch of that side. */
  const patchWheel = (side: 'scan' | 'cbct', dir: number): boolean => {
    if (mode !== 'surface') return false;
    const list = side === 'scan' ? scanPatches : cbctPatches;
    const pt = list[side === 'scan' ? activeScan : activeCbct];
    if (!pt) return false;
    clearResult();
    pt.r = Math.min(20, Math.max(0.5, pt.r * Math.exp(-dir * 0.12)));
    patchR = pt.r;
    refreshPatches();
    return true;
  };
  /** Press inside a patch and drag: the patch slides along the surface (fine-tuning its position). */
  let grabbed: { side: 'scan' | 'cbct'; i: number; off: Vec3 } | null = null;
  const patchGrab = (side: 'scan' | 'cbct', p: Vec3): boolean => {
    if (mode !== 'surface') return false;
    const list = side === 'scan' ? scanPatches : cbctPatches;
    const i = list.findIndex((q) => Math.hypot(p[0] - q.c[0], p[1] - q.c[1], p[2] - q.c[2]) < q.r);
    if (i < 0) return false;
    grabbed = { side, i, off: [list[i].c[0] - p[0], list[i].c[1] - p[1], list[i].c[2] - p[2]] };
    if (side === 'scan') activeScan = i;
    else activeCbct = i;
    return true;
  };
  const patchMove = (p: Vec3) => {
    if (!grabbed) return;
    clearResult();
    const list = grabbed.side === 'scan' ? scanPatches : cbctPatches;
    list[grabbed.i].c = [p[0] + grabbed.off[0], p[1] + grabbed.off[1], p[2] + grabbed.off[2]];
    if (grabbed.side === 'scan') scanPaint.setPatches(scanPatches, activeScan);
    else targetPaint?.setPatches(cbctPatches, activeCbct);
    markers();
  };
  left.onGrab = (p) => patchGrab('scan', p);
  right.onGrab = (p) => patchGrab('cbct', p);
  left.onGrabMove = right.onGrabMove = patchMove;
  left.onGrabEnd = right.onGrabEnd = () => {
    grabbed = null;
    refreshPatches();
  };
  left.onWheel = (dir) => patchWheel('scan', dir);
  right.onWheel = (dir) => patchWheel('cbct', dir);

  const markers = () => {
    const lm: Marker[] = [];
    const rm: Marker[] = [];
    if (mode === 'surface') {
      scanPatches.forEach((q, i) => lm.push({ p: q.c, label: String(i + 1), color: i === activeScan ? '#7cc4ff' : cbctPatches[i] ? '#5fd38d' : '#ffd166' }));
      if (!result) cbctPatches.forEach((q, i) => rm.push({ p: q.c, label: String(i + 1), color: i === activeCbct ? '#7cc4ff' : scanPatches[i] ? '#5fd38d' : '#ffd166' }));
      left.markers = lm;
      right.markers = rm;
      left.request();
      right.request();
      return;
    }
    pairs.forEach((p, i) => {
      const done = !!(p.scan && p.world);
      const color = done ? '#5fd38d' : '#ffd166';
      if (p.scan) lm.push({ p: p.scan, label: String(i + 1), color });
      if (p.world && !result) rm.push({ p: p.world, label: String(i + 1), color });
    });
    left.markers = lm;
    right.markers = rm;
    left.request();
    right.request();
  };
  const complete = () => pairs.filter((p) => p.scan && p.world) as { scan: Vec3; world: Vec3 }[];

  left.onPick = (p) => {
    if (mode === 'surface') return patchClick('scan', p);
    clearResult();
    const open = pairs.find((q) => !q.scan);
    if (open) open.scan = p;
    else pairs.push({ scan: p });
    clicks.push('scan');
    markers();
    update();
  };
  right.onPick = (p) => {
    if (!target) return;
    if (mode === 'surface') return patchClick('cbct', p);
    if (result) clearResult();
    const open = pairs.find((q) => !q.world);
    if (open) open.world = p;
    else pairs.push({ world: p });
    clicks.push('world');
    markers();
    update();
  };
  const setMode = (m: 'points' | 'surface') => {
    mode = m;
    root.querySelectorAll<HTMLButtonElement>('.sa-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    root.classList.toggle('mode-surface', m === 'surface');
    clearResult();
    markers();
    update();
  };
  root.querySelectorAll<HTMLButtonElement>('.sa-tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as 'points' | 'surface')));
  const update = () => {
    const n = complete().length;
    const help = $('#sa-help');
    const matchBtn = $<HTMLButtonElement>('#sa-match');
    if (busy) return;
    if (result) {
      help.innerHTML =
        'Check the fit: the scan is shown on the CBCT surface, coloured by distance – <b style="color:#5fd38d">green &lt; 0.3 mm</b>, <b style="color:#e6d250">yellow &lt; 0.6 mm</b>, <b style="color:#f0963c">orange &lt; 1 mm</b>, grey = farther (gingiva and soft tissue are normal there). Rotate the right view to inspect it. <b>Accept</b> keeps it; changing points or painting starts again.';
    } else if (mode === 'points') {
      help.innerHTML = `Click a point on the <b>scan</b>, then the <b>same point on the CBCT</b> (cusp tips, incisal edges, distinct fissures – spread over the arch). At least 3 pairs; 4–6 are better. ${n} pair${n === 1 ? '' : 's'} so far. Left drag = rotate, right drag = pan, wheel = zoom.`;
    } else {
      const pairsN = Math.min(scanPatches.length, cbctPatches.length);
      help.innerHTML = `<b>Click a tooth surface</b> on the scan to select a circular patch around it, <b>scroll</b> to make the circle bigger or smaller (Ctrl + scroll zooms). Then click <b>the same place on the CBCT</b> – patch 1 on the scan matches patch 1 on the CBCT. Use 3 or more patches on each side, spread over the arch (both molar regions and the front teeth), on surfaces visible in both (no gingiva, no metal artefacts). Drag a patch to fine-tune its position; click inside a patch to select it again. Scan: ${scanPatches.length} patch${scanPatches.length === 1 ? '' : 'es'} · CBCT: ${cbctPatches.length} · ${pairsN} matching. Then <b>Match</b> – only the selected surfaces are used.`;
      const pt = activeScan >= 0 ? scanPatches[activeScan] : null;
      const pc = activeCbct >= 0 ? cbctPatches[activeCbct] : null;
      $('#sa-patch-info').textContent = [pt ? `Scan patch ${activeScan + 1}: Ø ${(pt.r * 2).toFixed(1)} mm` : '', pc ? `CBCT patch ${activeCbct + 1}: Ø ${(pc.r * 2).toFixed(1)} mm` : '']
        .filter(Boolean)
        .join(' · ');
    }
    $<HTMLButtonElement>('#sa-undo-patch').disabled = !patchClicks.length;
    matchBtn.disabled = !target || (mode === 'points' ? n < 3 : !scanPatches.length);
    matchBtn.classList.toggle('hidden', !!result);
    $('#sa-accept').classList.toggle('hidden', !result);
    $<HTMLButtonElement>('#sa-undo').disabled = !clicks.length || !!result;
    $<HTMLButtonElement>('#sa-clear-pts').disabled = !pairs.length;
  };

  const clearResult = () => {
    if (!result) return;
    result = null;
    $('#sa-result').textContent = '';
    if (targetMesh) right.setMeshes([targetMesh]);
    markers();
  };

  $<HTMLButtonElement>('#sa-undo').onclick = () => {
    const last = clicks.pop();
    if (!last) return;
    for (let i = pairs.length - 1; i >= 0; i--) {
      if (pairs[i][last]) {
        delete pairs[i][last];
        if (!pairs[i].scan && !pairs[i].world) pairs.splice(i, 1);
        break;
      }
    }
    clearResult();
    markers();
    update();
  };
  $<HTMLButtonElement>('#sa-clear-pts').onclick = () => {
    pairs.length = 0;
    clicks.length = 0;
    clearResult();
    markers();
    update();
  };
  $<HTMLButtonElement>('#sa-clear-paint').onclick = () => {
    scanPatches.length = cbctPatches.length = patchClicks.length = 0;
    activeScan = activeCbct = -1;
    clearResult();
    refreshPatches();
  };
  $<HTMLButtonElement>('#sa-undo-patch').onclick = () => {
    const side = patchClicks.pop();
    if (!side) return;
    if (side === 'scan') {
      scanPatches.pop();
      activeScan = scanPatches.length - 1;
    } else {
      cbctPatches.pop();
      activeCbct = cbctPatches.length - 1;
    }
    clearResult();
    refreshPatches();
  };

  // ---- target surface
  const jawSel = $<HTMLSelectElement>('#sa-jaw');
  const occlusalWorld = (): Vec3 => {
    const z = app.frame[2];
    return jawSel.value === 'upper' ? [-z[0], -z[1], -z[2]] : [z[0], z[1], z[2]];
  };
  const loadTarget = async () => {
    const ch = choices.find((c) => c.key === $<HTMLSelectElement>('#sa-target').value)!;
    busy = true;
    right.setTitle(`CBCT – preparing ${ch.label}…`);
    $('#sa-help').textContent = 'Extracting the CBCT surface…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const m = await ch.build((f) => ($('#sa-help').textContent = `Extracting the CBCT surface at full resolution… ${Math.round(f * 100)} %`));
      if (!m || !m.idx.length) throw new Error('This surface is empty – adjust the threshold or the segment.');
      const nrm = vertexNormals(m.pos, m.idx);
      const thin = thinPoints(m.pos, nrm, 0.5);
      target = new Target(thin.pts, thin.nrm);
      targetLabel = ch.label;
      targetMesh = { key: `t-${ch.key}`, pos: m.pos, nrm, idx: m.idx, col: null, color: [226, 220, 205], opacity: 1, vertexColors: true, pickable: true };
      const tBase = new Uint8Array(m.pos.length);
      for (let i = 0; i < tBase.length; i += 3) (tBase[i] = 226), (tBase[i + 1] = 220), (tBase[i + 2] = 205);
      right.setMeshes([]);
      targetPaint = new PaintLayer(targetMesh, right, tBase);
      cbctPatches.length = 0;
      activeCbct = -1;
      for (let i = patchClicks.length - 1; i >= 0; i--) if (patchClicks[i] === 'cbct') patchClicks.splice(i, 1);
      // world pairs no longer lie on the new surface
      for (const p of pairs) delete p.world;
      for (let i = pairs.length - 1; i >= 0; i--) if (!pairs[i].scan) pairs.splice(i, 1);
      clicks.splice(0, clicks.length, ...pairs.map(() => 'scan' as const));
      result = null;
      right.setMeshes([targetMesh], true);
      viewTarget(ch.key);
      right.setTitle(`CBCT – ${ch.label}`);
    } catch (e) {
      right.setTitle('CBCT');
      hooks.setStatus((e as Error).message, true);
      $('#sa-help').textContent = (e as Error).message;
    } finally {
      busy = false;
      markers();
      update();
    }
  };
  /** Single jaw: look onto its occlusal surfaces (anterior up); 3D render (both jaws): from the front. */
  const viewTarget = (key: string) => {
    if (key === 'render') {
      const F = app.frame;
      right.fit([F[1][0], F[1][1], F[1][2]], [F[2][0], F[2][1], F[2][2]]);
    } else {
      const o = occlusalWorld();
      right.fit([-o[0], -o[1], -o[2]], [0, -1, 0]);
    }
  };
  $<HTMLSelectElement>('#sa-target').onchange = () => loadTarget();
  jawSel.onchange = () => {
    viewTarget($<HTMLSelectElement>('#sa-target').value);
    clearResult();
  };
  // test hook: the two viewers
  (root as unknown as { __viewers: MeshViewer[] }).__viewers = [left, right];
  // test hook: add a patch (scan coordinates / world)
  (root as unknown as { __addPatch: (side: 'scan' | 'cbct', c: Vec3, r: number) => void }).__addPatch = (side, c, r) => {
    patchR = r;
    patchClick(side, c);
  };
  // test hook: add an exactly known pair (scan coordinates, world)
  (root as unknown as { __addPair: (a: Vec3, b: Vec3) => void }).__addPair = (a, b) => {
    clearResult();
    pairs.push({ scan: a, world: b });
    clicks.push('scan', 'world');
    markers();
    update();
  };

  // ---- matching
  const showResult = (T: Affine, stats: FitStats, method: 'points' | 'surface') => {
    result = { T, stats, method };
    // scan in world with distance colours
    const P = scan.mesh.pos;
    const pos = new Float32Array(P.length);
    const tmp = new Float64Array(3);
    const col = new Uint8Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      apply(T, P[i], P[i + 1], P[i + 2], tmp);
      pos[i] = tmp[0];
      pos[i + 1] = tmp[1];
      pos[i + 2] = tmp[2];
      // distance to the surface: point-to-plane near it (the target points are ~0.5 mm apart)
      const tg = target!;
      const j = tg.tree.nearest(tmp[0], tmp[1], tmp[2], 4);
      let d = 9;
      if (j >= 0) {
        const q = j * 3;
        const plane = Math.abs((tmp[0] - tg.pts[q]) * tg.nrm[q] + (tmp[1] - tg.pts[q + 1]) * tg.nrm[q + 1] + (tmp[2] - tg.pts[q + 2]) * tg.nrm[q + 2]);
        d = Math.min(Math.sqrt(tg.tree.lastD2), plane);
      }
      const c = d < 0.3 ? [95, 211, 141] : d < 0.6 ? [230, 210, 80] : d < 1 ? [240, 150, 60] : [150, 150, 158];
      col[i] = c[0];
      col[i + 1] = c[1];
      col[i + 2] = c[2];
    }
    const nrm = vertexNormals(pos, scan.mesh.idx);
    const placed: ViewerMesh = { key: 'placed', pos, nrm, idx: scan.mesh.idx, col, color: scan.color, opacity: 1, vertexColors: true, pickable: false };
    right.setMeshes([{ ...targetMesh!, opacity: 0.55 }, placed]);
    markers();
    const pct = (stats.within05 * 100).toFixed(0);
    const sure = stats.within05 >= 0.8;
    $('#sa-result').innerHTML = `${sure ? '✓' : '⚠'} ${pct} % of the ${method === 'surface' ? 'selected' : 'matched'} area within 0.5 mm · RMS ${stats.rms.toFixed(2)} mm${
      sure ? '' : ' – <b>uncertain match</b>: add 1–2 matching points (scan, then CBCT) or paint more tooth surface, then Match again'
    }`;
    $('#sa-result').classList.toggle('warn', !sure);
    update();
  };

  $<HTMLButtonElement>('#sa-match').onclick = async () => {
    if (!target || busy) return;
    const pp = complete();
    busy = true;
    $<HTMLButtonElement>('#sa-match').disabled = true;
    const progress = (f: number) => ($('#sa-help').textContent = `Matching… ${Math.round(f * 100)} %`);
    progress(0);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const P = scan.mesh.pos;
      const N = scanMesh.nrm;
      const painted = scanPaint.mask;
      // painted CBCT areas: match only against those
      let tgt = target;
      const tSel = targetPaint && targetPaint.count >= 50 ? targetPaint.selection(targetMesh!.nrm) : null;
      if (tSel) {
        const thin = thinPoints(tSel.pos, tSel.nrm, 0.5);
        tgt = new Target(thin.pts, thin.nrm);
      }
      if (mode === 'points') {
        if (pp.length < 3) return;
        let T = fitRigid(pp.map((p) => p.scan), pp.map((p) => p.world));
        // surface points near the picked points (or the painted areas) for the refinement
        const src: number[] = [];
        const srcN: number[] = [];
        for (let i = 0; i < P.length; i += 3) {
          const near = scanPaint.count
            ? painted[i / 3] === 1
            : pp.some((p) => (P[i] - p.scan[0]) ** 2 + (P[i + 1] - p.scan[1]) ** 2 + (P[i + 2] - p.scan[2]) ** 2 < 64);
          if (near) {
            src.push(P[i], P[i + 1], P[i + 2]);
            srcN.push(N[i], N[i + 1], N[i + 2]);
          }
        }
        const sp = Float32Array.from(src);
        const fine = subsample(sp, 3000, 11);
        if ($<HTMLInputElement>('#sa-refine').checked && sp.length >= 30) {
          T = icp(fine, subsampleSame(sp, Float32Array.from(srcN), 3000, 11), T, tgt, { gate0: 2, iterations: 30, gate1: 0.6 });
        }
        showResult(T, fitStats(fine, T, target), 'points');
      } else {
        // the selected scan patches only
        const sel: number[] = [];
        const selN: number[] = [];
        for (let i = 0; i < nv; i++) {
          if (scanPaint.count && !painted[i]) continue;
          sel.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
          selN.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
        }
        const c = [0, 0, 0];
        for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) c[k] += P[i + k];
        // matching patches (same number on both sides): their centres pin the start position
        const k = Math.min(scanPatches.length, cbctPatches.length);
        let hints: { scan: Vec3[]; world: Vec3[] } | undefined = k
          ? { scan: scanPatches.slice(0, k).map((q) => q.c), world: cbctPatches.slice(0, k).map((q) => q.c) }
          : undefined;
        let note = '';
        if (hints && k >= 3) {
          // patch centres that cannot be fitted rigidly were numbered differently on the two sides
          const T0 = fitRigid(hints.scan, hints.world);
          const tmp3 = new Float64Array(3);
          const err = Math.sqrt(
            hints.scan.reduce((acc, q, i) => {
              apply(T0, q[0], q[1], q[2], tmp3);
              return acc + (tmp3[0] - hints!.world[i][0]) ** 2 + (tmp3[1] - hints!.world[i][1]) ** 2 + (tmp3[2] - hints!.world[i][2]) ** 2;
            }, 0) / k,
          );
          if (err > 4) {
            note = ` The patch centres do not correspond (${err.toFixed(1)} mm apart after fitting) – check that patch 1, 2, 3 … are the same places on both sides; searched automatically instead.`;
            hints = undefined;
          }
        }
        const res = await globalMatch(Float32Array.from(sel), Float32Array.from(selN), tgt, {
          scanOcclusal: occ.axis,
          occlusalConfident: occ.confident,
          scanCenter: c.map((v) => v / nv) as Vec3,
          targetOcclusal: occlusalWorld(),
          allowFlip: false,
          hints,
          onProgress: progress,
        });
        // fit of the selected scan surfaces, measured on the CBCT surface
        showResult(res.T, fitStats(subsample(Float32Array.from(sel), 3000, 11), res.T, target), 'surface');
        if (note) $('#sa-result').innerHTML += esc(note);
      }
    } catch (e) {
      console.error(e);
      $('#sa-result').textContent = `Matching failed: ${(e as Error).message}`;
    } finally {
      busy = false;
      update();
    }
  };

  $<HTMLButtonElement>('#sa-accept').onclick = () => {
    if (!result) return;
    scan.transform = result.T;
    scan.placement = { method: result.method, rms: result.stats.rms, within05: result.stats.within05, target: targetLabel };
    hooks.setStatus(`${scan.name}: ${placementLabel(scan)}.`);
    app.changed();
    close();
  };
  $<HTMLButtonElement>('.modal-close').onclick = close;
  setMode('points');
  void loadTarget();
}
