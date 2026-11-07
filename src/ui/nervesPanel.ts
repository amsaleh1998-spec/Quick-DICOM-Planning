// Nerves panel: trace the mandibular canals, diameter, points.

import { nerveLength } from '../nerve';
import { $, app, clampNum, escapeHtml, setList } from './shell';

$('btn-nerve-right').onclick = () => app.traceNerve('right');
$('btn-nerve-left').onclick = () => app.traceNerve('left');
const nerveD = $<HTMLInputElement>('nerve-d');
nerveD.oninput = () => {
  const n = app.activeNerve();
  if (n && nerveD.value) {
    n.diameter = clampNum(nerveD.value, 0.5, 8, n.diameter);
    app.changed();
  }
};
$('btn-nerve-trace').onclick = () => {
  const n = app.activeNerve();
  if (!n) return;
  if (app.segTool === 'nerve') app.setSegTool(null);
  else app.traceNerve(n.side);
};
$('btn-nerve-undo').onclick = () => app.undoNervePoint();
$('btn-nerve-delete').onclick = () => app.activeNerveId !== null && app.deleteNerve(app.activeNerveId);

const nerveList = $('nerve-list');

export function refreshNervesPanel() {
  const tool = app.segTool;
  setList(
    nerveList,
    app.nerves.map((n) => ({
      key: String(n.id),
      sel: n.id === app.activeNerveId,
      html: `<span class="swatch" style="background:#ffd60a"></span><span class="name">${escapeHtml(n.name)}</span><span class="dim">${n.pts.length} pts${n.pts.length >= 2 ? ` · ${nerveLength(n).toFixed(0)} mm` : ''}</span><button data-act="eye" class="${n.visible ? '' : 'off'}" title="Show / hide">${n.visible ? 'Hide' : 'Show'}</button>`,
      onClick: () => app.selectNerve(n.id),
      onButton: () => {
        n.visible = !n.visible;
        app.changed();
      },
    })),
  );
  for (const side of ['right', 'left'] as const) {
    const b = $(`btn-nerve-${side}`);
    const active = tool === 'nerve' && app.activeNerve()?.side === side;
    b.classList.toggle('active', active);
    b.textContent = active ? 'Tracing… (Esc)' : `${app.nerves.some((n) => n.side === side) ? 'Edit' : 'Trace'} ${side} nerve`;
  }
  const n = app.activeNerve();
  $('nerve-edit').classList.toggle('hidden', !n);
  if (n) {
    if (document.activeElement !== nerveD) nerveD.value = n.diameter.toFixed(1);
    const tr = $('btn-nerve-trace');
    tr.classList.toggle('active', tool === 'nerve');
    tr.textContent = tool === 'nerve' ? 'Done' : 'Add points';
    $('nerve-info').textContent =
      n.pts.length < 2 ? 'Click at least two points along the canal.' : `${n.pts.length} points · ${nerveLength(n).toFixed(1)} mm long`;
    $('btn-nerve-undo').toggleAttribute('disabled', !n.pts.length);
  }
  for (const id of ['btn-nerve-right', 'btn-nerve-left']) $(id).toggleAttribute('disabled', !app.vol);
}
