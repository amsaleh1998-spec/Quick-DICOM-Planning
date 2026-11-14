// Desktop interface. Each part lives in src/ui/ (one module per panel or area); this file only
// wires the top bar together and redraws everything when the app state changes.

import { showTrackpadGuide } from './tutorial';
import { bindPopover } from './ui/popover';
import { showHelp } from './ui/help';
import { $, app } from './ui/shell';
import { refreshLayout } from './ui/layout';
import { renderRecent, saveProject } from './ui/files';
import './ui/install';
import { refreshPatient } from './ui/patient';
import { refreshSettings } from './ui/settings';
import { refreshReorientPanel } from './ui/reorientPanel';
import { refreshCurvePanel } from './ui/curvePanel';
import { refreshImplantsPanel } from './ui/implantsPanel';
import { refreshWaxupPanel } from './ui/waxupPanel';
import { refreshSegmentsPanel } from './ui/segmentsPanel';
import { refreshNervesPanel } from './ui/nervesPanel';
import { refreshScanUi } from './ui/scansPanel';
import { refreshViewSettings } from './ui/viewSettings';
import { refreshUndo } from './ui/undoUi';
import { refreshObjects } from './ui/objectsPanel';
import './ui/keyboard';
import './ui/report';
import './ui/libraryPanel';

// ---- top bar -------------------------------------------------------------------
bindPopover($('btn-open-menu'), $('pop-open'), { onOpen: () => void renderRecent() });
bindPopover($('btn-export-menu'), $('pop-export'));
bindPopover($('patient-chip'), $('pop-patient'));
bindPopover($('btn-settings'), $('pop-settings'), { align: 'right' });
$('btn-export-save').onclick = () => saveProject();
$('btn-help').onclick = () => showHelp({ trackpadGuide: () => showTrackpadGuide() });

// window / level
const ww = $<HTMLInputElement>('ww');
const wc = $<HTMLInputElement>('wc');
app.onWindowChange = () => {
  if (document.activeElement !== ww) ww.value = String(Math.round(app.wl.width));
  if (document.activeElement !== wc) wc.value = String(Math.round(app.wl.center));
};
ww.oninput = () => app.setWindow(app.wl.center, Number(ww.value) || 1);
wc.oninput = () => app.setWindow(Number(wc.value) || 0, app.wl.width);
$('btn-auto-wl').onclick = () => app.autoWindow();

// ruler
$('btn-ruler').onclick = () => app.setRuler(!app.ruler);
$('btn-clear-measure').onclick = () => app.clearMeasurements();

// Keep pinch / ctrl+wheel from zooming the whole page (and Safari's page pinch)
window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
for (const g of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(g, (e) => e.preventDefault());

// offline support + installability (production build only; the dev server reloads too often)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
}

// ---- state -> UI -----------------------------------------------------------------
/** Sliders are filled up to their thumb (style.css): keep that in step with their values. */
function syncSliders() {
  for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
    const min = Number(r.min || 0), max = Number(r.max || 100);
    r.style.setProperty('--fill', `${max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0}%`);
  }
}
document.addEventListener('input', (e) => (e.target as HTMLElement).matches?.('input[type="range"]') && syncSliders(), true);

function refreshUi() {
  refreshLayout();
  refreshPatient();
  refreshSettings();
  refreshUndo();
  $('btn-ruler').classList.toggle('active', app.ruler);
  $('btn-clear-measure').toggleAttribute('disabled', !app.measurements.length);
  refreshViewSettings();
  refreshReorientPanel();
  refreshCurvePanel();
  refreshWaxupPanel();
  refreshImplantsPanel();
  refreshSegmentsPanel();
  refreshNervesPanel();
  refreshScanUi();
  refreshObjects();
  syncSliders();
}
app.onStateChange = refreshUi;

refreshUi();
app.onWindowChange();
app.requestRender();
