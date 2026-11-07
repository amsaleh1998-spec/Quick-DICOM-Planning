// ① Reorient panel: rotate / crop tools, straighten, apply.

import type { MprTool } from '../app';
import { $, app, hideLoading, setStatus, showLoading } from './shell';

// ---- MPR panel -------------------------------------------------------------------
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mpr-tools button'));
toolButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.mprTool = b.dataset.tool as MprTool;
      app.changed();
    }),
);
$('btn-straighten').onclick = () => app.straightenViews();
$('btn-reset-rot').onclick = () => app.resetRotation();
$('btn-reset-crop').onclick = () => app.resetCrop();
$('btn-apply').onclick = async () => {
  if (!app.vol) return;
  try {
    showLoading('Resampling volume…', 0);
    await app.applyCropAndRotation((f) => showLoading('Resampling volume…', f));
    setStatus(`Resampled to ${app.vol.nx}×${app.vol.ny}×${app.vol.nz} voxels (${app.vol.spacing[0].toFixed(2)} mm)`);
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    hideLoading();
  }
};

export function refreshReorientPanel() {
  const vol = app.vol;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === app.mprTool));
  const tilt = [0, 1, 2].map((i) => app.viewTiltDeg(i));
  $('mpr-status').textContent = vol
    ? `Tilt – axial ${tilt[0].toFixed(1)}°, coronal ${tilt[1].toFixed(1)}°, sagittal ${tilt[2].toFixed(1)}°` +
      (app.cropIsFull() ? '' : ' · crop active')
    : '';
}
