// Left icon rail: shows one side panel at a time. Which panels exist depends on the mode
// (① Reorient / ② Plan); each mode remembers its last panel. The panel can be hidden entirely
// to give the views the full width.

import type { Mode } from '../app';

export type PanelId = 'reorient' | 'curve' | 'implants' | 'segments' | 'nerves' | 'scans';

const PANELS: Record<PanelId, { modes: Mode[]; hint: string }> = {
  reorient: { modes: ['mpr'], hint: '<b>Reorient</b>: Ctrl+Alt+drag (or the Rotate tool) turns the other planes · Crop tool: drag the blue box edges' },
  curve: { modes: ['plan'], hint: '<b>Curve</b>: hold and drag along the arch in the axial view, or click point by point · double-click a point to remove it' },
  implants: { modes: ['plan'], hint: '<b>Implant</b>: drag the body to move · C / A handles rotate · drag the outline to resize · Del deletes' },
  segments: { modes: ['mpr', 'plan'], hint: '<b>Segments</b>: select one, then “Click to add” and click the structure in 3D or in a slice' },
  nerves: { modes: ['plan'], hint: '<b>Nerve</b>: click the canal centre on cross-sections or the panoramic, in any order' },
  scans: { modes: ['mpr', 'plan'], hint: '<b>Scans</b>: drop STL / PLY / OBJ files on the viewer to import them' },
};

const KEY = 'qdp.rail';
interface Saved {
  mpr: PanelId;
  plan: PanelId;
  collapsed: boolean;
}
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (s && PANELS[s.mpr] && PANELS[s.plan]) return s;
  } catch {
    /* defaults */
  }
  return { mpr: 'reorient', plan: 'implants', collapsed: false };
}

export class Rail {
  private state = load();
  private mode: Mode = 'mpr';
  private readonly buttons = new Map<PanelId, HTMLButtonElement>();
  private readonly sections = new Map<PanelId, HTMLElement>();
  /** called when the visible panel changes (the views get more or less room) */
  onLayout: () => void = () => {};

  constructor(
    private rail: HTMLElement,
    private sidebar: HTMLElement,
    private hintEl: HTMLElement,
  ) {
    for (const b of rail.querySelectorAll<HTMLButtonElement>('button[data-panel]')) {
      const id = b.dataset.panel as PanelId;
      this.buttons.set(id, b);
      b.setAttribute('aria-label', b.title);
      b.onclick = () => this.select(id, true);
    }
    for (const s of sidebar.querySelectorAll<HTMLElement>('section[data-panel]')) this.sections.set(s.dataset.panel as PanelId, s);
    rail.querySelector<HTMLButtonElement>('#rail-collapse')!.onclick = () => this.setCollapsed(!this.state.collapsed);
    this.render();
  }

  get current(): PanelId {
    return this.state[this.mode];
  }

  setMode(m: Mode) {
    this.mode = m;
    this.render();
  }

  /** Show a panel (switching from the rail toggles it when it is already open). */
  select(id: PanelId, fromRail = false) {
    if (!PANELS[id].modes.includes(this.mode)) return;
    if (fromRail && id === this.current && !this.state.collapsed) {
      this.setCollapsed(true);
      return;
    }
    this.state[this.mode] = id;
    this.state.collapsed = false;
    this.save();
    this.render();
  }

  setCollapsed(c: boolean) {
    this.state.collapsed = c;
    this.save();
    this.render();
  }

  /** Small count badges on the rail icons. */
  setBadges(counts: Partial<Record<PanelId, number>>) {
    for (const [id, b] of this.buttons) {
      const badge = b.querySelector<HTMLElement>('.rail-badge');
      if (!badge) continue;
      const n = counts[id] ?? 0;
      const t = n ? String(n) : '';
      if (badge.textContent !== t) badge.textContent = t;
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* not remembered */
    }
  }

  private render() {
    if (!PANELS[this.state[this.mode]].modes.includes(this.mode)) this.state[this.mode] = this.mode === 'mpr' ? 'reorient' : 'implants';
    const cur = this.current;
    const collapsed = this.state.collapsed;
    for (const [id, b] of this.buttons) {
      b.classList.toggle('hidden', !PANELS[id].modes.includes(this.mode));
      b.classList.toggle('on', id === cur && !collapsed);
    }
    for (const [id, s] of this.sections) s.classList.toggle('hidden', id !== cur);
    const wasCollapsed = this.sidebar.classList.contains('hidden');
    this.sidebar.classList.toggle('hidden', collapsed);
    const cb = this.rail.querySelector<HTMLButtonElement>('#rail-collapse')!;
    cb.title = collapsed ? 'Show the panel' : 'Hide the panel (more room for the views)';
    cb.classList.toggle('flip', collapsed);
    this.hintEl.innerHTML = PANELS[cur].hint;
    if (wasCollapsed !== collapsed) this.onLayout();
  }
}
