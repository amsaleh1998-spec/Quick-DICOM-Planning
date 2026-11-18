// Mesh editor: a 3D view of a mesh (the dual scan denture, an intraoral scan) with tools to clean it
// up – select a part by double-clicking it and remove the islands, trim with a lasso, cut and smooth
// with a brush, close holes – with its own undo.
//
// Edits are kept as a list of operations on a base mesh, so the base can be replaced (the dual
// scan re-segments the denture while its threshold changes) and the edits are applied again.

import { boundaryLoops, brushCut, brushSmooth, components, fillHoles, keepTriangles, neighbours, partNear, smoothAt, trimLasso } from '../meshEdit';
import type { MeshData } from '../meshio';
import { vertexNormals } from '../meshio';
import { Camera, MeshViewer, ViewerMesh, eyeOf, projectWith } from '../meshViewer';
import type { Vec3 } from '../math';
import { escapeHtml } from './shell';

export type EditOp =
  | { t: 'keep'; p: Vec3 }
  | { t: 'del'; p: Vec3 }
  | { t: 'largest' }
  | { t: 'lasso'; poly: [number, number][]; cam: Camera; visible: boolean }
  | { t: 'fill' }
  | { t: 'cut'; pts: Vec3[]; r: number }
  | { t: 'smooth'; pts: Vec3[]; r: number };

type Mode = 'select' | 'lasso' | 'cut' | 'smooth';

const ISLAND: [number, number, number] = [255, 138, 92];
const START_VIEW: Vec3 = [0.3, 0.7, -0.65];
const HINTS: Record<Mode, string> = {
  select: 'Double-click a part to select it · drag to rotate · wheel to zoom',
  lasso: 'Draw around what to cut away · right-drag rotates · wheel zooms',
  cut: 'Brush over what to cut away · right-drag rotates · [ ] brush size',
  smooth: 'Brush over the area to smooth · right-drag rotates · [ ] brush size',
};

/** One edit applied to a mesh (the viewer renders the depth for "only what is visible" lassos). */
function applyOp(m: MeshData, op: EditOp, viewer: MeshViewer): MeshData {
  switch (op.t) {
    case 'keep':
    case 'del': {
      const { part } = components(m);
      const p = partNear(m, part, op.p);
      return keepTriangles(m, (t) => (part[t] === p) === (op.t === 'keep'));
    }
    case 'largest': {
      const { part, sizes } = components(m);
      const big = sizes.indexOf(Math.max(...sizes));
      return keepTriangles(m, (t) => part[t] === big);
    }
    case 'lasso': {
      const depth = op.visible ? viewer.depthMapFor(op.cam, m.pos, m.idx) : null;
      const eye = eyeOf(op.cam);
      const visible = depth
        ? (p: Vec3, s: [number, number]) => {
            const d = depth(s[0], s[1]);
            return d !== null && Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) <= d + 0.35;
          }
        : undefined;
      return trimLasso(m, op.poly, (p) => projectWith(op.cam, p), visible);
    }
    case 'fill':
      return fillHoles(m);
    case 'cut':
      return brushCut(m, op.pts, op.r);
    case 'smooth':
      return brushSmooth(m, op.pts, op.r);
  }
}

export class MeshEditor {
  /** the tools (put them next to the view) */
  readonly tools: HTMLElement;
  /** the 3D view */
  readonly view: HTMLElement;
  /** called after every change of the mesh */
  onChange: (() => void) | null = null;
  private viewer: MeshViewer;
  private ops: EditOp[] = [];
  private redoOps: EditOp[] = [];
  /** states[i]: the mesh after the first i operations (states[0] the base) */
  private states: MeshData[];
  private parts: { part: Int32Array; sizes: number[] };
  private loops: number[][];
  private sel: number | null = null;
  private vm: ViewerMesh | null = null;
  private mode: Mode = 'select';
  private radius = 1.5;
  /** the brush stroke going on */
  private stroke: { pts: Vec3[]; mesh: MeshData; nbrs?: ReturnType<typeof neighbours> } | null = null;

