// Panoramic curve panel: draw / add / clear curves, the curve list and its name.

import { $, app, escapeHtml } from './shell';

// ---- planning panel ---------------------------------------------------------------
$('btn-draw-curve').onclick = () => {
  if (!app.vol) return;
  if (app.drawing) app.finishCurve();
  else app.startDrawing(); // (re)draws the active curve
};
$('btn-add-curve').onclick = () => {
  if (!app.vol) return;
  if (app.drawing) app.cancelDrawing();
  app.startDrawing(true); // an additional curve
};
$('btn-clear-curve').onclick = () => app.clearCurve();
const curveList = $('curve-list');
curveList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]');
  if (li) app.activateCurve(Number(li.dataset.id));
});
const curveName = $<HTMLInputElement>('curve-name');
curveName.oninput = () => {
  const sl = app.activeSlot();
  if (sl && curveName.value.trim()) app.renameCurve(sl.id, curveName.value);
};

export function refreshCurvePanel() {
  const draw = $('btn-draw-curve');
  draw.textContent = app.drawing ? 'Finish curve' : app.curve ? 'Redraw' : 'Draw panoramic curve';
  draw.classList.toggle('active', !!app.drawing);
  $('btn-add-curve').classList.toggle('hidden', !app.curve || !!app.drawing);
  $('btn-clear-curve').classList.toggle('hidden', !app.curve);
  // curve list (only useful with more than one curve)
  const sl = app.activeSlot();
  $('curve-name-row').classList.toggle('hidden', !sl);
  if (sl && document.activeElement !== curveName) curveName.value = sl.name;
  const listHtml =
    app.curves.length > 1
      ? app.curves
          .map(
            (c) =>
              `<li data-id="${c.id}" class="${c.id === app.activeCurveId ? 'sel' : ''}" title="Show this curve in the panoramic, cross-sections and tangential view">` +
              `<span class="dot"></span>${escapeHtml(c.name)}<span class="dim">${c.curve.length.toFixed(0)} mm</span></li>`,
          )
          .join('')
      : '';
  if (curveList.innerHTML !== listHtml) curveList.innerHTML = listHtml;
}
