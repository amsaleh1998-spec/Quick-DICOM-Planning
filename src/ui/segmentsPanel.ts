// Segments panel: automatic segmentation, the segment list and editing, manual region growing
// and cuts.

import { showDentalSegmentator } from '../ai/dentalSegmentator';
import { $, app, escapeHtml, fromHex, rgbCss, setList, setStatus, toHex } from './shell';

document.querySelectorAll<HTMLButtonElement>('[data-seg-preset]').forEach(
  (b) => (b.onclick = () => app.newSegment(Number(b.dataset.segPreset))),
);
const segName = $<HTMLInputElement>('seg-name');
const segColor = $<HTMLInputElement>('seg-color');
segName.oninput = () => {
  const s = app.activeSegment();
  if (s) {
    s.name = segName.value.slice(0, 40);
    app.changed();
  }
};
segName.onblur = () => {
  const s = app.activeSegment();
  if (s && !s.name.trim()) {
    s.name = `Segment ${s.id}`;
    app.changed();
  }
};
segName.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') segName.blur();
};
segColor.oninput = () => {
  const s = app.activeSegment();
  if (!s) return;
  const h = segColor.value;
  s.color = fromHex(h);
  app.changed();
};
const segOpacity = $<HTMLInputElement>('seg-opacity');
segOpacity.oninput = () => {
  const s = app.activeSegment();
  if (!s) return;
  s.opacity = Number(segOpacity.value);
  app.changed();
};
$('btn-ai-seg').onclick = () => showDentalSegmentator(app, { setStatus });
$('btn-seg-nerves').onclick = () => {
  if (app.activeSegId === null) return;
  const made = app.nervesFromCanal(app.activeSegId);
  setStatus(
    made.length
      ? `Nerve path${made.length > 1 ? 's' : ''} created along the canal (${made.join(' and ')}) – check them on the cross-sections; implants closer than 2 mm are flagged.`
      : 'No new nerve path: both sides are already traced (delete a nerve first to replace it) or the canal is too small.',
    !made.length,
  );
};
$('btn-seg-grow').onclick = () => app.setSegTool(app.segTool === 'grow' ? null : 'grow');
$('btn-seg-regrow').onclick = () => app.activeSegId !== null && app.regrowSegment(app.activeSegId);
$('btn-seg-undo').onclick = () => app.activeSegId !== null && app.undoSegmentClick(app.activeSegId);
$('btn-seg-clear').onclick = () => app.activeSegId !== null && app.clearSegment(app.activeSegId);
$('btn-seg-delete').onclick = () => app.activeSegId !== null && app.deleteSegment(app.activeSegId);
const segShowUnseg = $<HTMLInputElement>('seg-show-unseg');
const segShow2d = $<HTMLInputElement>('seg-show-2d');
segShowUnseg.onchange = () => {
  app.showUnsegmented = segShowUnseg.checked;
  app.changed();
};
segShow2d.onchange = () => {
  app.showSegOverlay = segShow2d.checked;
  app.changed();
};
$('btn-cut').onclick = () => (app.segTool === 'cut' ? app.setSegTool(null) : app.startCut());
const cutDepth = $<HTMLSelectElement>('cut-depth');
cutDepth.onchange = () => {
  app.cutDepth = cutDepth.value ? Number(cutDepth.value) : null;
  app.changed();
};

const segList = $('seg-list');
const cutList = $('cut-list');

export function refreshSegmentsPanel() {
  const seg = app.seg;
  const tool = app.segTool;
  setList(
    segList,
    seg.segments.map((g) => {
      const cm3 = (g.voxels * seg.voxelVolume) / 1000;
      const info = g.ai ? `AI · ${cm3.toFixed(2)} cm³` : g.seeds.length ? `${cm3.toFixed(2)} cm³` : 'empty – click it';
      return {
        key: String(g.id),
        sel: g.id === app.activeSegId,
        html: `<span class="swatch" style="background:${rgbCss(g.color)}"></span><span class="name">${escapeHtml(g.name)}</span><span class="dim">${info}</span><button data-act="eye" class="${g.visible ? '' : 'off'}" title="Show / hide">${g.visible ? 'Hide' : 'Show'}</button>`,
        onClick: () => app.selectSegment(g.id),
        onButton: () => app.setSegmentVisible(g.id, !g.visible),
      };
    }),
  );
  const s = app.activeSegment();
  $('seg-edit').classList.toggle('hidden', !s);
  if (s) {
    if (document.activeElement !== segName) segName.value = s.name;
    if (document.activeElement !== segColor) segColor.value = toHex(s.color);
    if (document.activeElement !== segOpacity) segOpacity.value = String(s.opacity ?? 1);
    $('seg-opacity-val').textContent = `${Math.round((s.opacity ?? 1) * 100)} %`;
    const grow = $('btn-seg-grow');
    grow.classList.toggle('active', tool === 'grow');
    grow.textContent = tool === 'grow' ? 'Clicking… (Esc)' : 'Click to add';
    const thr = s.seeds.length ? `${Math.round(Math.min(...s.seeds.map((d) => d.lo)))}–${Math.round(Math.max(...s.seeds.map((d) => d.hi)))}` : '–';
    const vol = `${((s.voxels * seg.voxelVolume) / 1000).toFixed(2)} cm³`;
    $('seg-info').textContent = s.ai
      ? `Automatic (${s.ai.model})${s.seeds.length ? ` + ${s.seeds.length} click${s.seeds.length === 1 ? '' : 's'}` : ''} · ${vol}`
      : `${s.seeds.length} click${s.seeds.length === 1 ? '' : 's'} · threshold ${thr} · ${vol}`;
    $('btn-seg-nerves').classList.toggle('hidden', s.ai?.cls !== 5);
    $('btn-seg-regrow').toggleAttribute('disabled', !s.seeds.length);
    $('btn-seg-undo').toggleAttribute('disabled', !s.seeds.length);
  }
  segShowUnseg.checked = app.showUnsegmented;
  segShow2d.checked = app.showSegOverlay;
  const cutBtn = $('btn-cut');
  cutBtn.classList.toggle('active', tool === 'cut');
  cutBtn.textContent = tool === 'cut' ? 'Drawing… (Esc)' : 'Draw cut';
  cutDepth.value = app.cutDepth === null ? '' : String(app.cutDepth);
  setList(
    cutList,
    seg.cuts.map((c, i) => ({
      key: String(c.id),
      sel: false,
      html: `<span class="swatch" style="background:rgb(255,122,40)"></span><span class="name">Cut ${i + 1} · ${c.kind === 'pano' ? 'panoramic' : escapeHtml(c.viewName)}</span><span class="dim">${c.depth === null ? 'whole' : `±${c.depth} mm`}</span><button data-act="del" title="Delete this cut">✕</button>`,
      onClick: () => {},
      onButton: () => app.deleteCut(c.id),
    })),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-seg-preset]').forEach((b) => b.toggleAttribute('disabled', !app.vol));
  $('btn-cut').toggleAttribute('disabled', !app.vol);
}