  constructor(
    base: MeshData,
    private opts: { color: [number, number, number] },
  ) {
    this.states = [base];
    this.parts = components(base);
    this.loops = boundaryLoops(base);
    this.viewer = new MeshViewer(HINTS.select);
    this.view = this.viewer.el;
    this.tools = document.createElement('div');
    this.tools.className = 'me-tools';
    this.tools.innerHTML = `
      <section>
        <h3>Tools</h3>
        <div class="me-modes" role="radiogroup" aria-label="Tool">
          <button data-mode="select" class="active" title="Rotate and double-click to select parts (Esc)">Select</button>
          <button data-mode="lasso" title="Draw around what to cut away (T)">Lasso</button>
          <button data-mode="cut" title="Brush over what to cut away (B)">Cut brush</button>
          <button data-mode="smooth" title="Brush over an area to smooth it (S)">Smooth brush</button>
        </div>
        <label class="me-row me-size">Brush <input class="me-radius" type="range" min="0.3" max="6" step="0.1" value="1.5" /> <output class="me-radius-v">1.5 mm</output></label>
        <label class="me-row me-vis"><input type="checkbox" class="me-visible" /> Lasso: only what is visible</label>
      </section>
      <section>
        <h3>Parts</h3>
        <p class="me-parts muted small"></p>
        <button class="me-keep" title="Keep the selected part (or the largest), remove all the others">Remove the islands</button>
        <button class="me-del" title="Delete the selected part (Delete)">Delete the selected part</button>
        <button class="me-largest" title="Keep the largest part only">Keep the largest part</button>
      </section>
      <section>
        <h3>Holes</h3>
        <p class="me-holes muted small"></p>
        <button class="me-fill">Close the holes</button>
      </section>
      <section class="me-undo-row">
        <button class="me-undo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="me-redo" title="Redo (Ctrl+Y)">Redo</button>
        <button class="me-fit" title="Frame the mesh">Reset view</button>
      </section>
      <p class="me-stats muted small"></p>`;
    const q = <T extends HTMLElement>(s: string) => this.tools.querySelector<T>(s)!;
    this.tools.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode as Mode)));
    const radius = q<HTMLInputElement>('.me-radius');
    radius.oninput = () => this.setRadius(Number(radius.value));
    q<HTMLButtonElement>('.me-keep').onclick = () => {
      if (this.sel === null) this.push({ t: 'largest' });
      else this.push({ t: 'keep', p: this.partPoint(this.sel) });
    };
    q<HTMLButtonElement>('.me-del').onclick = () => {
      if (this.sel !== null) this.push({ t: 'del', p: this.partPoint(this.sel) });
    };
    q<HTMLButtonElement>('.me-largest').onclick = () => this.push({ t: 'largest' });
    q<HTMLButtonElement>('.me-fill').onclick = () => this.push({ t: 'fill' });
    q<HTMLButtonElement>('.me-undo').onclick = () => this.undo();
    q<HTMLButtonElement>('.me-redo').onclick = () => this.redo();
    q<HTMLButtonElement>('.me-fit').onclick = () => this.viewer.fit(START_VIEW);

    const v = this.viewer;
    v.el.addEventListener('dblclick', (e) => {
      if (this.mode !== 'select') return;
      const r = v.el.getBoundingClientRect();
      const hit = v.triangleAt(e.clientX - r.left, e.clientY - r.top);
      const p = hit ? this.parts.part[hit.tri] : null;
      this.sel = p === this.sel ? null : p;
      if (this.vm) v.updateColors(this.vm, this.colours());
      this.refreshUi();
    });
    v.onLasso = (poly) => {
      const op: EditOp = { t: 'lasso', poly, cam: v.camera(), visible: q<HTMLInputElement>('.me-visible').checked };
      const next = applyOp(this.mesh, op, v);
      if (next.idx.length !== this.mesh.idx.length) this.pushResult(op, next);
    };
    v.onPaint = (p) => {
      if (this.mode !== 'cut' && this.mode !== 'smooth') return;
      if (!this.stroke) this.stroke = { pts: [], mesh: this.mode === 'smooth' ? { ...this.mesh, pos: new Float32Array(this.mesh.pos) } : this.mesh };
      const s = this.stroke;
      s.pts.push([...p] as Vec3);
      if (this.mode === 'cut') s.mesh = brushCut(s.mesh, [p], this.radius);
      else {
        s.nbrs ??= neighbours(s.mesh);
        smoothAt(s.mesh.pos, s.nbrs, p, this.radius);
      }
      this.showMesh(s.mesh, false, this.mode === 'smooth' ? this.parts : undefined);
    };
    v.onPaintEnd = () => {
      const s = this.stroke;
      this.stroke = null;
      if (!s?.pts.length) return;
      const op: EditOp = this.mode === 'smooth' ? { t: 'smooth', pts: s.pts, r: this.radius } : { t: 'cut', pts: s.pts, r: this.radius };
      if (op.t === 'cut' && s.mesh.idx.length === this.mesh.idx.length) return this.show();
      this.pushResult(op, s.mesh);
    };
    this.show(true);
  }

  /** The edited mesh. */
  get mesh(): MeshData {
    return this.states[this.states.length - 1];
  }

  /** Whether anything was edited. */
  get edited(): boolean {
    return this.ops.length > 0;
  }

  get error(): string | null {
    return this.viewer.error;
  }

  /** A new base mesh (e.g. segmented again): the edits so far are applied to it again. */
  setBase(base: MeshData, fit = false) {
    this.states = [base];
    for (const op of this.ops) this.states.push(applyOp(this.mesh, op, this.viewer));
    this.show(fit);
  }

  setMode(mode: Mode) {
    this.mode = mode;
    const v = this.viewer;
    v.lassoMode = mode === 'lasso';
    v.paintMode = mode === 'cut' || mode === 'smooth';
    v.brushRadius = v.paintMode ? this.radius : null;
    v.setTitle(HINTS[mode]);
    v.el.classList.toggle('brush', v.paintMode);
    this.tools.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    });
    v.request();
  }

  private setRadius(r: number) {
    this.radius = Math.max(0.3, Math.min(6, Math.round(r * 10) / 10));
    this.tools.querySelector<HTMLInputElement>('.me-radius')!.value = String(this.radius);
    this.tools.querySelector('.me-radius-v')!.textContent = `${this.radius.toFixed(1)} mm`;
    if (this.viewer.paintMode) this.viewer.brushRadius = this.radius;
    this.viewer.request();
  }

  /** Keyboard shortcuts of the editor; true when the key was used. */
  key(e: KeyboardEvent): boolean {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return false;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z' && !e.shiftKey) this.undo();
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) this.redo();
    else if (mod || e.altKey) return false;
    else if (e.key === 'Escape' && this.mode !== 'select') this.setMode('select');
    else if (k === 't') this.setMode('lasso');
    else if (k === 'b') this.setMode('cut');
    else if (k === 's') this.setMode('smooth');
    else if (e.key === '[') this.setRadius(this.radius - (this.radius > 2 ? 0.5 : 0.2));
    else if (e.key === ']') this.setRadius(this.radius + (this.radius >= 2 ? 0.5 : 0.2));
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel !== null) this.tools.querySelector<HTMLButtonElement>('.me-del')!.click();
    else return false;
    return true;
  }

  fit() {
    this.viewer.fit(START_VIEW);
  }

  dispose() {
    this.viewer.dispose();
  }

  private push(op: EditOp) {
    this.pushResult(op, applyOp(this.mesh, op, this.viewer));
  }

  private pushResult(op: EditOp, mesh: MeshData) {
    this.ops.push(op);
    this.states.push(mesh);
    this.redoOps.length = 0;
    this.show();
  }

  undo() {
    if (!this.ops.length) return;
    this.redoOps.push(this.ops.pop()!);
    this.states.pop();
    this.show();
  }

  redo() {
    const op = this.redoOps.pop();
    if (!op) return;
    this.ops.push(op);
    this.states.push(applyOp(this.mesh, op, this.viewer));
    this.show();
  }

  /** A point on a part (to find it again after the base changes). */
  private partPoint(p: number): Vec3 {
    const { pos, idx } = this.mesh;
    const t = this.parts.part.indexOf(p);
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    return [(pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3];
  }

  private largest() {
    return this.parts.sizes.indexOf(Math.max(...this.parts.sizes));
  }

  private colours(mesh = this.mesh, parts = this.parts): Uint8Array {
    const nv = mesh.pos.length / 3;
    const partOfVertex = new Int32Array(nv);
    for (let t = 0; t < parts.part.length; t++) for (let k = 0; k < 3; k++) partOfVertex[mesh.idx[t * 3 + k]] = parts.part[t];
    const main = this.sel ?? this.largest();
    const col = new Uint8Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const island = parts.sizes.length > 1 && partOfVertex[v] !== main;
      const c = island ? ISLAND : mesh.col ? ([mesh.col[v * 3], mesh.col[v * 3 + 1], mesh.col[v * 3 + 2]] as const) : this.opts.color;
      const lift = this.sel !== null && !island ? 1.12 : 1; // the selected part a little brighter
      col[v * 3] = Math.min(255, c[0] * lift);
      col[v * 3 + 1] = Math.min(255, c[1] * lift);
      col[v * 3 + 2] = Math.min(255, c[2] * lift);
    }
    return col;
  }

  /** Show the current mesh (parts, holes and the tools' state recomputed). */
  private show(fit = false) {
    this.parts = components(this.mesh);
    this.loops = boundaryLoops(this.mesh);
    this.sel = null;
    this.showMesh(this.mesh, fit);
    const seg: number[] = [];
    const p = this.mesh.pos;
    for (const l of this.loops)
      for (let i = 0; i < l.length; i++) {
        const a = l[i] * 3, b = l[(i + 1) % l.length] * 3;
        seg.push(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
      }
    this.viewer.lines = seg.length ? [{ seg: Float32Array.from(seg), color: '#ff8a5c' }] : [];
    this.refreshUi();
    this.onChange?.();
  }

  /** Draw a mesh (also one in the middle of a brush stroke). */
  private showMesh(mesh: MeshData, fit: boolean, sameParts?: { part: Int32Array; sizes: number[] }) {
    const parts = sameParts ?? (mesh === this.mesh ? this.parts : components(mesh));
    this.vm = { key: {}, pos: mesh.pos, nrm: vertexNormals(mesh.pos, mesh.idx), idx: mesh.idx, col: this.colours(mesh, parts), color: this.opts.color, opacity: 1, vertexColors: true, pickable: true };
    this.viewer.setMeshes([this.vm]);
    if (fit) this.viewer.fit(START_VIEW);
  }

  private refreshUi() {
    const q = <T extends HTMLElement>(s: string) => this.tools.querySelector<T>(s)!;
    const n = this.parts.sizes.length;
    q('.me-parts').textContent = !this.mesh.idx.length
      ? 'Nothing to show.'
      : n <= 1
        ? 'One part – no islands.'
        : `${n} parts: the islands are shown in orange.${this.sel === null ? ' Double-click the part to keep.' : ' One selected.'}`;
    q<HTMLButtonElement>('.me-keep').disabled = n <= 1;
    q<HTMLButtonElement>('.me-del').disabled = this.sel === null || n <= 1;
    q<HTMLButtonElement>('.me-largest').disabled = n <= 1;
    const h = this.loops.length;
    q('.me-holes').textContent = h ? `${h} hole${h === 1 ? '' : 's'} (edges in orange).` : 'No holes – the surface is closed.';
    q<HTMLButtonElement>('.me-fill').disabled = !h;
    q<HTMLButtonElement>('.me-undo').disabled = !this.ops.length;
    q<HTMLButtonElement>('.me-redo').disabled = !this.redoOps.length;
    q('.me-stats').textContent = `${(this.mesh.idx.length / 3).toLocaleString()} triangles`;
  }
}

