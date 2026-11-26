// Automatic jaw / teeth / canal segmentation with DentalSegmentator, run in the browser.
//
// Credits: DentalSegmentator – Dot G, et al. Journal of Dentistry (2024),
// doi:10.1016/j.jdent.2024.105130; weights doi:10.5281/zenodo.10829675 (CC BY 4.0); built on
// nnU-Net (Isensee F, et al. Nat Methods 2021). See dsPlan.ts / README.

import type { App } from '../app';
import { Vec3, fromFrame } from '../math';
import { DS_CREDIT, DS_MODEL, contextBox, modelAxes, modelGrid, occlusalSplit, patchCount } from './dsPlan';
import { nonzeroBox } from './dsEngine';
import { dedicatedGpuHelp, findGpu, gpuBuffersTooSmall, inEdge } from './gpu';
import type { StartMsg, WorkerMsg } from './dsWorker';
import { ServiceProgress, ServiceStatus, probeService, regionToLabels, segmentOnService } from './desktopAi';

export interface AiHooks {
  setStatus(text: string, error?: boolean): void;
}

export type AiJaw = 'both' | 'upper' | 'lower';
/** DentalSegmentator classes of each jaw: maxilla & upper teeth / mandible, lower teeth, canals */
export const JAW_CLASSES: Record<'upper' | 'lower', number[]> = { upper: [1, 3], lower: [2, 4, 5] };
/** how far a single jaw's region reaches past the occlusal plane (its crowns, cusps interlocking) */
const JAW_OVERLAP = 6;

/** The world axis closest to the patient's superior direction, and its sign. */
function superiorAxis(app: App): { a: number; s: 1 | -1 } {
  const up = app.frame[2];
  let a = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(up[k]) > Math.abs(up[a])) a = k;
  return { a, s: up[a] >= 0 ? 1 : -1 };
}

const splitCache = new WeakMap<object, Map<string, number>>();
/**
 * World boxes (CT voxel centres) for a run: `out` = where labels are written (whole scan, crop
 * box, and for one jaw its side of the occlusal plane plus a small overlap), `lo` / `hi` = what the
 * network sees (that with real context around it).
 */
