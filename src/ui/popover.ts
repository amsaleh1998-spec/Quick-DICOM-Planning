// Menus and small settings panels that open under a button (Open ▾, ⚙, the 3D view's
// rendering settings …). One open at a time; closes on Esc, a click outside or `closePopovers()`.

interface Entry {
  btn: HTMLElement;
  pop: HTMLElement;
  align: 'left' | 'right';
  onOpen?: () => void;
}

import { animateTo, reducedMotion, stopMotion } from './motion';

const entries: Entry[] = [];
let open: Entry | null = null;
/** Menus still folding away (hidden when their animation ends, unless reopened first). */
const closing = new Map<HTMLElement, Animation>();

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
  // it grows out of (and folds back into) the button that opened it
  const ox = Math.min(w, Math.max(0, r.left + r.width / 2 - left));
  p.style.transformOrigin = `${Math.round(ox)}px ${top < r.top ? h : 0}px`;
}

/** Folded state: a little smaller and nearer its button, transparent. */
function folded(e: Entry): Keyframe {
  if (reducedMotion()) return { opacity: 0, transform: 'none' };
  const up = e.pop.getBoundingClientRect().top < e.btn.getBoundingClientRect().top;
  return { opacity: 0, transform: `translateY(${up ? 4 : -4}px) scale(0.96)` };
}

export function closePopovers() {
  if (!open) return;
  const e = open;
  e.btn.classList.remove('open');
  e.btn.setAttribute('aria-expanded', 'false');
  open = null;
  const pop = e.pop;
  pop.style.pointerEvents = 'none';
  const a = animateTo(pop, folded(e), { response: 0.2 });
  closing.set(pop, a);
  const hide = () => {
    if (closing.get(pop) !== a) return;
    closing.delete(pop);
    pop.classList.add('hidden');
    pop.style.pointerEvents = '';
  };
  a.addEventListener('finish', hide);
  a.addEventListener('cancel', () => closing.get(pop) === a && closing.delete(pop));
}

function show(e: Entry) {
  closePopovers();
  e.onOpen?.();
  const wasClosing = closing.has(e.pop);
  closing.delete(e.pop);
  e.pop.style.pointerEvents = '';
  e.pop.classList.remove('hidden');
  e.btn.classList.add('open');
  e.btn.setAttribute('aria-expanded', 'true');
  open = e;
  place(e);
  // from where it is if it was still folding away, otherwise from folded
  if (!wasClosing) stopMotion(e.pop);
  animateTo(e.pop, { opacity: 1, transform: 'none' }, { from: folded(e), response: reducedMotion() ? 0.15 : 0.28 });
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
