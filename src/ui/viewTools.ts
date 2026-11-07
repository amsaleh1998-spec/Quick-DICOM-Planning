// Settings that belong to one view sit in that view: rendering mode, thresholds and direction in
// the 3D view; slab / slice and cross-section spacing in the panoramic. The controls themselves
// are in index.html (ids kept) and are moved into the views here.

import { bindPopover } from './popover';

export function mountViewTools(view3d: HTMLElement, pano: HTMLElement) {
  const t3 = document.getElementById('v3d-tools')!;
  const tp = document.getElementById('pano-tools')!;
  t3.classList.add('in-view', 'v3d');
  tp.classList.add('in-view', 'pano');
  view3d.append(t3);
  pano.append(tp);
  // pointer events on the tools must not reach the view (rotating / scrolling)
  for (const t of [t3, tp])
    for (const ev of ['pointerdown', 'wheel', 'dblclick', 'contextmenu'] as const) t.addEventListener(ev, (e) => e.stopPropagation());
  bindPopover(document.getElementById('btn-vr-menu')!, document.getElementById('pop-vr')!, { align: 'right' });
  bindPopover(document.getElementById('btn-3dview-menu')!, document.getElementById('pop-3dview')!, { align: 'right' });
  bindPopover(document.getElementById('btn-pano-menu')!, document.getElementById('pop-pano')!, { align: 'right' });
}
