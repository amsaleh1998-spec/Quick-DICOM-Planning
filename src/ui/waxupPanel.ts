// Waxup panel: tooth chart (add / remove positions), tools (position, parts, freeform), options
// (chain, mirror, single tooth / whole jaw), brush, the selected tooth, display.

import { jawOrder, type Jaw } from '../waxup/library';
import { Waxup } from '../waxup/waxup';
import { addTeeth, refitJaw, removeTooth, type WaxTool } from '../waxup/waxApp';
import { $, app, fromHex, hideLoading, setStatus, showLoading, toHex } from './shell';

const wax = app.wax;
const chart = $('wax-chart');

// chart: upper 18..11 | 21..28 above, lower 48..41 | 31..38 below (as seen from the front)
for (const jaw of ['upper', 'lower'] as Jaw[]) {
  const row = document.createElement('div');
  row.className = `wax-row ${jaw}`;
  jawOrder(jaw).forEach((fdi, i) => {
    const b = document.createElement('button');
    b.dataset.fdi = String(fdi);
    b.textContent = String(fdi);
    if (i === 8) b.classList.add('mid');
    row.append(b);
  });
  chart.append(row);
}

async function add(fdis: number[]) {
  showLoading('Loading the tooth library…', 0.4);
  try {
    const err = await addTeeth(app, fdis);
    if (err) setStatus(err, true);
    else app.commitHistory();
  } finally {
    hideLoading();
  }
}

chart.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-fdi]');
  if (!b) return;
  const fdi = Number(b.dataset.fdi);
  if (wax.model.tooth(fdi)) {
    // a click on a present tooth selects it; a second click removes it
    if (wax.selected !== fdi) {
      wax.selected = fdi;
      app.changed();
    } else removeTooth(app, fdi);
  } else void add([fdi]);
});
const missing = (jaw: Jaw) => jawOrder(jaw).filter((f) => f % 10 !== 8 && !wax.model.tooth(f));
$('wax-all-upper').onclick = () => void add(missing('upper'));
$('wax-all-lower').onclick = () => void add(missing('lower'));
$('wax-clear').onclick = () => {
  if (!wax.model.teeth.length) return;
  app.commitHistory();
  for (const t of [...wax.model.teeth]) removeTooth(app, t.fdi);
  setStatus('All waxup teeth removed – Ctrl+Z brings them back.');
};

const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#wax-tool button'));
toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.wt as WaxTool)));
export function setTool(t: WaxTool) {
  wax.tool = t;
  wax.hoverPart = null;
  app.changed();
}
const scopeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#wax-scope button'));
scopeButtons.forEach(
  (b) =>
    (b.onclick = () => {
      wax.scope = b.dataset.ws as 'tooth' | 'jaw';
      app.changed();
    }),
);
const chain = $<HTMLInputElement>('wax-chain');
const mirror = $<HTMLInputElement>('wax-mirror');
chain.onchange = () => ((wax.chain = chain.checked), app.changed());
mirror.onchange = () => ((wax.mirror = mirror.checked), app.changed());
const radius = $<HTMLInputElement>('wax-radius');
const strength = $<HTMLInputElement>('wax-strength');
radius.oninput = () => ((wax.brushRadius = Number(radius.value)), app.changed());
strength.oninput = () => ((wax.brushStrength = Number(strength.value)), app.changed());

$('wax-reset').onclick = () => {
  if (wax.selected === null) return;
  wax.model.reset(wax.selected);
  app.changed();
};
$('wax-remove').onclick = () => wax.selected !== null && removeTooth(app, wax.selected);

