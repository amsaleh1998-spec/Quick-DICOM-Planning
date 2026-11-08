// Waxup panel: tooth chart (add / remove positions), then a tooth placement window with three
// tabs – Simple (move / rotate / scale, direction limits, all teeth at once), Advanced (axis
// scaling, cusps, freeform, symmetry) and Chain (chain / single / tube, pins, reset, options) –
// the selected tooth and the display.

import { jawOrder, type Jaw } from '../waxup/library';
import { Waxup } from '../waxup/waxup';
import { addTeeth, refitJaw, removeTooth, type ChainMode, type WaxAction, type WaxAdvTool, type WaxLimit, type WaxTab } from '../waxup/waxApp';
import { chainsOf, resetPositions, settleChain, toothPin } from '../waxup/chain';
import { $, app, fromHex, hideLoading, setStatus, showLoading, toHex } from './shell';
import { undoRedo } from './undoUi';

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

// ---- Simple / Advanced / Chain -----------------------------------------------------------

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-wtab]'));
const pages = Array.from(document.querySelectorAll<HTMLElement>('#panel-waxup .wax-page'));
tabs.forEach((b) => (b.onclick = () => ((wax.tab = b.dataset.wtab as WaxTab), (wax.hoverPart = null), closeReset(), app.changed())));
const actionButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-wa]'));
actionButtons.forEach((b) => (b.onclick = () => ((wax.action = b.dataset.wa as WaxAction), app.changed())));
const limitRadios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="wax-limit"]'));
limitRadios.forEach((r) => (r.onchange = () => r.checked && ((wax.limit = r.value as WaxLimit), app.changed())));
const moveAll = $<HTMLInputElement>('wax-move-all');
moveAll.onchange = () => ((wax.moveAll = moveAll.checked), app.changed());
const advButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-wv]'));
advButtons.forEach((b) => (b.onclick = () => ((wax.advTool = b.dataset.wv as WaxAdvTool), (wax.hoverPart = null), app.changed())));
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-cm]'));
modeButtons.forEach((b) => (b.onclick = () => ((wax.chainMode = b.dataset.cm as ChainMode), app.changed())));
for (const id of ['wax-sym', 'wax-csym'])
  $(id).onclick = () => {
    wax.mirror = !wax.mirror;
    setStatus(wax.mirror ? 'Symmetry on: every change is mirrored to the other side of the jaw.' : 'Symmetry off.');
    app.changed();
  };
$('wax-one').onclick = () => {
  wax.mirrorShape = !wax.mirrorShape;
  setStatus(wax.mirrorShape ? '1-to-1 mirroring on: the tooth on the other side becomes the mirror image of the tooth you change.' : '1-to-1 mirroring off.');
  app.changed();
};
const scalable = $<HTMLInputElement>('wax-scalable');
const contact = $<HTMLInputElement>('wax-contact');
const showChain = $<HTMLInputElement>('wax-show-chain');
const limitTilt = $<HTMLInputElement>('wax-limit-tilt');
scalable.onchange = () => ((wax.scalable = scalable.checked), app.changed());
contact.onchange = () => {
  wax.contact = contact.checked;
  if (wax.contact && wax.model.teeth.length) {
    // contacts are closed again (pinned teeth stay)
    app.commitHistory();
    const pinned = new Set(wax.model.teeth.filter((t) => wax.pins.has(toothPin(t.fdi))));
    for (const jaw of ['upper', 'lower'] as Jaw[]) for (const c of chainsOf(wax.model, jaw)) settleChain(wax.model, c, pinned, wax.scalable);
    setStatus('Contacts closed – Ctrl+Z restores the gaps.');
  }
  app.changed();
};
showChain.onchange = () => ((wax.showChain = showChain.checked), app.changed());
limitTilt.onchange = () => ((wax.limitTilt = limitTilt.checked), app.changed());

const resetMenu = $('wax-reset-menu');
const closeReset = () => resetMenu.classList.add('hidden');
$('wax-creset').onclick = (e) => {
  e.stopPropagation();
  resetMenu.classList.toggle('hidden');
};
resetMenu.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-reset]');
  if (!b) return;
  closeReset();
  const how = b.dataset.reset;
  const m = wax.model;
  if (how === 'cancel' || !m.teeth.length) return;
  app.commitHistory();
  if (how === 'global') {
    for (const t of m.teeth) m.reset(t.fdi);
    resetPositions(m, () => true, wax.scalable);
  } else resetPositions(m, (t) => how === 'all' || !wax.pins.has(toothPin(t.fdi)), wax.scalable);
  setStatus(
    { unpinned: 'Unpinned teeth are back on the arch', all: 'All teeth are back on the arch', global: 'All teeth are back to the library shape and place' }[how as 'all'] +
      ' – Ctrl+Z undoes it.',
  );
  app.changed();
});
document.addEventListener('pointerdown', (e) => {
  if (!resetMenu.classList.contains('hidden') && !(e.target as HTMLElement).closest('#wax-reset-menu, #wax-creset')) closeReset();
});
$('wax-undo').onclick = () => undoRedo(false);
$('wax-redo').onclick = () => undoRedo(true);

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

