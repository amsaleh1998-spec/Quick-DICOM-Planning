// Mesh editor: a 3D view of a mesh (the dual scan denture, an intraoral scan) with tools to clean it
// up – select a part by double-clicking it and remove the islands around it, trim with a lasso,
// close holes, smooth – with its own undo. Resolves with the edited mesh, or null when cancelled.

import { boundaryLoops, components, fillHoles, keepTriangles, smoothed, trimLasso } from '../meshEdit';
import type { MeshData } from '../meshio';
import { vertexNormals } from '../meshio';
import { MeshViewer, ViewerMesh } from '../meshViewer';
import type { Vec3 } from '../math';
import { escapeHtml } from './shell';

export interface MeshEditOptions {
  title: string;
  /** the mesh's colour */
  color: [number, number, number];
  /** label of the confirming button */
  okLabel: string;
  /** a line under the title */
  intro?: string;
  /** label of the cancelling button (default Cancel) */
  cancelLabel?: string;
}

const ISLAND: [number, number, number] = [255, 138, 92];
const START_VIEW: Vec3 = [0.3, 0.7, -0.65];

export function editMesh(start: MeshData, opts: MeshEditOptions): Promise<MeshData | null> {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = `
      <div class="modal mesh-editor" role="dialog" aria-modal="true" aria-labelledby="me-title">
        <header><h2 id="me-title">${escapeHtml(opts.title)}</h2><button class="modal-close" title="Cancel (Esc)">×</button></header>
        ${opts.intro ? `<p class="muted me-intro">${opts.intro}</p>` : ''}
        <div class="me-body">
          <aside class="me-tools">
            <section>
              <h3>Parts</h3>
              <p class="me-parts muted small"></p>
              <button class="me-keep" title="Keep the selected part, remove all the others">Remove the islands</button>
              <button class="me-del" title="Delete the selected part">Delete the selected part</button>
              <button class="me-largest" title="Keep the largest part only">Keep the largest part</button>
            </section>
            <section>
              <h3>Trim</h3>
              <button class="me-trim" aria-pressed="false" title="Draw around what to cut away (T)">Trim with a lasso</button>
              <label class="me-vis"><input type="checkbox" class="me-visible" /> Only what is visible</label>
              <p class="muted small">Draw around the area to cut away. Unticked, it cuts through the whole mesh. Right-drag rotates while trimming.</p>
            </section>
            <section>
              <h3>Holes</h3>
              <p class="me-holes muted small"></p>
              <button class="me-fill">Close the holes</button>
            </section>
            <section>
              <h3>Surface</h3>
              <button class="me-smooth" title="Smooth the surface a little (keeps its size)">Smooth</button>
            </section>
            <section class="me-undo-row">
              <button class="me-undo" title="Undo (Ctrl+Z)">Undo</button>
              <button class="me-redo" title="Redo (Ctrl+Y)">Redo</button>
              <button class="me-fit" title="Frame the mesh">Reset view</button>
            </section>
          </aside>
          <div class="me-view"></div>
        </div>
        <footer>
          <span class="me-stats muted small"></span><span class="grow"></span>
          <button class="me-cancel">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button class="primary me-ok">${escapeHtml(opts.okLabel)}</button>
        </footer>
      </div>`;
    const q = <T extends HTMLElement>(s: string) => m.querySelector<T>(s)!;
    const viewer = new MeshViewer('Double-click a part to select it · drag to rotate · wheel to zoom');
    q('.me-view').append(viewer.el);

    let mesh = start;
    const undo: MeshData[] = [];
    const redo: MeshData[] = [];
    let sel: number | null = null; // selected part
    let parts = components(mesh);
    let loops = boundaryLoops(mesh);
    let vm: ViewerMesh | null = null;

    const largest = () => parts.sizes.indexOf(Math.max(...parts.sizes));
    const colours = (): Uint8Array => {
      const nv = mesh.pos.length / 3;
      const partOfVertex = new Int32Array(nv);
      for (let t = 0; t < parts.part.length; t++) for (let k = 0; k < 3; k++) partOfVertex[mesh.idx[t * 3 + k]] = parts.part[t];
      const main = sel ?? largest();
      const col = new Uint8Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        const island = parts.sizes.length > 1 && partOfVertex[v] !== main;
        const c = island ? ISLAND : mesh.col ? ([mesh.col[v * 3], mesh.col[v * 3 + 1], mesh.col[v * 3 + 2]] as const) : opts.color;
        // the selected part a little brighter
        const lift = sel !== null && !island ? 1.12 : 1;
        col[v * 3] = Math.min(255, c[0] * lift);
        col[v * 3 + 1] = Math.min(255, c[1] * lift);
        col[v * 3 + 2] = Math.min(255, c[2] * lift);
      }
      return col;
    };
    const holeLines = () => {
      const seg: number[] = [];
      const p = mesh.pos;
      for (const l of loops)
        for (let i = 0; i < l.length; i++) {
          const a = l[i] * 3, b = l[(i + 1) % l.length] * 3;
          seg.push(p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2]);
        }
      viewer.lines = seg.length ? [{ seg: Float32Array.from(seg), color: '#ff8a5c' }] : [];
    };
    const refreshUi = () => {
      const n = parts.sizes.length;
      q('.me-parts').textContent =
        n <= 1 ? 'One part – no islands.' : `${n} parts: the islands are shown in orange.${sel === null ? ' Double-click the part to keep.' : ' One selected.'}`;
      q<HTMLButtonElement>('.me-keep').disabled = n <= 1;
      q<HTMLButtonElement>('.me-del').disabled = sel === null || n <= 1;
      q<HTMLButtonElement>('.me-largest').disabled = n <= 1;
      q('.me-holes').textContent = loops.length ? `${loops.length} hole${loops.length === 1 ? '' : 's'} (edges in orange).` : 'No holes – the surface is closed.';
      q<HTMLButtonElement>('.me-fill').disabled = !loops.length;
      q<HTMLButtonElement>('.me-undo').disabled = !undo.length;
      q<HTMLButtonElement>('.me-redo').disabled = !redo.length;
      q('.me-stats').textContent = `${(mesh.idx.length / 3).toLocaleString()} triangles`;
      q<HTMLButtonElement>('.me-ok').disabled = !mesh.idx.length;
    };
    const show = (fit = false) => {
      vm = { key: {}, pos: mesh.pos, nrm: vertexNormals(mesh.pos, mesh.idx), idx: mesh.idx, col: colours(), color: opts.color, opacity: 1, vertexColors: true, pickable: true };
      viewer.setMeshes([vm]);
      if (fit) viewer.fit(START_VIEW); // three-quarter view from above: the arch's shape at a glance
      holeLines();
      refreshUi();
    };
    /** Replace the mesh by an edited one (undoable). */
    const commit = (next: MeshData) => {
      if (next === mesh) return;
      undo.push(mesh);
      redo.length = 0;
      setMesh(next);
    };
    const setMesh = (next: MeshData) => {
      mesh = next;
      parts = components(mesh);
      loops = boundaryLoops(mesh);
      sel = null;
      show();
    };

    // double-click: select the part under the pointer (again on it: deselect)
    viewer.el.addEventListener('dblclick', (e) => {
      if (trimOn) return;
      const r = viewer.el.getBoundingClientRect();
      const hit = viewer.triangleAt(e.clientX - r.left, e.clientY - r.top);
      const p = hit ? parts.part[hit.tri] : null;
      sel = p === sel ? null : p;
      if (vm) viewer.updateColors(vm, colours());
      refreshUi();
    });
    q<HTMLButtonElement>('.me-keep').onclick = () => {
      const keep = sel ?? largest();
      commit(keepTriangles(mesh, (t) => parts.part[t] === keep));
    };
    q<HTMLButtonElement>('.me-del').onclick = () => {
      if (sel === null) return;
      const del = sel;
      commit(keepTriangles(mesh, (t) => parts.part[t] !== del));
    };
    q<HTMLButtonElement>('.me-largest').onclick = () => {
      const keep = largest();
      commit(keepTriangles(mesh, (t) => parts.part[t] === keep));
    };

    // trim
    let trimOn = false;
    const trimBtn = q<HTMLButtonElement>('.me-trim');
    const setTrim = (on: boolean) => {
      trimOn = on;
      viewer.lassoMode = on;
      trimBtn.classList.toggle('active', on);
      trimBtn.setAttribute('aria-pressed', String(on));
      viewer.el.classList.toggle('lasso', on);
      viewer.setTitle(on ? 'Draw around what to cut away · right-drag rotates · wheel zooms' : 'Double-click a part to select it · drag to rotate · wheel to zoom');
    };
    trimBtn.onclick = () => setTrim(!trimOn);
    viewer.onLasso = (poly) => {
      const visibleOnly = q<HTMLInputElement>('.me-visible').checked;
      const depth = visibleOnly ? viewer.depthMap() : null;
      const eye = viewer.eye();
      const tol = 0.35; // mm
      const visible = depth
        ? (p: Vec3, s: [number, number]) => {
            const d = depth(s[0], s[1]);
            return d !== null && Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) <= d + tol;
          }
        : undefined;
      const next = trimLasso(mesh, poly, (p) => viewer.screenOf(p), visible);
      if (next.idx.length !== mesh.idx.length) commit(next);
    };

    q<HTMLButtonElement>('.me-fill').onclick = () => commit(fillHoles(mesh, loops));
    q<HTMLButtonElement>('.me-smooth').onclick = async () => commit(await smoothed(mesh));
    const doUndo = () => {
      const prev = undo.pop();
      if (!prev) return;
      redo.push(mesh);
      setMesh(prev);
    };
    const doRedo = () => {
      const next = redo.pop();
      if (!next) return;
      undo.push(mesh);
      setMesh(next);
    };
    q<HTMLButtonElement>('.me-undo').onclick = doUndo;
    q<HTMLButtonElement>('.me-redo').onclick = doRedo;
    q<HTMLButtonElement>('.me-fit').onclick = () => viewer.fit(START_VIEW);

    // leaving with changes: the cancel button asks once more (a second press discards them)
    const cancelBtn = q<HTMLButtonElement>('.me-cancel');
    const cancelText = cancelBtn.textContent!;
    let discardAsked = 0;
    const done = (result: MeshData | null) => {
      if (result === null && undo.length && performance.now() - discardAsked > 4000) {
        discardAsked = performance.now();
        cancelBtn.textContent = 'Discard the changes?';
        cancelBtn.classList.add('danger');
        cancelBtn.focus();
        setTimeout(() => {
          if (performance.now() - discardAsked < 3900) return;
          cancelBtn.textContent = cancelText;
          cancelBtn.classList.remove('danger');
        }, 4000);
        return;
      }
      window.removeEventListener('keydown', onKey, true);
      viewer.dispose();
      m.remove();
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (trimOn) setTrim(false);
        else done(null);
      } else if (mod && k === 'z' && !e.shiftKey) doUndo();
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) doRedo();
      else if (!mod && k === 't' && !(e.target instanceof HTMLInputElement)) setTrim(!trimOn);
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && sel !== null) q<HTMLButtonElement>('.me-del').click();
      else return;
      // the editor has the keyboard: keep the shortcuts from the app behind it
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    q<HTMLButtonElement>('.modal-close').onclick = () => done(null);
    q<HTMLButtonElement>('.me-cancel').onclick = () => done(null);
    q<HTMLButtonElement>('.me-ok').onclick = () => done(mesh);
    document.body.append(m);
    show(true);
    if (viewer.error) q('.me-stats').textContent = viewer.error;
  });
}
