// Objects: every surface of the scene in one list on the right, each with an eye to show / hide it
// (bone, segments, intraoral scans, waxup, implants, abutments, prosthetic axes, nerves). The list
// can be hidden to a thin strip and made wider or narrower; both are remembered.

import { $, EYE, EYE_OFF, app, escapeHtml, rgbCss } from './shell';

const KEY = 'qdp.objects';
const MIN_W = 180;
const MAX_W = 480;

interface Saved {
  open: boolean;
  width: number;
}
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (s && typeof s.open === 'boolean' && s.width >= MIN_W && s.width <= MAX_W) return s;
  } catch {
    /* defaults */
  }
  return { open: true, width: 230 };
}
const state = load();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* not remembered */
  }
};

const panel = $('objects');
const groups = $('obj-groups');
const toggle = $<HTMLButtonElement>('obj-toggle');

function layout() {
  panel.classList.toggle('collapsed', !state.open);
  panel.style.width = state.open ? `${state.width}px` : '';
  toggle.title = state.open ? 'Hide the objects list' : 'Show the objects list';
  toggle.setAttribute('aria-expanded', String(state.open));
}
layout();
toggle.onclick = () => {
  state.open = !state.open;
  save();
  layout();
  app.requestRender();
};
// a click on the thin strip opens it too
panel.addEventListener('click', (e) => {
  if (!state.open && e.target === panel) toggle.click();
});