function regionBox(app: App, region: 'all' | 'crop', jaw: AiJaw = 'both'): { lo: Vec3; hi: Vec3; out: { lo: Vec3; hi: Vec3 } | null } {
  const vol = app.vol!;
  const scan = { lo: [0, 0, 0] as Vec3, hi: [(vol.nx - 1) * vol.spacing[0], (vol.ny - 1) * vol.spacing[1], (vol.nz - 1) * vol.spacing[2]] as Vec3 };
  if (region === 'all' && jaw === 'both') return { ...scan, out: null };
  const base = region === 'crop' ? cropBox(app) : scan;
  const out = { lo: [...base.lo] as Vec3, hi: [...base.hi] as Vec3 };
  if (jaw !== 'both') {
    const { a, s } = superiorAxis(app);
    let c = splitCache.get(vol);
    if (!c) splitCache.set(vol, (c = new Map()));
    const key = JSON.stringify([region, base, a]);
    let level = c.get(key);
    if (level === undefined) {
      level = occlusalSplit(vol.data, vol.dims, vol.spacing, base.lo, base.hi, a, vol.boneThreshold());
      c.set(key, level);
    }
    // the maxilla lies on the superior side
    const towardsPlus = (jaw === 'upper') === (s > 0);
    if (towardsPlus) out.lo[a] = Math.max(out.lo[a], level - JAW_OVERLAP);
    else out.hi[a] = Math.min(out.hi[a], level + JAW_OVERLAP);
    const box = contextBox(out.lo, out.hi, scan.lo, scan.hi, modelAxes(vol.info.patientAffine));
    // across the occlusal plane the overlap is context enough: no extra margin there (fewer tiles),
    // as long as the region stays one tile deep
    const k = modelAxes(vol.info.patientAffine).ax.indexOf(a);
    const tile = DS_MODEL.patch[k] * DS_MODEL.spacing[k] - 2 * vol.spacing[a];
    if (towardsPlus) box.lo[a] = Math.max(box.lo[a], Math.min(out.lo[a], box.hi[a] - tile));
    else box.hi[a] = Math.min(box.hi[a], Math.max(out.hi[a], box.lo[a] + tile));
    // a jaw that fits in one tile's height: exactly one row of tiles (the context beyond it trimmed)
    if (out.hi[a] - out.lo[a] <= tile && box.hi[a] - box.lo[a] > tile) {
      if (towardsPlus) box.hi[a] = Math.max(out.hi[a], box.lo[a] + tile);
      else box.lo[a] = Math.min(out.lo[a], box.hi[a] - tile);
    }
    return { ...box, out };
  }
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
function tileCounts(app: App, region: 'all' | 'crop', jaw: AiJaw = 'both'): [number, number] {
  const vol = app.vol!;
  const r = regionBox(app, region, jaw);
  const b = nonzeroBox(vol.data, vol.dims, vol.spacing, r.lo, r.hi);
  const axes = modelAxes(vol.info.patientAffine);
  return [patchCount(modelGrid(b.lo, b.hi, vol.spacing, axes, 0.5)), patchCount(modelGrid(b.lo, b.hi, vol.spacing, axes, 1))];
}

const TILE_MM = DS_MODEL.patch.map((p, k) => Math.round(p * DS_MODEL.spacing[k])).join(' × ');

const fmtTime = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

type AiEngine = 'browser' | 'desktop';
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ENGINE_KEY = 'qdp.aiEngine';

let modal: HTMLDivElement | null = null;
let pill: HTMLDivElement | null = null;
let running: { cancel: () => void } | null = null;

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
  const countCache = new Map<string, [number, number]>();
  const countsFor = (region: 'all' | 'crop', jaw: AiJaw) => {
    const k = `${region}|${jaw}`;
    let c = countCache.get(k);
    if (!c) countCache.set(k, (c = tileCounts(app, region, jaw)));
    return c;
  };
  const hasAi = app.seg.segments.some((g) => g.ai);
  let engine: AiEngine = 'browser';
  try {
    if (localStorage.getItem(ENGINE_KEY) === 'desktop') engine = 'desktop';
  } catch {
    /* default */
  }
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
          <b>mandibular canals</b> with <b>DentalSegmentator</b>, a deep-learning model for CBCT and CT. It runs on this computer – the
          scan never leaves it.</p>
        <h4>Runs on</h4>
        <label class="check"><input type="radio" name="ai-engine" value="browser" ${engine === 'browser' ? 'checked' : ''} /> This browser – the web version of the model (62 MB, half-precision weights)</label>
        <label class="check"><input type="radio" name="ai-engine" value="desktop" ${engine === 'desktop' ? 'checked' : ''} /> Desktop AI service – the full model in the official nnU-Net, with mirrored passes (Windows, fastest with an NVIDIA card)</label>
        <div class="ai-desktop small hidden" id="ai-desktop"></div>
        <h4>Region</h4>
        <label class="check"><input type="radio" name="ai-region" value="all" ${cropped ? '' : 'checked'} /> Whole scan</label>
        <label class="check ${cropped ? '' : 'disabled'}"><input type="radio" name="ai-region" value="crop" ${cropped ? 'checked' : 'disabled'} /> Inside the crop box ${cropped ? '(faster)' : '(no crop box set)'}</label>
        <h4>Jaws</h4>
        <label class="check"><input type="radio" name="ai-jaw" value="both" checked /> Both jaws</label>
        <label class="check"><input type="radio" name="ai-jaw" value="upper" /> Maxilla only – maxilla &amp; upper teeth</label>
        <label class="check"><input type="radio" name="ai-jaw" value="lower" /> Mandible only – mandible, lower teeth &amp; canals</label>
        <p class="muted small">One jaw: the scan is split at the occlusal plane (found automatically) and only that side is computed – faster.
          ${hasAi ? 'The other jaw’s automatic segments are kept.' : 'The other jaw can be added later.'}</p>
        <div class="ai-browser-only">
          <h4>Quality</h4>
          <label class="check"><input type="radio" name="ai-step" value="0.5" checked /> Standard – overlapping tiles, as the original model</label>
          <label class="check"><input type="radio" name="ai-step" value="1" /> Fast – about 4× quicker, slightly less accurate at the tile borders</label>
        </div>
        <p class="muted small" id="ai-est"></p>
        <div class="ai-gpu small ai-browser-only" id="ai-gpu">Checking the graphics card…</div>
        ${hasAi ? '<p class="muted small">The automatic segments from the previous run are replaced (for one jaw: only that jaw’s).</p>' : ''}
        <p class="muted small ai-browser-only">The first run downloads the model (62 MB), later runs use the saved copy. A graphics card (WebGPU, Chrome / Edge) makes it many times faster than the CPU.</p>
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
        <a href="${DS_CREDIT.license}" target="_blank" rel="noopener">CC BY 4.0</a> – converted here to ONNX with half-precision weights for the browser; the desktop AI service runs the original weights in nnU-Net.
        Built on <b>nnU-Net</b> (Isensee F, et al. Nat Methods 2021;18(2):203-211, <a href="${DS_CREDIT.nnunetDoi}" target="_blank" rel="noopener">doi:10.1038/s41592-020-01008-z</a>),
        runs in the browser with ONNX Runtime Web. Also available for 3D Slicer as <a href="${DS_CREDIT.slicer}" target="_blank" rel="noopener">SlicerDentalSegmentator</a>.
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
    engine: (m.querySelector<HTMLInputElement>('input[name="ai-engine"]:checked')?.value ?? 'browser') as AiEngine,
    region: (m.querySelector<HTMLInputElement>('input[name="ai-region"]:checked')?.value ?? 'all') as 'all' | 'crop',
    step: Number(m.querySelector<HTMLInputElement>('input[name="ai-step"]:checked')?.value ?? 0.5),
    jaw: (m.querySelector<HTMLInputElement>('input[name="ai-jaw"]:checked')?.value ?? 'both') as AiJaw,
  });
  // the desktop AI service: looked for only when chosen (the browser may ask once to let the page
  // reach this computer's own service)
  let service: ServiceStatus | null = null;
  let probing = false;
  const desk = $<HTMLDivElement>('#ai-desktop');
  const checkService = async () => {
    probing = true;
    service = null;
    desk.className = 'ai-desktop small';
    desk.textContent = 'Looking for the desktop AI service…';
    updateEst();
    service = await probeService();
    // just started (e.g. after logging in): it loads PyTorch and checks the card first – wait for it
    for (let i = 0; service?.device === 'starting' && i < 60 && m.isConnected; i++) {
      desk.textContent = 'The desktop AI service is starting (loading PyTorch, checking the graphics card)…';
      await new Promise((r) => setTimeout(r, 2000));
      service = await probeService();
    }
    probing = false;
    if (service?.device === 'starting') {
      desk.className = 'ai-desktop small warn';
      desk.innerHTML = `The desktop AI service is still starting. <button class="ai-recheck">Check again</button>`;
      service = null;
    } else if (!service) {
      desk.className = 'ai-desktop small warn';
      desk.innerHTML = `<b>The desktop AI service is not running.</b> Installed already? Start it: Start menu → <b>QDP AI service</b>, wait a few
        seconds, then check again. Not yet: install it once (Windows, about 1–3 GB):
        <a href="${new URL('windows/Install-QDP-AI.cmd', document.baseURI).href}" download>Install-QDP-AI.cmd</a> – run it, and the service starts
        (afterwards with Windows). <button class="ai-recheck">Check again</button>`;
    } else if (!service.modelFound) {
      desk.className = 'ai-desktop small warn';
      desk.innerHTML = `The desktop AI service ${service.version} is running, but its model is missing – run the installer again. <button class="ai-recheck">Check again</button>`;
    } else {
      desk.className = `ai-desktop small ${service.device === 'cuda' ? 'ok' : 'warn'}`;
      const installer = `<a href="${new URL('windows/Install-QDP-AI.cmd', document.baseURI).href}" download>Install-QDP-AI.cmd</a>`;
      desk.innerHTML =
        service.device === 'cuda'
          ? `Connected – desktop AI service ${service.version} on <b>${escapeHtml(service.gpu ?? 'the graphics card')}</b> (CUDA)${service.busy ? ' · busy with another scan' : ''}`
          : service.gpuError
            ? `Connected – desktop AI service ${service.version}, but the graphics card <b>${escapeHtml(service.gpu ?? '')}</b> cannot run the model with the PyTorch installed
              (<span class="muted">${escapeHtml(service.gpuError)}</span>), so it runs on the <b>CPU</b> – slowly. Run the installer again (${installer}): it now installs a PyTorch build that runs on this card.
              <button class="ai-recheck">Check again</button>`
            : `Connected – desktop AI service ${service.version}, but on the <b>CPU</b> (no NVIDIA card found): the full model with mirrored passes takes long there – the browser on a graphics card is faster.`;
    }
    m.querySelector<HTMLButtonElement>('.ai-recheck')?.addEventListener('click', () => void checkService());
    updateEst();
  };
  const updateEst = () => {
    const o = opt();
    const desktop = o.engine === 'desktop';
    m.querySelectorAll<HTMLElement>('.ai-browser-only').forEach((el) => el.classList.toggle('hidden', desktop));
    desk.classList.toggle('hidden', !desktop);
    $<HTMLButtonElement>('#ai-go').disabled = desktop && (probing || !service?.modelFound);
    const n = countsFor(o.region, o.jaw)[desktop || o.step !== 1 ? 0 : 1];
    $('#ai-est').textContent = desktop
      ? `${n} tile${n === 1 ? '' : 's'} of ${TILE_MM} mm, each computed 8 times (mirrored) – with an NVIDIA card typically ${fmtTime(n * 1.5)}–${fmtTime(n * 6)}${service && service.device !== 'cuda' ? `, on the CPU ${fmtTime(n * 60)} or more` : ''}.`
      : `${n} tile${n === 1 ? '' : 's'} of ${TILE_MM} mm to compute – roughly ${fmtTime(n * 1)}–${fmtTime(n * 5)} with a graphics card, ${fmtTime(n * 10)}–${fmtTime(n * 40)} on the CPU.`;
  };
  m.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'ai-engine') {
      try {
        localStorage.setItem(ENGINE_KEY, t.value);
      } catch {
        /* not remembered */
      }
      if (t.value === 'desktop' && !service && !probing) void checkService();
    }
    updateEst();
  });
  updateEst();
  if (engine === 'desktop') void checkService();
  // (its result replaces the box's classes: shown or hidden again for the engine chosen)
  void showGpu(m.querySelector<HTMLDivElement>('#ai-gpu')!).then(updateEst);

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
    el.className = 'ai-gpu ai-browser-only small warn';
    el.innerHTML = `<b>No usable graphics card</b> (${g}) – the model runs on the CPU, which is much slower. Use a current Chrome or Edge.`;
  } else if (gpuBuffersTooSmall(g)) {
    el.className = 'ai-gpu ai-browser-only small warn';
    el.innerHTML = `Graphics card: <b>${g.label}</b> – too little memory for the model, it runs on the CPU (much slower).`;
  } else if (g.integrated) {
    el.className = 'ai-gpu ai-browser-only small warn';
    el.innerHTML = `Graphics card: <b>${g.label}</b> (integrated – slow). If this computer also has an <b>NVIDIA</b> or AMD
      graphics card, ${inEdge() ? 'Edge' : 'Chrome'} is not using it: on Windows the browser uses the card Windows assigns to it, whatever the page asks for.
      <details><summary>Run only this app on the NVIDIA card (many times faster)</summary>${dedicatedGpuHelp(new URL('./', document.baseURI).href)}</details>`;
  } else {
    el.className = 'ai-gpu ai-browser-only small ok';
    el.innerHTML = `Graphics card: <b>${g.label}</b>`;
  }
}