const color = $<HTMLInputElement>('wax-color');
const opacity = $<HTMLInputElement>('wax-opacity');
color.oninput = () => ((wax.color = fromHex(color.value)), app.changed());
opacity.oninput = () => ((wax.opacity = Number(opacity.value)), app.changed());
const contours = $<HTMLInputElement>('wax-contours');
contours.onchange = () => ((wax.contours = contours.checked), app.changed());
for (const jaw of ['upper', 'lower'] as Jaw[]) {
  const cb = $<HTMLInputElement>(`wax-show-${jaw}`);
  cb.onchange = () => ((wax.visible[jaw] = cb.checked), app.changed());
  $(`wax-refit-${jaw}`).onclick = async () => {
    if (!wax.model.teeth.some((t) => t.jaw === jaw)) return;
    app.commitHistory();
    const err = await refitJaw(app, jaw);
    setStatus(err ?? `The ${jaw} teeth are set up again on the current curve – Ctrl+Z restores their previous places.`, !!err);
  };
}

const HELP: Record<WaxTool, [string, string][]> = {
  position: [
    ['Drag', 'Move (in the view plane)'],
    ['Shift + drag', 'Scale'],
    ['Ctrl + drag', 'Rotate (around the view axis)'],
    ['Click', 'Select · Del removes'],
  ],
  parts: [
    ['Drag a dot', 'Move the cusp / incisal edge'],
    ['Shift + drag', 'Scale the part'],
    ['Ctrl + drag', 'Rotate the part'],
  ],
  freeform: [
    ['Drag', 'Add material (3D view)'],
    ['Ctrl + drag', 'Remove material'],
    ['Shift + drag', 'Smooth'],
  ],
};

export function refreshWaxupPanel() {
  const m = wax.model;
  for (const b of chart.querySelectorAll<HTMLButtonElement>('button[data-fdi]')) {
    const fdi = Number(b.dataset.fdi);
    b.classList.toggle('on', !!m.tooth(fdi));
    b.classList.toggle('sel', fdi === wax.selected);
    b.title = m.tooth(fdi) ? (fdi === wax.selected ? `${fdi}: click again to remove` : `${fdi}: click to select`) : `Add tooth ${fdi}`;
  }
  const noCurve = !app.curves.length;
  for (const id of ['wax-all-upper', 'wax-all-lower']) $(id).toggleAttribute('disabled', noCurve || !app.vol);
  chart.classList.toggle('disabled', noCurve || !app.vol);
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.wt === wax.tool));
  scopeButtons.forEach((b) => b.classList.toggle('active', b.dataset.ws === wax.scope));
  $('wax-pos-opts').classList.toggle('hidden', wax.tool !== 'position');
  $('wax-free-opts').classList.toggle('hidden', wax.tool !== 'freeform');
  chain.checked = wax.chain;
  mirror.checked = wax.mirror;
  $('wax-radius-val').textContent = `${wax.brushRadius.toFixed(1)} mm`;
  $('wax-strength-val').textContent = `${Math.round(wax.brushStrength * 100)} %`;
  if (document.activeElement !== radius) radius.value = String(wax.brushRadius);
  if (document.activeElement !== strength) strength.value = String(wax.brushStrength);
  const help = HELP[wax.tool].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const helpEl = $('wax-help');
  if (helpEl.dataset.tool !== wax.tool) {
    helpEl.innerHTML = help;
    helpEl.dataset.tool = wax.tool;
  }
  const sel = m.tooth(wax.selected);
  $('wax-sel').classList.toggle('hidden', !sel);
  if (sel) {
    $('wax-sel-name').textContent = wax.scope === 'jaw' ? `${sel.jaw === 'upper' ? 'Upper' : 'Lower'} jaw (${sel.fdi})` : `Tooth ${sel.fdi}`;
    $('wax-sel-info').textContent = `${Math.round(Waxup.scaleOf(sel) * 100)} %${sel.geo ? ' · shaped' : ''}`;
  }
  if (document.activeElement !== color) color.value = toHex(wax.color);
  if (document.activeElement !== opacity) opacity.value = String(wax.opacity);
  $('wax-opacity-val').textContent = `${Math.round(wax.opacity * 100)} %`;
  contours.checked = wax.contours;
  for (const jaw of ['upper', 'lower'] as Jaw[]) $<HTMLInputElement>(`wax-show-${jaw}`).checked = wax.visible[jaw];
}
