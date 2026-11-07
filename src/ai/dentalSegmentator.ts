// Automatic jaw / teeth / canal segmentation with DentalSegmentator, run in the browser.
//
// Credits: DentalSegmentator – Dot G, et al. Journal of Dentistry (2024),
// doi:10.1016/j.jdent.2024.105130; weights doi:10.5281/zenodo.10829675 (CC BY 4.0); built on
// nnU-Net (Isensee F, et al. Nat Methods 2021). See dsPlan.ts / README.

import type { App } from '../app';
import { Vec3, fromFrame } from '../math';
import { DS_CREDIT, DS_MODEL, contextBox, modelAxes, modelGrid, patchCount } from './dsPlan';
import { nonzeroBox } from './dsEngine';
import { DEDICATED_GPU_HELP, findGpu, gpuBuffersTooSmall } from './gpu';
import type { StartMsg, WorkerMsg } from './dsWorker';

export interface AiHooks {
  setStatus(text: string, error?: boolean): void;
}

/**
 * World boxes (CT voxel centres) for a run: `out` = where labels are written (whole scan or crop
 * box), `lo` / `hi` = what the network sees (the crop box with real context around it).
 */
function regionBox(app: App, region: 'all' | 'crop'): { lo: Vec3; hi: Vec3; out: { lo: Vec3; hi: Vec3 } | null } {
  const vol = app.vol!;
  const scan = { lo: [0, 0, 0] as Vec3, hi: [(vol.nx - 1) * vol.spacing[0], (vol.ny - 1) * vol.spacing[1], (vol.nz - 1) * vol.spacing[2]] as Vec3 };
  if (region === 'all') return { ...scan, out: null };
  const out = cropBox(app);
  return { ...contextBox(out.lo, out.hi, scan.lo, scan.hi, modelAxes(vol.info.patientAffine)), out };
}

/** World bounding box of the crop box, inside the scan. */
function cropBox(app: App): { lo: Vec3; hi: Vec3 } {
  const vol = app.vol!;
  const full = { lo: [0, 0, 0] as Vec3, hi: [(vol.nx - 1) * vol.spacing[0], (vol.ny - 1) * vol.spacing[1], (vol.nz - 1) * vol.spacing[2]] as Vec3 };
  const { min, max } = app.crop;
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const f: Vec3 = [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]];
    const w = fromFrame(f, app.O, app.frame);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], w[a]);
      hi[a] = Math.max(hi[a], w[a]);
    }
  }
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.max(full.lo[a], lo[a]);
    hi[a] = Math.min(full.hi[a], hi[a]);
  }
  return { lo, hi };
}

/** Tiles to compute for a region at the standard (0.5) and fast (1) step. */
function tileCounts(app: App, region: 'all' | 'crop'): [number, number] {
  const vol = app.vol!;
  const r = regionBox(app, region);
  const b = nonzeroBox(vol.data, vol.dims, vol.spacing, r.lo, r.hi);
  const axes = modelAxes(vol.info.patientAffine);
  return [patchCount(modelGrid(b.lo, b.hi, vol.spacing, axes, 0.5)), patchCount(modelGrid(b.lo, b.hi, vol.spacing, axes, 1))];
}

const TILE_MM = DS_MODEL.patch.map((p, k) => Math.round(p * DS_MODEL.spacing[k])).join(' × ');

const fmtTime = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

let modal: HTMLDivElement | null = null;
let pill: HTMLDivElement | null = null;
let running: { worker: Worker; cancel: () => void } | null = null;

