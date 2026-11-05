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
import { SCAN_KINDS, Scan, ScanKind, originalTransform, placementLabel, scanNormals } from './scans';
import { fillCavities, isoSurface } from './stl';

export interface AlignHooks {
  setStatus(msg: string, error?: boolean): void;
  showLoading(text: string, f: number): void;
  hideLoading(): void;
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function modalShell(cls: string, html: string): { root: HTMLDivElement; close: () => void } {
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
  build: (progress: (f: number) => void) => Promise<{ pos: Float32Array; idx: Uint32Array } | null>;
}

function targetChoices(app: App): TargetChoice[] {
  const vol = app.vol!;
  const out: TargetChoice[] = [];
  for (const sg of app.seg.segments.filter((s) => s.voxels > 0)) {
    out.push({
      key: `seg${sg.id}`,
      label: `Segment: ${sg.name}`,
      build: async (pr) => {
        const g = app.seg.segmentField(sg, 2, MAX_SAMPLES / 2);
        if (!g) return null;
        fillCavities(g);
        return isoSurface(g, pr);
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
      const g = thresholdField(vol, lo, hi, crop, 2);
      fillCavities(g);
      return isoSurface(g, pr);
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

export function showAlignment(app: App, scan: Scan, hooks: AlignHooks) {
  if (!app.vol) return;
  const choices = targetChoices(app);
  const defaultJaw = scan.kind === 'lower' ? 'lower' : 'upper';
  // prefer a segment named like the jaw
  const want = defaultJaw === 'upper' ? /maxill|upper/i : /mandib|lower/i;
  const defChoice = choices.find((c) => want.test(c.label)) ?? choices[choices.length - 1];
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
      <span class="sa-surface-only sa-tool"><button data-tool="paint" class="active" title="Left drag paints the areas to match">Paint</button><button data-tool="points" title="Click matching points (optional guide for the automatic match)">Points</button></span>
      <span class="sa-surface-only">Brush <input id="sa-brush" type="range" min="1" max="8" step="0.5" value="3" /> <span id="sa-brush-v">3 mm</span></span>
      <button id="sa-clear-paint" class="sa-surface-only">Clear painting</button>
      <button id="sa-undo">Undo point</button>
      <button id="sa-clear-pts">Clear points</button>
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
  );
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const panes = $('.sa-panes');
  const left = new MeshViewer('Intraoral scan');
  const right = new MeshViewer('CBCT');
  panes.append(left.el, right.el);
  let mode: 'points' | 'surface' = 'points';
  let surfaceTool: 'paint' | 'points' = 'paint';
  const pairs: Pair[] = [];
  const clicks: ('scan' | 'world')[] = [];
  const nv = scan.mesh.pos.length / 3;
  const painted = new Uint8Array(nv);
  let paintedCount = 0;
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
    key: 'scan', pos: scan.mesh.pos, nrm: scanNormals(scan.mesh), idx: scan.mesh.idx, col: baseCol.slice(), color: scan.color,
    opacity: 1, vertexColors: true, pickable: true,
  };
  left.setMeshes([scanMesh]);
  const occ = scanOcclusalAxis(scan.mesh.pos, scanMesh.nrm);
  left.fit([-occ.axis[0], -occ.axis[1], -occ.axis[2]]);

  // spatial hash of the scan vertices for painting
  const CELL = 2;
  const grid = new Map<number, number[]>();
  const cellKey = (x: number, y: number, z: number) => (Math.floor(x / CELL) + 4096) + (Math.floor(y / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096) * 67108864;
  for (let i = 0; i < nv; i++) {
    const k = cellKey(scan.mesh.pos[i * 3], scan.mesh.pos[i * 3 + 1], scan.mesh.pos[i * 3 + 2]);
    let a = grid.get(k);
    if (!a) grid.set(k, (a = []));
    a.push(i);
  }
  const paintAt = (p: Vec3, erase: boolean) => {
    const r = Number($<HTMLInputElement>('#sa-brush').value);
    const r2 = r * r;
    const P = scan.mesh.pos;
    const col = scanMesh.col!;
    const n = Math.ceil(r / CELL);
    for (let dx = -n; dx <= n; dx++)
      for (let dy = -n; dy <= n; dy++)
        for (let dz = -n; dz <= n; dz++) {
          const list = grid.get(cellKey(p[0] + dx * CELL, p[1] + dy * CELL, p[2] + dz * CELL));
          if (!list) continue;
          for (const i of list) {
            const d2 = (P[i * 3] - p[0]) ** 2 + (P[i * 3 + 1] - p[1]) ** 2 + (P[i * 3 + 2] - p[2]) ** 2;
            if (d2 > r2) continue;
            if (erase ? painted[i] : !painted[i]) {
              painted[i] = erase ? 0 : 1;
              paintedCount += erase ? -1 : 1;
              for (let k = 0; k < 3; k++) col[i * 3 + k] = erase ? baseCol[i * 3 + k] : Math.round(baseCol[i * 3 + k] * 0.35 + PAINT[k] * 0.65);
            }
          }
        }
    left.updateColors(scanMesh, col);
    clearResult();
    update();
  };

  const markers = () => {
    const lm: Marker[] = [];
    const rm: Marker[] = [];
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
    if (result) clearResult();
    const open = pairs.find((q) => !q.world);
    if (open) open.world = p;
    else pairs.push({ world: p });
    clicks.push('world');
    markers();
    update();
  };
  left.onPaint = (p, _m, erase) => {
    clearResult();
    paintAt(p, erase);
  };

  const setMode = (m: 'points' | 'surface') => {
    mode = m;
    root.querySelectorAll<HTMLButtonElement>('.sa-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    root.classList.toggle('mode-surface', m === 'surface');
    left.paintMode = m === 'surface' && surfaceTool === 'paint';
    clearResult();
    update();
  };
  root.querySelectorAll<HTMLButtonElement>('.sa-tabs button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as 'points' | 'surface')));
  root.querySelectorAll<HTMLButtonElement>('.sa-tool button').forEach(
    (b) =>
      (b.onclick = () => {
        surfaceTool = b.dataset.tool as 'paint' | 'points';
        root.querySelectorAll<HTMLButtonElement>('.sa-tool button').forEach((x) => x.classList.toggle('active', x === b));
        left.paintMode = mode === 'surface' && surfaceTool === 'paint';
        update();
      }),
  );

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
      help.innerHTML =
        surfaceTool === 'paint'
          ? `<b>Paint</b> the areas of the scan that are also visible in the CBCT – tooth surfaces (avoid gingiva and metal restorations with artefacts). ${paintedCount ? `${paintedCount.toLocaleString()} points painted.` : ''} Alt/Ctrl + drag erases, right drag rotates, middle drag pans, wheel zooms. Then <b>Match</b>: the fit is found automatically. Partial arch, or the match is uncertain? Switch to <b>Points</b> and click 1–2 matching points as a guide.`
          : `<b>Guide points</b> (optional): click a point on the scan, then the same point on the CBCT – one or two pairs are enough to guide the automatic match. ${n} pair${n === 1 ? '' : 's'} so far. Switch back to <b>Paint</b> to change the areas.`;
    }
    matchBtn.disabled = !target || (mode === 'points' ? n < 3 : paintedCount < 50 && n < 3);
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
    painted.fill(0);
    paintedCount = 0;
    left.updateColors(scanMesh, baseCol.slice());
    scanMesh.col = baseCol.slice();
    clearResult();
    update();
  };
  $<HTMLInputElement>('#sa-brush').oninput = () => ($('#sa-brush-v').textContent = `${$<HTMLInputElement>('#sa-brush').value} mm`);

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
      const m = await ch.build(() => {});
      if (!m || !m.idx.length) throw new Error('This surface is empty – adjust the threshold or the segment.');
      const nrm = vertexNormals(m.pos, m.idx);
      const thin = thinPoints(m.pos, nrm, 0.5);
      target = new Target(thin.pts, thin.nrm);
      targetLabel = ch.label;
      targetMesh = { key: `t-${ch.key}`, pos: m.pos, nrm, idx: m.idx, col: null, color: [226, 220, 205], opacity: 1, vertexColors: false, pickable: true };
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
    $('#sa-result').innerHTML = `${sure ? '✓' : '⚠'} ${pct} % of the ${method === 'surface' ? 'painted' : 'matched'} area within 0.5 mm · RMS ${stats.rms.toFixed(2)} mm${
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
      if (mode === 'points') {
        if (pp.length < 3) return;
        let T = fitRigid(pp.map((p) => p.scan), pp.map((p) => p.world));
        // surface points near the picked points (or the painted areas) for the refinement
        const src: number[] = [];
        const srcN: number[] = [];
        for (let i = 0; i < P.length; i += 3) {
          const near = paintedCount
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
          T = icp(fine, subsampleSame(sp, Float32Array.from(srcN), 3000, 11), T, target, { gate0: 2, iterations: 30, gate1: 0.6 });
        }
        showResult(T, fitStats(fine, T, target), 'points');
      } else {
        // painted points (or the whole scan if hints were given without painting)
        const sel: number[] = [];
        const selN: number[] = [];
        for (let i = 0; i < nv; i++) {
          if (paintedCount && !painted[i]) continue;
          sel.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
          selN.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
        }
        const c = [0, 0, 0];
        for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) c[k] += P[i + k];
        const res = await globalMatch(Float32Array.from(sel), Float32Array.from(selN), target, {
          scanOcclusal: occ.axis,
          occlusalConfident: occ.confident,
          scanCenter: c.map((v) => v / nv) as Vec3,
          targetOcclusal: occlusalWorld(),
          allowFlip: false,
          hints: pp.length ? { scan: pp.map((p) => p.scan), world: pp.map((p) => p.world) } : undefined,
          onProgress: progress,
        });
        showResult(res.T, res.stats, 'surface');
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