const KEYS: [string, string][] = [
  ['Ctrl + drag', 'Rotate'],
  ['Shift + drag', 'Scale'],
  ['Ctrl + Shift + drag', 'Scale in the drag direction'],
];
function help(): [string, string][] {
  if (wax.tab === 'advanced')
    return {
      axis: [
        ['Drag a handle', 'Scale along that axis (red: along the arch, green: buccal / lingual, blue: height)'],
        ['Drag the tooth', 'Move · Ctrl: rotate · Shift: scale'],
      ] as [string, string][],
      cusps: [
        ['Drag a dot', 'Move the cusp / incisal edge'],
        ['Shift + drag', 'Scale the part'],
        ['Ctrl + drag', 'Rotate the part'],
      ] as [string, string][],
      freeform: [
        ['Drag', 'Add material (3D view)'],
        ['Ctrl + drag', 'Remove material'],
        ['Shift + drag', 'Smooth'],
      ] as [string, string][],
    }[wax.advTool];
  if (wax.tab === 'chain')
    return [
      ['Drag a tooth', { chain: 'Move the chain', single: 'Move the tooth (neighbours follow)', tube: 'Slide the teeth along the tube' }[wax.chainMode]],
      ...KEYS.slice(0, wax.chainMode === 'single' ? 3 : 2),
      ['Click a green point', 'Pin the tooth / end (red: pinned)'],
      ['Drag a disc', 'Move that end of the chain'],
    ];
  return [['Drag', { move: 'Move', rotate: 'Rotate (around the tooth centre)', scale: 'Scale' }[wax.action]], ...KEYS, ['Click', 'Select · Del removes']];
}

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
  tabs.forEach((b) => {
    b.classList.toggle('active', b.dataset.wtab === wax.tab);
    b.setAttribute('aria-selected', String(b.dataset.wtab === wax.tab));
  });
  pages.forEach((pg) => pg.classList.toggle('hidden', pg.dataset.page !== wax.tab));
  actionButtons.forEach((b) => b.classList.toggle('active', b.dataset.wa === wax.action));
  limitRadios.forEach((r) => (r.checked = r.value === wax.limit));
  moveAll.checked = wax.moveAll;
  moveAll.disabled = m.teeth.length < 2;
  advButtons.forEach((b) => b.classList.toggle('active', b.dataset.wv === wax.advTool));
  modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.cm === wax.chainMode));
  for (const id of ['wax-sym', 'wax-csym']) {
    $(id).classList.toggle('active', wax.mirror);
    $(id).setAttribute('aria-pressed', String(wax.mirror));
  }
  $('wax-one').classList.toggle('active', wax.mirrorShape);
  $('wax-one').setAttribute('aria-pressed', String(wax.mirrorShape));
  scalable.checked = wax.scalable;
  contact.checked = wax.contact;
  contact.disabled = wax.chainMode === 'tube';
  contact.parentElement!.title = wax.chainMode === 'tube' ? 'In tube mode the teeth always stay in contact' : 'Neighbouring teeth stay in contact (switching it on again closes the contacts)';
  showChain.checked = wax.showChain;
  limitTilt.checked = wax.limitTilt;
  $<HTMLButtonElement>('wax-undo').disabled = app.undoCount === 0;
  $<HTMLButtonElement>('wax-redo').disabled = app.redoCount === 0;
  $('wax-free-opts').classList.toggle('hidden', !(wax.tab === 'advanced' && wax.advTool === 'freeform'));
  $('wax-radius-val').textContent = `${wax.brushRadius.toFixed(1)} mm`;
  $('wax-strength-val').textContent = `${Math.round(wax.brushStrength * 100)} %`;
  if (document.activeElement !== radius) radius.value = String(wax.brushRadius);
  if (document.activeElement !== strength) strength.value = String(wax.brushStrength);
  const h = help();
  const helpEl = $('wax-help');
  const hk = JSON.stringify(h);
  if (helpEl.dataset.key !== hk) {
    helpEl.innerHTML = h.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    helpEl.dataset.key = hk;
  }
  const sel = m.tooth(wax.selected);
  $('wax-sel').classList.toggle('hidden', !sel);
  if (sel) {
    $('wax-sel-name').textContent = wax.tab === 'simple' && wax.moveAll ? `${sel.jaw === 'upper' ? 'Upper' : 'Lower'} jaw (${sel.fdi})` : `Tooth ${sel.fdi}`;
    const pinned = wax.pins.has(toothPin(sel.fdi));
    $('wax-sel-info').textContent = `${Math.round(Waxup.scaleOf(sel) * 100)} %${sel.geo ? ' · shaped' : ''}${pinned ? ' · pinned' : ''}`;
  }
  if (document.activeElement !== color) color.value = toHex(wax.color);
  if (document.activeElement !== opacity) opacity.value = String(wax.opacity);
  $('wax-opacity-val').textContent = `${Math.round(wax.opacity * 100)} %`;
  contours.checked = wax.contours;
  for (const jaw of ['upper', 'lower'] as Jaw[]) $<HTMLInputElement>(`wax-show-${jaw}`).checked = wax.visible[jaw];
}
