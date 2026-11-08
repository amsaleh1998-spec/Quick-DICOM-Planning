// "?" – every mouse and keyboard shortcut in one place (they used to fill the side panel).

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigate (all slices)',
    rows: [
      ['Click / drag', 'Move the crosshair'],
      ['Hold Shift', 'Crosshair follows the mouse'],
      ['Wheel', 'Scroll slices'],
      ['Ctrl+wheel', 'Zoom (or right drag, see ⚙)'],
      ['Alt / middle drag', 'Pan'],
      ['F', 'Fit all views'],
      ['M or ⤢', 'Maximize / restore the view'],
      ['R', 'Ruler: click start, click end · drag an end to adjust · Del removes the hovered one'],
      ['1 / 2', '① Reorient / ② Plan'],
    ],
  },
  {
    title: '① Reorient',
    rows: [
      ['Ctrl+Alt+drag', 'Rotate the other planes around this view (or the Rotate tool)'],
      ['Crop tool', 'Drag the blue box edges'],
    ],
  },
  {
    title: '② Plan',
    rows: [
      ['Draw curve', 'Hold the left button and drag along the arch, or click point by point'],
      ['Axial', 'Wheel = level · drag curve points · double-click curve = add / point = remove'],
      ['Panoramic', 'Wheel = buccal / lingual · Alt+wheel = along the curve · click = jump'],
      ['Cross-sections', 'Wheel = 1 mm along the curve'],
      ['Tangential', 'Wheel = rotate 360° around the selected implant'],
      ['Implant body', 'Drag = move'],
      ['Implant outline', 'Drag side = diameter · drag apical end = length (click the live value to type it)'],
      ['C / A handles', 'C rotates around the apex, A around the platform'],
      ['Del', 'Delete the selected implant'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo any change of the plan: implants, curves, segments, nerves, scans, rulers'],
      ['Esc', 'Cancel / deselect'],
      ['Double-click', 'An implant in the list: rename it'],
    ],
  },
  {
    title: '② Plan · Waxup',
    rows: [
      ['Tooth chart', 'Click a position to add the tooth (set up along the curve) · click again to select · once more to remove'],
      ['Drag a tooth', 'Move it in the view plane – 3D view (from any panel), slices and panoramic (Waxup panel open)'],
      ['Shift + drag', 'Scale it · Ctrl + drag: rotate it around the view axis'],
      ['Chain mode', 'Neighbours slide along the arch and keep their contacts'],
      ['Mirror', 'The same change on the other side (13 → 23)'],
      ['Whole jaw', 'Move / scale / rotate all teeth of the jaw together'],
      ['Parts', 'Drag a blue dot: move a cusp or incisal edge (Shift scale, Ctrl rotate)'],
      ['Freeform', '3D view: drag = add material · Ctrl = remove · Shift = smooth'],
      ['Del / Esc', 'Remove / deselect the selected tooth'],
    ],
  },
  {
    title: '3D view',
    rows: [
      ['Drag', 'Rotate'],
      ['Wheel', 'Zoom'],
      ['Alt / Shift / middle drag', 'Pan'],
      ['Middle-click', 'Rotation centre at that surface point'],
      ['Double-click or ⟲', 'Reset the view'],
      ['Bar at the bottom', 'Lower threshold of the surface (also for new segment clicks)'],
      ['Objects (right)', 'Show / hide every surface; drag its left edge to resize, › to hide it'],
      ['Drag an implant', 'Move it (C / A handles rotate)'],
    ],
  },
  {
    title: 'Files',
    rows: [
      ['Ctrl+O', 'Open a CBCT'],
      ['Ctrl+S', 'Save the project'],
      ['Drop', 'DICOM files / folder / ZIP / project, or STL / PLY / OBJ scans'],
    ],
  },
];

let el: HTMLDivElement | null = null;

export function showHelp(extra: { trackpadGuide: () => void }) {
  if (el) {
    el.remove();
    el = null;
    return;
  }
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <header><h2 id="help-title">Shortcuts and help</h2><button class="modal-close" title="Close (Esc)">×</button></header>
      <div class="help-cols">
        ${SECTIONS.map(
          (s) => `<section><h4>${esc(s.title)}</h4><dl>${s.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`,
        ).join('')}
      </div>
      <footer><span class="muted small">Using a Mac trackpad? Switch the input in ⚙ Settings.</span><button class="help-tp">Trackpad guide</button></footer>
    </div>`;
  const close = () => {
    el?.remove();
    el = null;
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('pointerdown', (e) => e.target === el && close());
  el.querySelector<HTMLButtonElement>('.modal-close')!.onclick = close;
  el.querySelector<HTMLButtonElement>('.help-tp')!.onclick = () => {
    close();
    extra.trackpadGuide();
  };
  document.body.append(el);
  el.querySelector<HTMLButtonElement>('.modal-close')!.focus();
}
