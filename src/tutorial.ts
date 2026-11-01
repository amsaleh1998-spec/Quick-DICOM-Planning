import { IS_MAC } from './views/View';

const SEEN_KEY = 'qdp.trackpadGuideSeen';

// ---- tiny SVG illustration helpers -------------------------------------------

function arrow(x1: number, y1: number, x2: number, y2: number): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 6;
  const p1 = [x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45)];
  const p2 = [x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45)];
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="g-arrow"/><polygon points="${x2},${y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" class="g-head"/>`;
}
const finger = (x: number, y: number, hover = false) => `<circle cx="${x}" cy="${y}" r="7" class="${hover ? 'g-hover' : 'g-finger'}"/>`;
const ring = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="11.5" class="g-ring"/>`;
const key = (label: string) => {
  const w = 10 + label.length * 10;
  return `<rect x="10" y="10" width="${w}" height="18" rx="4" class="g-key"/><text x="${10 + w / 2}" y="23.5" class="g-keytext">${label}</text>`;
};
const pad = (inner: string) =>
  `<svg viewBox="0 0 120 84" class="g-svg" aria-hidden="true"><rect x="4" y="4" width="112" height="76" rx="11" class="g-pad"/>${inner}</svg>`;

interface Gesture {
  svg: string;
  title: string;
  text: string;
}

const GESTURES: Gesture[] = [
  {
    svg: pad(finger(52, 42) + finger(68, 42) + arrow(92, 38, 92, 14) + arrow(92, 46, 92, 70)),
    title: 'Two-finger swipe',
    text: 'Scroll through slices in the MPR views and cross-sections. Panoramic: up/down moves the panoramic slice buccal/lingual, left/right moves along the curve. Tangential: rotates 360°. 3D: orbits the model.',
  },
  {
    svg: pad(finger(50, 48) + finger(70, 36) + arrow(44, 52, 26, 66) + arrow(76, 32, 94, 18)),
    title: 'Pinch',
    text: 'Zoom in and out around your fingers – in every view, including 3D.',
  },
  {
    svg: pad(finger(36, 42) + ring(36, 42) + arrow(52, 42, 92, 42)),
    title: 'Click and drag',
    text: 'Press the trackpad and drag: move the crosshair, drag implants, their C/A rotation handles and outlines, curve points and ruler ends.',
  },
  {
    svg: pad(key('⌘') + finger(56, 48) + finger(72, 48) + arrow(64, 36, 64, 18) + arrow(84, 48, 104, 48) + arrow(64, 60, 64, 74) + arrow(44, 48, 26, 48)),
    title: '⌘ Command + two-finger swipe',
    text: 'Pan (move the image around). Option ⌥ + click-drag also pans.',
  },
  {
    svg: pad(key('⇧') + finger(56, 48) + finger(72, 48) + arrow(94, 44, 94, 18) + arrow(94, 52, 94, 76) + arrow(48, 70, 22, 70)),
    title: '⇧ Shift + two-finger swipe',
    text: 'Brightness / contrast: up/down changes the level (brightness), left/right changes the width (contrast).',
  },
  {
    svg: pad(finger(52, 44) + finger(68, 44) + ring(52, 44) + ring(68, 44) + arrow(60, 58, 60, 76)),
    title: 'Two-finger click and drag',
    text: 'Acts as right-drag: zoom (drag down = in, up = out) or brightness/contrast, depending on the “Right-drag” switch in the toolbar.',
  },
  {
    svg: pad(
      key('⌥⌘') +
        finger(60, 50) +
        ring(60, 50) +
        `<path d="M 84 58 A 26 26 0 0 0 76 26" class="g-arrow" fill="none"/>` +
        arrow(79, 30, 76, 26),
    ),
    title: '⌥ Option + ⌘ Command + drag (MPR)',
    text: 'Rotate the other two planes around this view, like Ctrl+Alt in 3D Slicer. The Rotate tool in the sidebar does the same without keys.',
  },
  {
    svg: pad(key('⇧') + finger(48, 50, true) + arrow(60, 50, 96, 50)),
    title: 'Hold ⇧ Shift and move (MPR)',
    text: 'Without clicking: the crosshair follows the pointer, so all three views update as you glide over the image.',
  },
];

let modal: HTMLDivElement | null = null;

function build(onInputChange: (v: 'mouse' | 'trackpad') => void, getInput: () => 'mouse' | 'trackpad'): HTMLDivElement {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tp-title">
      <header>
        <h2 id="tp-title">Using a Mac trackpad</h2>
        <button class="modal-close" title="Close (Esc)">×</button>
      </header>
      <p class="intro">Everything in Quick DICOM Planning works without a mouse. In <b>Trackpad mode</b> the gestures below are active
      (switch it in the toolbar: <b>Input → Trackpad</b>). Open this guide again any time with the <b>Trackpad guide</b> button.</p>
      <div class="g-grid">
        ${GESTURES.map((g) => `<div class="g-card">${g.svg}<div><h4>${g.title}</h4><p>${g.text}</p></div></div>`).join('')}
      </div>
      <div class="g-tip">
        <b>Tip for easier dragging:</b> turn on <i>System Settings → Accessibility → Pointer Control → Trackpad Options →
        “Use trackpad for dragging” → Three-finger drag</i>. Then you can drag implants, curve points and rulers with three
        fingers without pressing the trackpad. <i>System Settings → Trackpad → “Tap to click”</i> makes clicking lighter too.
      </div>
      <footer>
        <label class="check"><input type="checkbox" id="tp-mode" /> Trackpad mode (two-finger gestures for navigation)</label>
        <button class="primary modal-ok">Got it</button>
      </footer>
    </div>`;
  const close = () => hideTrackpadGuide();
  m.addEventListener('pointerdown', (e) => {
    if (e.target === m) close();
  });
  m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = close;
  m.querySelector<HTMLButtonElement>('.modal-ok')!.onclick = close;
  const cb = m.querySelector<HTMLInputElement>('#tp-mode')!;
  cb.checked = getInput() === 'trackpad';
  cb.onchange = () => onInputChange(cb.checked ? 'trackpad' : 'mouse');
  document.body.append(m);
  return m;
}

let inputHooks: { set: (v: 'mouse' | 'trackpad') => void; get: () => 'mouse' | 'trackpad' } | null = null;

export function initTrackpadGuide(set: (v: 'mouse' | 'trackpad') => void, get: () => 'mouse' | 'trackpad') {
  inputHooks = { set, get };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') {
      e.stopImmediatePropagation();
      hideTrackpadGuide();
    }
  }, true);
  // First visit on a Mac: show the guide once.
  let seen = false;
  try {
    seen = localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  if (IS_MAC && !seen) setTimeout(showTrackpadGuide, 400);
}

export function showTrackpadGuide() {
  if (!inputHooks) return;
  if (!modal) modal = build(inputHooks.set, inputHooks.get);
  modal.querySelector<HTMLInputElement>('#tp-mode')!.checked = inputHooks.get() === 'trackpad';
  modal.style.display = '';
  modal.querySelector<HTMLButtonElement>('.modal-ok')!.focus();
}

export function hideTrackpadGuide() {
  if (modal) modal.style.display = 'none';
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}