// resize by dragging the left edge
const grip = $('obj-resize');
grip.addEventListener('pointerdown', (e) => {
  if (!state.open) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const w0 = state.width;
  panel.classList.add('resizing');
  const move = (ev: PointerEvent) => {
    state.width = Math.round(Math.min(MAX_W, Math.max(MIN_W, w0 - (ev.clientX - x0))));
    layout();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    panel.classList.remove('resizing');
    save();
    app.requestRender();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('dblclick', () => {
  state.width = 230;
  save();
  layout();
});

// ---- the list ----------------------------------------------------------------------

interface Item {
  key: string;
  name: string;
  info?: string;
  color?: [number, number, number];
  visible: boolean;
  set(v: boolean): void;
  select?(): void;
  /** not switched by the group's own eye (abutments, prosthetic axes) */
  own?: boolean;
}
interface Group {
  key: string;
  title: string;
  items: Item[];
}

function collect(): Group[] {
  const out: Group[] = [];
  if (!app.vol) return out;
  const segs = app.seg.segments;
  out.push({
    key: 'bone',
    title: 'CBCT',
    items: [
      {
        key: 'bone',
        name: segs.length ? 'Bone outside segments' : 'Bone surface (3D)',
        info: `${Math.round(app.vr.lo)}+`,
        color: [233, 222, 200],
        visible: app.showUnsegmented,
        set: (v) => (app.showUnsegmented = v),
      },
    ],
  });
  if (segs.length)
    out.push({
      key: 'segments',
      title: 'Segments',
      items: segs.map((g) => ({
        key: `seg${g.id}`,
        name: g.name,
        info: g.ai ? 'AI' : undefined,
        color: g.color,
        visible: g.visible,
        set: (v) => (g.visible = v),
        select: () => app.selectSegment(g.id),
      })),
    });
  if (app.scans.length)
    out.push({
      key: 'scans',
      title: 'Intraoral scans',
      items: app.scans.map((s) => ({
        key: `scan${s.id}`,
        name: s.name,
        info: s.transform ? undefined : 'not placed',
        color: s.color,
        visible: s.visible,
        set: (v) => (s.visible = v),
        select: () => (app.activeScanId = s.id),
      })),
    });
  const wax = app.wax;
  const jaws = (['upper', 'lower'] as const).filter((j) => wax.model.teeth.some((t) => t.jaw === j));
  if (jaws.length)
    out.push({
      key: 'waxup',
      title: 'Waxup',
      items: jaws.map((j) => ({
        key: `wax-${j}`,
        name: j === 'upper' ? 'Upper teeth' : 'Lower teeth',
        info: String(wax.model.teeth.filter((t) => t.jaw === j).length),
        color: wax.color,
        visible: wax.visible[j],
        set: (v) => (wax.visible[j] = v),
      })),
    });
  if (app.implants.length) {
    const items: Item[] = app.implants.map((imp) => ({
      key: `imp${imp.id}`,
      name: imp.name,
      info: imp.lib ? imp.lib.id.split(' / ').slice(1).join(' ') : `Ø${imp.diameter.toFixed(1)} × ${imp.length.toFixed(1)}`,
      color: [64, 214, 128],
      visible: !imp.hidden,
      set: (v) => (imp.hidden = !v),
      select: () => app.selectImplant(imp.id, true),
    }));
    const withAb = app.implants.filter((i) => i.abutment);
    if (withAb.length)
      items.push({
        key: 'abutments',
        name: 'Abutments (MUA)',
        info: String(withAb.length),
        color: [140, 180, 230],
        visible: withAb.some((i) => !i.abutmentHidden),
        set: (v) => withAb.forEach((i) => (i.abutmentHidden = !v)),
        own: true,
      });
    items.push({
      key: 'axes',
      name: 'Prosthetic axes',
      color: [232, 121, 249],
      visible: app.implants.some((i) => i.showProstheticAxis),
      set: (v) => app.implants.forEach((i) => (i.showProstheticAxis = v)),
      own: true,
    });
    out.push({ key: 'implants', title: 'Implants', items });
  }
  const nerves = app.nerves.filter((n) => n.pts.length >= 2);
  if (nerves.length)
    out.push({
      key: 'nerves',
      title: 'Nerves',
      items: nerves.map((n) => ({
        key: `nerve${n.id}`,
        name: n.name,
        color: [255, 214, 10],
        visible: n.visible,
        set: (v) => (n.visible = v),
        select: () => app.selectNerve(n.id),
      })),
    });
  return out;
}

let current: Group[] = [];
const eye = (on: boolean, title: string, attrs: string) =>
  `<button class="vis-btn${on ? '' : ' off'}" ${attrs} title="${title}" aria-pressed="${on}">${on ? EYE : EYE_OFF}</button>`;

export function refreshObjects() {
  current = collect();
  const html = current.length
    ? current
        .map((g) => {
          const anyOn = g.items.some((i) => !i.own && i.visible);
          const rows = g.items
            .map(
              (i) =>
                `<li class="${i.visible ? '' : 'off'}">${eye(i.visible, i.visible ? 'Hide' : 'Show', `data-k="${i.key}"`)}` +
                `<span class="swatch" style="background:${rgbCss(i.color ?? [150, 150, 150])}"></span>` +
                `<span class="nm" data-sel="${i.select ? i.key : ''}">${escapeHtml(i.name)}</span>` +
                (i.info ? `<span class="dim">${escapeHtml(i.info)}</span>` : '') +
                `</li>`,
            )
            .join('');
          return (
            `<section class="obj-group"><div class="obj-gh">${eye(anyOn, anyOn ? 'Hide all' : 'Show all', `data-g="${g.key}"`)}<b>${escapeHtml(g.title)}</b>` +
            `<span class="dim">${g.items.filter((i) => !i.own).length}</span></div><ul>${rows}</ul></section>`
          );
        })
        .join('')
    : `<p class="muted small">Open a scan – its bone surface, segments, scans, waxup, implants and nerves are listed here.</p>`;
  if (groups.dataset.html !== html) {
    groups.innerHTML = html;
    groups.dataset.html = html;
  }
}

groups.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLButtonElement>('button.vis-btn');
  if (btn?.dataset.k) {
    const it = current.flatMap((g) => g.items).find((i) => i.key === btn.dataset.k);
    if (it) {
      it.set(!it.visible);
      app.changed();
    }
    return;
  }
  if (btn?.dataset.g) {
    const g = current.find((x) => x.key === btn.dataset.g);
    if (g) {
      const on = !g.items.some((i) => !i.own && i.visible);
      for (const i of g.items) if (!i.own) i.set(on);
      app.changed();
    }
    return;
  }
  const sel = t.closest<HTMLElement>('[data-sel]')?.dataset.sel;
  if (sel) current.flatMap((g) => g.items).find((i) => i.key === sel)?.select?.();
  app.changed();
});