function start(app: App, hooks: AiHooks, m: HTMLDivElement, o: { engine: AiEngine; region: 'all' | 'crop'; step: number; jaw: AiJaw }, onEnd: () => void) {
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
  const r = regionBox(app, o.region, o.jaw);
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
  const gridKey = JSON.stringify([seg.nx, seg.ny, seg.nz, seg.gs]);
  const t0 = performance.now();
  let tilesStart = 0;
  let stop = () => {};
  const end = () => {
    stop();
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

  /** The labels on the app's grid: segments, nerve paths along the canals, the status. */
  const applyResult = (d: { cls: Uint8Array; margin: Uint8Array; counts: number[] }, where: string) => {
      if (app.vol !== vol || JSON.stringify([app.seg.nx, app.seg.ny, app.seg.nz, app.seg.gs]) !== gridKey) {
        finish('The scan changed while the automatic segmentation was running – please run it again.', true);
        return;
      }
      const secs = (performance.now() - t0) / 1000;
      // (the mandibular canals become nerve paths, and their segment is removed)
      const added = app.applyAiSegmentation({ cls: d.cls, margin: d.margin, counts: d.counts }, 'DentalSegmentator', o.jaw === 'both' ? null : JAW_CLASSES[o.jaw], (nerves) => {
        const segs = added.filter((g) => !(nerves.length && g.ai?.cls === 5)).map((g) => g.name.toLowerCase());
        const traced = nerves.length
          ? ` Nerve path${nerves.length > 1 ? 's' : ''} traced along the mandibular canal${nerves.length > 1 ? 's' : ''} (${nerves.join(' and ')}) – check ${nerves.length > 1 ? 'them' : 'it'} on the cross-sections.`
          : '';
        hooks.setStatus(
          added.length
            ? `DentalSegmentator: ${segs.join(', ')} segmented in ${fmtTime(secs)} (${where}).${traced} Check them before planning.`
            : 'DentalSegmentator found no jaw or teeth in this region.',
          !added.length,
        );
      });
      finish('Showing the automatic segmentation…');
  };

  if (o.engine === 'desktop') {
    // the full model on the desktop AI service
    const ac = new AbortController();
    stop = () => ac.abort();
    setProgress(0, 'Sending the scan to the desktop AI service…', `${(data.byteLength / 1e6).toFixed(0)} MB`);
    let tiles0 = 0, t1 = 0;
    segmentOnService(
      data,
      dims,
      spacing,
      vol.info.patientAffine,
      (s: ServiceProgress) => {
        if (s.total && s.done) {
          if (!t1) {
            t1 = performance.now();
            tiles0 = s.done;
          }
          const el = (performance.now() - t1) / 1000;
          const per = s.done > tiles0 ? el / (s.done - tiles0) : 0;
          const left = per * (s.total - s.done);
          setProgress(0.1 + (0.85 * s.done) / s.total, `Segmenting… ${Math.round((100 * s.done) / s.total)} %${per && s.done < s.total ? ` · about ${fmtTime(left)} left` : ''}`, `tile ${s.done} of ${s.total} · full model, 8 mirrored passes · desktop AI service`);
        } else setProgress(s.phase.startsWith('Finishing') ? 0.96 : 0.05, s.phase || 'Working…', 'desktop AI service');
      },
      ac.signal,
    )
      .then((res) => {
        if (!running) return; // cancelled meanwhile
        setProgress(0.98, 'Finishing…', '');
        const lab = regionToLabels(res.cls, res.margin, dims, spacing, origin, { nx: seg.nx, ny: seg.ny, nz: seg.nz, gs: [...seg.gs] as Vec3 }, r.out ?? undefined);
        applyResult(lab, 'full model, desktop AI service');
      })
      .catch((e: Error) => {
        if (!running || e.name === 'AbortError') return;
        finish(`Automatic segmentation failed: ${e.message.includes('fetch') ? 'the desktop AI service stopped answering' : e.message}`, true);
      });
    foot.textContent = '';
    return;
  }

  // in this browser: a background worker with the web version of the model
  const worker = new Worker(new URL('./dsWorker.ts', import.meta.url), { type: 'module' });
  stop = () => worker.terminate();
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
      applyResult(d, d.device === 'webgpu' ? 'graphics card' : 'CPU');
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