export function showDentalSegmentator(app: App, hooks: AiHooks) {
  if (running) {
    // a run is going on: bring its window back
    modal?.classList.remove('hidden');
    pill?.classList.add('hidden');
    return;
  }
  const vol = app.vol;
  if (!vol) {
    hooks.setStatus('Open a CBCT first.', true);
    return;
  }
  const cropped = !app.cropIsFull();
  const counts = { all: tileCounts(app, 'all'), crop: cropped ? tileCounts(app, 'crop') : [0, 0] };
  const hasAi = app.seg.segments.some((g) => g.ai);
  modal?.remove();
  const m = document.createElement('div');
  modal = m;
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal ai-seg" role="dialog" aria-modal="true" aria-labelledby="ai-title">
      <header>
        <h2 id="ai-title">Automatic segmentation</h2>
        <button class="modal-close" title="Close (Esc)">×</button>
      </header>
      <div class="ai-setup">
        <p class="intro">Segments the <b>maxilla &amp; upper skull</b>, the <b>mandible</b>, the <b>upper</b> and <b>lower teeth</b> and the
          <b>mandibular canals</b> with <b>DentalSegmentator</b>, a deep-learning model for CBCT and CT. It runs entirely in this browser – the
          scan never leaves your computer.</p>
        <h4>Region</h4>
        <label class="check"><input type="radio" name="ai-region" value="all" ${cropped ? '' : 'checked'} /> Whole scan</label>
        <label class="check ${cropped ? '' : 'disabled'}"><input type="radio" name="ai-region" value="crop" ${cropped ? 'checked' : 'disabled'} /> Inside the crop box ${cropped ? '(faster)' : '(no crop box set)'}</label>
        <h4>Quality</h4>
        <label class="check"><input type="radio" name="ai-step" value="0.5" checked /> Standard – overlapping tiles, as the original model</label>
        <label class="check"><input type="radio" name="ai-step" value="1" /> Fast – about 4× quicker, slightly less accurate at the tile borders</label>
        <p class="muted small" id="ai-est"></p>
        <div class="ai-gpu small" id="ai-gpu">Checking the graphics card…</div>
        ${hasAi ? '<p class="muted small">The automatic segments from the previous run are replaced.</p>' : ''}
        <p class="muted small">The first run downloads the model (62 MB), later runs use the saved copy. A graphics card (WebGPU, Chrome / Edge) makes it many times faster than the CPU.</p>
      </div>
      <div class="ai-run hidden">
        <div class="ai-phase" id="ai-phase">Starting…</div>
        <div class="ai-bar"><div id="ai-bar-fill"></div></div>
        <div class="muted small" id="ai-detail"></div>
        <ul class="ai-notes" id="ai-notes"></ul>
      </div>
      <div class="ai-credit small">
        <b>DentalSegmentator</b> by Gauthier Dot et al. – Dot G, et al. <i>DentalSegmentator: robust open source deep learning-based CT and CBCT image segmentation.</i>
        Journal of Dentistry (2024), <a href="${DS_CREDIT.paperDoi}" target="_blank" rel="noopener">doi:10.1016/j.jdent.2024.105130</a>.
        Model weights: Dot G, Zenodo (2024), <a href="${DS_CREDIT.weightsDoi}" target="_blank" rel="noopener">doi:10.5281/zenodo.10829675</a>, licensed
        <a href="${DS_CREDIT.license}" target="_blank" rel="noopener">CC BY 4.0</a> – converted here to ONNX with half-precision weights for the browser.
        Built on <b>nnU-Net</b> (Isensee F, et al. Nat Methods 2021;18(2):203-211, <a href="${DS_CREDIT.nnunetDoi}" target="_blank" rel="noopener">doi:10.1038/s41592-020-01008-z</a>),
        runs with ONNX Runtime Web. Also available for 3D Slicer as <a href="${DS_CREDIT.slicer}" target="_blank" rel="noopener">SlicerDentalSegmentator</a>.
        <br />Research software – check every segment before using it for treatment planning.
      </div>
      <footer>
        <span class="muted small" id="ai-foot"></span>
        <span class="row">
          <button id="ai-hide" class="hidden" title="Keep working while it runs">Run in background</button>
          <button id="ai-cancel" class="hidden danger">Cancel</button>
          <button id="ai-go" class="primary">Start</button>
        </span>
      </footer>
    </div>`;
  document.body.append(m);
  const $ = <T extends HTMLElement>(sel: string) => m.querySelector<T>(sel)!;
  const opt = () => ({
    region: (m.querySelector<HTMLInputElement>('input[name="ai-region"]:checked')?.value ?? 'all') as 'all' | 'crop',
    step: Number(m.querySelector<HTMLInputElement>('input[name="ai-step"]:checked')?.value ?? 0.5),
  });
  const updateEst = () => {
    const o = opt();
    const n = counts[o.region][o.step === 1 ? 1 : 0];
    $('#ai-est').textContent = `${n} tile${n === 1 ? '' : 's'} of ${TILE_MM} mm to compute – roughly ${fmtTime(n * 1)}–${fmtTime(n * 5)} with a graphics card, ${fmtTime(
      n * 10,
    )}–${fmtTime(n * 40)} on the CPU.`;
  };
  m.addEventListener('change', updateEst);
  updateEst();
  showGpu(m.querySelector<HTMLDivElement>('#ai-gpu')!);

  const close = () => {
    if (running) {
      // keep running in the background
      m.classList.add('hidden');
      pill?.classList.remove('hidden');
      return;
    }
    m.remove();
    if (modal === m) modal = null;
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !m.classList.contains('hidden')) {
      e.stopImmediatePropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  m.addEventListener('pointerdown', (e) => {
    if (e.target === m) close();
  });
  $('.modal-close').onclick = close;
  $('#ai-hide').onclick = close;
  $<HTMLButtonElement>('#ai-go').onclick = () => start(app, hooks, m, opt(), () => {
    window.removeEventListener('keydown', onKey, true);
  });
}

/** Which graphics card will run the model – with help when it is the slow integrated one. */
async function showGpu(el: HTMLDivElement) {
  const g = await findGpu();
  if (typeof g === 'string') {
    el.className = 'ai-gpu small warn';
    el.innerHTML = `<b>No usable graphics card</b> (${g}) – the model runs on the CPU, which is much slower. Use a current Chrome or Edge.`;
  } else if (gpuBuffersTooSmall(g)) {
    el.className = 'ai-gpu small warn';
    el.innerHTML = `Graphics card: <b>${g.label}</b> – too little memory for the model, it runs on the CPU (much slower).`;
  } else if (g.integrated) {
    el.className = 'ai-gpu small warn';
    el.innerHTML = `Graphics card: <b>${g.label}</b> (integrated – slow). If this computer also has an <b>NVIDIA</b> or AMD
      graphics card, the browser is not using it: Chrome on Windows ignores the page's request and uses the card set
      for the browser in Windows.
      <details><summary>Use the NVIDIA card (many times faster)</summary>${DEDICATED_GPU_HELP}</details>`;
  } else {
    el.className = 'ai-gpu small ok';
    el.innerHTML = `Graphics card: <b>${g.label}</b>`;
  }
}

function start(app: App, hooks: AiHooks, m: HTMLDivElement, o: { region: 'all' | 'crop'; step: number }, onEnd: () => void) {
  const vol = app.vol!;
  const seg = app.seg;
  const $ = <T extends HTMLElement>(sel: string) => m.querySelector<T>(sel)!;
  $('.ai-setup').classList.add('hidden');
  $('.ai-run').classList.remove('hidden');
  $('#ai-go').classList.add('hidden');
  $('#ai-cancel').classList.remove('hidden');
  $('#ai-hide').classList.remove('hidden');
  const phase = $('#ai-phase'), fill = $('#ai-bar-fill'), detail = $('#ai-detail'), notes = $('#ai-notes'), foot = $('#ai-foot');

  // only the region (plus one voxel for interpolation) goes to the worker
  const r = regionBox(app, o.region);
  const i0 = [0, 1, 2].map((a) => Math.max(0, Math.floor(r.lo[a] / vol.spacing[a]) - 1));
  const i1 = [0, 1, 2].map((a) => Math.min(vol.dims[a] - 1, Math.ceil(r.hi[a] / vol.spacing[a]) + 1));
  const full = [0, 1, 2].map((a) => i1[a] - i0[a] + 1);
  // very large high-resolution regions: average 2×2×2 voxels (still finer than the model's grid)
  let f = 1;
  while ((full[0] * full[1] * full[2]) / (f + 1) ** 3 > 30e6 && (full[0] * full[1] * full[2]) / f ** 3 > 120e6 && Math.max(...vol.spacing) * (f + 1) <= 0.35) f++;
  const dims = full.map((n) => Math.max(1, Math.floor(n / f))) as [number, number, number];
  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  if (f === 1) {
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++) {
        const src = i0[0] + (i0[1] + j) * vol.nx + (i0[2] + k) * vol.nx * vol.ny;
        data.set(vol.data.subarray(src, src + dims[0]), (j + k * dims[1]) * dims[0]);
      }
  } else {
    const n = f * f * f;
    for (let k = 0, o = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++, o++) {
          let acc = 0;
          for (let c = 0; c < f; c++)
            for (let b = 0; b < f; b++) {
              const row = i0[0] + i * f + (i0[1] + j * f + b) * vol.nx + (i0[2] + k * f + c) * vol.nx * vol.ny;
              for (let a = 0; a < f; a++) acc += vol.data[row + a];
            }
          data[o] = Math.round(acc / n);
        }
  }
  const spacing = vol.spacing.map((s) => s * f) as Vec3;
  const origin = [0, 1, 2].map((a) => (i0[a] + (f - 1) / 2) * vol.spacing[a]) as Vec3;
  const msg: StartMsg = {
    type: 'start',
    modelBase: new URL('models/dentalsegmentator/', document.baseURI).href,
    ortBase: new URL('ort/', document.baseURI).href,
    prefer: new URLSearchParams(location.search).get('ai') === 'cpu' ? 'wasm' : 'auto',
    input: {
      data,
      dims,
      spacing,
      origin,
      roiLo: r.lo,
      roiHi: r.hi,
      ...(r.out ? { outLo: r.out.lo, outHi: r.out.hi } : {}),
      patientAffine: vol.info.patientAffine,
      step: o.step,
      label: { nx: seg.nx, ny: seg.ny, nz: seg.nz, gs: [...seg.gs] as Vec3 },
      ...(new URLSearchParams(location.search).has('aidebug') ? { debug: true } : {}),
    },
  };
  const gridKey = JSON.stringify([seg.nx, seg.ny, seg.nz, seg.gs]);
  const worker = new Worker(new URL('./dsWorker.ts', import.meta.url), { type: 'module' });
  const t0 = performance.now();
  let tilesStart = 0;
  const end = () => {
    worker.terminate();
    running = null;
    pill?.remove();
    pill = null;
    onEnd();
  };
  const finish = (text: string, error = false) => {
    end();
    m.remove();
    if (modal === m) modal = null;
    hooks.setStatus(text, error);
  };
  running = {
    worker,
    cancel: () => finish('Automatic segmentation cancelled.'),
  };
  $('#ai-cancel').onclick = () => running?.cancel();

  // compact progress shown while the window is hidden
  pill = document.createElement('div');
  pill.className = 'ai-pill hidden';
  pill.title = 'Automatic segmentation – click to show';
  pill.onclick = () => {
    m.classList.remove('hidden');
    pill!.classList.add('hidden');
  };
  document.body.append(pill);
  const setProgress = (f: number, text: string, sub: string) => {
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    phase.textContent = text;
    detail.textContent = sub;
    if (pill) pill.textContent = `AI segmentation · ${text}`;
  };
  setProgress(0, 'Loading the model…', '');

  worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const d = e.data;
    if (d.type === 'note') {
      const li = document.createElement('li');
      li.textContent = d.text;
      notes.append(li);
    } else if (d.type === 'progress') {
      if (d.phase === 'download') setProgress((0.1 * d.done) / d.total, `Loading the model… ${Math.round((100 * d.done) / d.total)} %`, `${(d.done / 1e6).toFixed(1)} of ${(d.total / 1e6).toFixed(1)} MB`);
      else if (d.phase === 'init') setProgress(0.1, 'Preparing the model…', d.device === 'webgpu' ? `graphics card: ${d.gpu ?? 'WebGPU'}` : 'CPU (WebAssembly)');
      else if (d.phase === 'run') {
        if (!tilesStart) tilesStart = performance.now();
        const el = (performance.now() - tilesStart) / 1000;
        const left = d.done ? (el / d.done) * (d.total - d.done) : 0;
        setProgress(
          0.1 + (0.88 * d.done) / d.total,
          `Segmenting… ${Math.round((100 * d.done) / d.total)} %${d.done >= 2 && d.done < d.total ? ` · about ${fmtTime(left)} left` : ''}`,
          `tile ${d.done} of ${d.total}${d.skipped ? ` (${d.skipped} empty)` : ''} · ${d.device === 'webgpu' ? d.gpu ?? 'graphics card' : 'CPU'}${d.msPerTile ? ` · ${(d.msPerTile / 1000).toFixed(1)} s per tile` : ''}`,
        );
      } else if (d.phase === 'finish') setProgress(0.99, 'Finishing…', '');
    } else if (d.type === 'done') {
      if (app.vol !== vol || JSON.stringify([app.seg.nx, app.seg.ny, app.seg.nz, app.seg.gs]) !== gridKey) {
        finish('The scan changed while the automatic segmentation was running – please run it again.', true);
        return;
      }
      const added = app.applyAiSegmentation({ cls: d.cls, margin: d.margin, counts: d.counts }, 'DentalSegmentator');
      const secs = (performance.now() - t0) / 1000;
      finish(
        added.length
          ? `DentalSegmentator: ${added.map((g) => g.name.toLowerCase()).join(', ')} segmented in ${fmtTime(secs)} (${d.device === 'webgpu' ? 'graphics card' : 'CPU'}). Check them before planning.`
          : 'DentalSegmentator found no jaw or teeth in this region.',
        !added.length,
      );
    } else if (d.type === 'error') {
      finish(`Automatic segmentation failed: ${d.message}`, true);
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    finish(`Automatic segmentation failed: ${e.message || 'the worker could not start'}`, true);
  };
  foot.textContent = '';
  worker.postMessage(msg, [data.buffer]);
}
