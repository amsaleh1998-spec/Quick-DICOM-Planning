// Menus and small settings panels that open under a button (Open ▾, ⚙, the 3D view's
// rendering settings …). One open at a time; closes on Esc, a click outside or `closePopovers()`.

interface Entry {
  btn: HTMLElement;
  pop: HTMLElement;
  align: 'left' | 'right';
  onOpen?: () => void;
}

const entries: Entry[] = [];
let open: Entry | null = null;

function place(e: Entry) {
  const r = e.btn.getBoundingClientRect();
  const p = e.pop;
  p.style.left = '0px';
  p.style.top = '0px';
  const w = p.offsetWidth;
  const h = p.offsetHeight;
  let left = e.align === 'right' ? r.right - w : r.left;
  left = Math.max(6, Math.min(window.innerWidth - w - 6, left));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 6);
  p.style.left = `${Math.round(left)}px`;
  p.style.top = `${Math.round(top)}px`;
}

export function closePopovers() {
  if (!open) return;
  open.pop.classList.add('hidden');
  open.btn.classList.remove('open');
  open.btn.setAttribute('aria-expanded', 'false');
  open = null;
}

function show(e: Entry) {
  closePopovers();
  e.onOpen?.();
  e.pop.classList.remove('hidden');
  e.btn.classList.add('open');
  e.btn.setAttribute('aria-expanded', 'true');
  open = e;
  place(e);
  e.pop.querySelector<HTMLElement>('button, input, select')?.focus({ preventScroll: true });
}

/** Toggle `pop` under `btn`. Menu items (buttons with role=menuitem) close it when clicked. */
export function bindPopover(btn: HTMLElement, pop: HTMLElement, opts: { align?: 'left' | 'right'; onOpen?: () => void } = {}) {
  const e: Entry = { btn, pop, align: opts.align ?? 'left', onOpen: opts.onOpen };
  entries.push(e);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (open === e) closePopovers();
    else show(e);
  });
  pop.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[role="menuitem"]')) closePopovers();
  });
}

window.addEventListener(
  'pointerdown',
  (ev) => {
    if (!open) return;
    const t = ev.target as Node;
    if (open.pop.contains(t) || open.btn.contains(t)) return;
    closePopovers();
  },
  true,
);
window.addEventListener(
  'keydown',
  (ev) => {
    if (ev.key === 'Escape' && open) {
      ev.stopImmediatePropagation();
      const btn = open.btn;
      closePopovers();
      btn.focus();
    }
  },
  true,
);
window.addEventListener('resize', () => open && place(open));
