// Settings shown inside the views: panoramic slab / slice and cross-section spacing, 3D rendering
// mode, thresholds and direction presets.

import type { RenderMode } from '../app';
import { $, app } from './shell';

const slab = $<HTMLInputElement>('slab');
const spacing = $<HTMLInputElement>('spacing');
slab.oninput = () => {
  if (app.panoMode === 'slab') app.panoSlab = Number(slab.value);
  else app.panoSlice = Number(slab.value);
  app.changed();
};
$('btn-pano-center').onclick = () => {
  app.panoOffset = 0;
  app.changed();
};
const panoModeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#pano-mode button'));
panoModeButtons.forEach((b) => (b.onclick = () => app.setPanoMode(b.dataset.pm as 'slab' | 'slice')));
spacing.oninput = () => {
  app.crossSpacing = Number(spacing.value);
  app.changed();
};

// ---- 3D panel ------------------------------------------------------------------
const vrButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#vr-mode button'));
vrButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.vr.mode = b.dataset.vr as RenderMode;
      app.changed();
    }),
);
const vrLo = $<HTMLInputElement>('vr-lo');
const vrHi = $<HTMLInputElement>('vr-hi');
const vrLoNum = $<HTMLInputElement>('vr-lo-num');
const vrHiNum = $<HTMLInputElement>('vr-hi-num');
/** The lower threshold (3D surface, new segment clicks) – set from the menu, the 3D bar and the Segments panel. */
export const setLo = (v: number) => {
  if (!Number.isFinite(v)) return;
  app.vr.lo = Math.round(v);
  if (app.vr.hi < v) app.vr.hi = v;
  app.changed();
};

/** Lower-threshold controls (a range and a number) kept in step with the app. */
const loControls: { range: HTMLInputElement; num: HTMLInputElement; typing: boolean }[] = [];
export function bindLowerThreshold(range: HTMLInputElement, num: HTMLInputElement) {
  const c = { range, num, typing: false };
  range.oninput = () => setLo(Number(range.value));
  // a typed value applies on Enter / leaving the field; meanwhile it is not overwritten
  num.oninput = () => (c.typing = true);
  num.onchange = () => {
    c.typing = false;
    setLo(Number(num.value));
  };
  num.onblur = () => (c.typing = false);
  loControls.push(c);
}
bindLowerThreshold($<HTMLInputElement>('v3d-thr-range'), $<HTMLInputElement>('v3d-thr-num'));
const setHi = (v: number) => {
  if (!Number.isFinite(v)) return;
  app.vr.hi = v;
  if (app.vr.lo > v) app.vr.lo = v;
  app.changed();
};
vrLo.oninput = () => setLo(Number(vrLo.value));
vrHi.oninput = () => setHi(Number(vrHi.value));
vrLoNum.onchange = () => setLo(Number(vrLoNum.value));
vrHiNum.onchange = () => setHi(Number(vrHiNum.value));
$('btn-vr-auto').onclick = () => {
  if (!app.vol) return;
  app.vr.lo = Math.round(app.vol.boneThreshold());
  app.vr.hi = app.vol.max;
  app.changed();
};
document.querySelectorAll<HTMLButtonElement>('.presets button').forEach(
  (b) => (b.onclick = () => app.view3d.setPreset(b.dataset.preset as 'front')),
);
$('btn-3d-reset').onclick = () => app.view3d.fit();

export function refreshViewSettings() {
  const vol = app.vol;
  const vrName = { surface: 'Surface', translucent: 'Translucent', mip: 'MIP' }[app.vr.mode];
  const vrLabel = app.vr.mode === 'mip' ? `${vrName} ▾` : `${vrName} ${Math.round(app.vr.lo)}+ ▾`;
  if ($('btn-vr-menu').textContent !== vrLabel) $('btn-vr-menu').textContent = vrLabel;
  const panoLabel = `${app.panoThickness()} mm · sections ${app.crossSpacing} mm ▾`;
  if ($('btn-pano-menu').textContent !== panoLabel) $('btn-pano-menu').textContent = panoLabel;
  panoModeButtons.forEach((b) => b.classList.toggle('active', b.dataset.pm === app.panoMode));
  const isSlab = app.panoMode === 'slab';
  slab.min = isSlab ? '2' : '0';
  slab.max = isSlab ? '30' : '5';
  slab.step = isSlab ? '1' : '0.5';
  slab.value = String(app.panoThickness());
  $('slab-label').textContent = isSlab ? 'Slab thickness' : 'Slice thickness';
  $('slab-val').textContent = `${app.panoThickness()} mm`;
  $('pano-off').textContent = `${app.panoOffset > 0 ? '+' : ''}${app.panoOffset.toFixed(1)} mm ${app.panoOffset > 0 ? '(buccal)' : app.panoOffset < 0 ? '(lingual)' : ''}`;
  spacing.value = String(app.crossSpacing);
  $('spacing-val').textContent = `${app.crossSpacing} mm`;
  // 3D
  vrButtons.forEach((b) => b.classList.toggle('active', b.dataset.vr === app.vr.mode));
  if (vol) {
    for (const r of [vrLo, vrHi]) {
      r.min = String(vol.min);
      r.max = String(vol.max);
      r.step = String(Math.max(1, Math.round((vol.max - vol.min) / 500)));
    }
  }
  for (const { range, num, typing } of loControls) {
    if (vol) {
      range.min = num.min = String(vol.min);
      range.max = num.max = String(vol.max);
      range.step = String(Math.max(1, Math.round((vol.max - vol.min) / 500)));
    }
    if (document.activeElement !== range) range.value = String(app.vr.lo);
    if (!typing) num.value = String(Math.round(app.vr.lo));
  }
  // the bar is for surfaces (MIP uses window / level)
  $('v3d-thr').classList.toggle('hidden', !vol || app.vr.mode === 'mip');
  if (document.activeElement !== vrLo) vrLo.value = String(app.vr.lo);
  if (document.activeElement !== vrHi) vrHi.value = String(app.vr.hi);
  if (document.activeElement !== vrLoNum) vrLoNum.value = String(Math.round(app.vr.lo));
  if (document.activeElement !== vrHiNum) vrHiNum.value = String(Math.round(app.vr.hi));
}