/**
 * A cancel button that asks once more when there are changes (a second press within a few
 * seconds discards them). Returns the function to call to cancel.
 */
export function guardedCancel(btn: HTMLButtonElement, edited: () => boolean, close: () => void): () => void {
  const text = btn.textContent!;
  let asked = -1e9;
  return () => {
    if (!edited() || performance.now() - asked < 4000) return close();
    asked = performance.now();
    btn.textContent = 'Discard the changes?';
    btn.classList.add('danger');
    btn.focus();
    setTimeout(() => {
      if (performance.now() - asked < 3900) return;
      btn.textContent = text;
      btn.classList.remove('danger');
    }, 4000);
  };
}

export interface MeshEditOptions {
  title: string;
  /** the mesh's colour */
  color: [number, number, number];
  /** label of the confirming button */
  okLabel: string;
  /** a line under the title */
  intro?: string;
}

/** The editor in a window of its own (Scans panel → Edit mesh…). Null when cancelled. */
export function editMesh(start: MeshData, opts: MeshEditOptions): Promise<MeshData | null> {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = `
      <div class="modal mesh-editor" role="dialog" aria-modal="true" aria-labelledby="me-title">
        <header><h2 id="me-title">${escapeHtml(opts.title)}</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
        ${opts.intro ? `<p class="muted me-intro">${opts.intro}</p>` : ''}
        <div class="me-body"><div class="me-view"></div></div>
        <footer>
          <span class="grow"></span>
          <button class="me-cancel">Cancel</button>
          <button class="primary me-ok">${escapeHtml(opts.okLabel)}</button>
        </footer>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => m.querySelector<T>(s)!;
    const ed = new MeshEditor(start, { color: opts.color });
    q('.me-view').append(ed.view);
    q('.me-body').append(ed.tools);
    const ok = q<HTMLButtonElement>('.me-ok');
    ed.onChange = () => (ok.disabled = !ed.mesh.idx.length);
    const close = (result: MeshData | null) => {
      window.removeEventListener('keydown', onKey, true);
      ed.dispose();
      m.remove();
      resolve(result);
    };
    const cancel = guardedCancel(q<HTMLButtonElement>('.me-cancel'), () => ed.edited, () => close(null));
    const onKey = (e: KeyboardEvent) => {
      if (!ed.key(e)) {
        if (e.key !== 'Escape') return;
        cancel();
      }
      // the editor has the keyboard: keep the shortcuts from the app behind it
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    q<HTMLButtonElement>('.modal-close').onclick = cancel;
    q<HTMLButtonElement>('.me-cancel').onclick = cancel;
    ok.onclick = () => close(ed.edited ? ed.mesh : start);
    document.body.append(m);
    ed.fit();
    if (ed.error) q('.me-stats').textContent = ed.error;
  });
}
