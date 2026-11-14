// Motion: springs described as response (s) and damping ratio, the way Apple describes them,
// played by the Web Animations API through a `linear()` easing sampled from the spring. Every
// animation starts from what is on screen now, so a new one can take over mid-flight.

/** True when the system asks for less motion: cross-fades instead of movement. */
export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const supportsLinear = typeof CSS !== 'undefined' && CSS.supports?.('animation-timing-function', 'linear(0, 1)');
const cache = new Map<string, { easing: string; duration: number }>();

/**
 * Easing and duration of a spring from 0 to 1. `response`: seconds to (nearly) reach the target;
 * `damping`: 1 = no overshoot, < 1 overshoots. The duration is when it has settled to 0.1 %.
 */
export function spring(response = 0.3, damping = 1): { easing: string; duration: number } {
  const key = `${response}|${damping}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = (2 * Math.PI) / response;
  const x = (t: number) => {
    if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
    const wd = w * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
  };
  let end = response;
  while (end < 4 && (Math.abs(1 - x(end)) > 0.001 || Math.abs(1 - x(end - 0.016)) > 0.001)) end += 0.016;
  const n = 40;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(i === n ? '1' : x((i / n) * end).toFixed(4));
  const out = { easing: supportsLinear ? `linear(${pts.join(', ')})` : 'cubic-bezier(0.2, 0, 0, 1)', duration: Math.round(end * 1000) };
  cache.set(key, out);
  return out;
}

const running = new WeakMap<Element, Animation>();

/**
 * Animate `el` to `to` from its current on-screen transform and opacity (taking over from an
 * animation still running on it). `from` sets the start when nothing is running.
 */
export function animateTo(
  el: HTMLElement,
  to: Keyframe,
  opts: { from?: Keyframe; response?: number; damping?: number; duration?: number; easing?: string; delay?: number } = {},
): Animation {
  const prev = running.get(el);
  let from: Keyframe | undefined = opts.from;
  if (prev && prev.playState === 'running') {
    const cs = getComputedStyle(el);
    from = { transform: cs.transform === 'none' ? 'none' : cs.transform, opacity: cs.opacity };
    prev.cancel();
  }
  const sp = spring(opts.response ?? 0.3, opts.damping ?? 1);
  const a = el.animate(from ? [from, to] : [to], {
    duration: opts.duration ?? sp.duration,
    easing: opts.easing ?? sp.easing,
    delay: opts.delay ?? 0,
    fill: opts.delay ? 'backwards' : 'none', // a delayed one holds its start until it starts
  });
  running.set(el, a);
  a.addEventListener('finish', () => running.get(el) === a && running.delete(el));
  return a;
}

/** Stop whatever runs on `el` where it is. */
export function stopMotion(el: HTMLElement) {
  running.get(el)?.cancel();
  running.delete(el);
}

/**
 * A view grows out of (or shrinks back into) the rectangle it had before a layout change: call
 * with that rectangle right after the change. The view is never stretched: it is scaled evenly so
 * that its content lines up with what the old rectangle showed (views keep their field of view
 * across the shorter side), cut to the old rectangle, and both open up to its new place.
 * No movement when less motion is asked for.
 */
export function flipFrom(
  el: HTMLElement,
  before: DOMRect,
  opts: { response?: number; damping?: number; delay?: number; z?: number } = {},
) {
  if (reducedMotion()) return;
  stopMotion(el);
  const a = { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top, w: el.offsetWidth, h: el.offsetHeight };
  const b = before;
  if (!a.w || !a.h || !b.width || !b.height) return;
  if (Math.abs(b.left - a.x) < 1 && Math.abs(b.top - a.y) < 1 && Math.abs(b.width - a.w) < 1 && Math.abs(b.height - a.h) < 1) return;
  const s = Math.min(b.width, b.height) / Math.min(a.w, a.h);
  // centre on the old rectangle's centre
  const tx = b.left + b.width / 2 - a.x - (s * a.w) / 2;
  const ty = b.top + b.height / 2 - a.y - (s * a.h) / 2;
  // the old rectangle in the view's own (unscaled) pixels
  const left = Math.max(0, (b.left - a.x - tx) / s);
  const top = Math.max(0, (b.top - a.y - ty) / s);
  const right = Math.max(0, a.w - left - b.width / s);
  const bottom = Math.max(0, a.h - top - b.height / s);
  el.style.transformOrigin = '0 0';
  el.style.zIndex = String(opts.z ?? 5); // over the views coming back on a restore
  const anim = animateTo(
    el,
    { transform: 'none', clipPath: 'inset(0px 0px 0px 0px)' },
    {
      from: { transform: `translate(${tx}px, ${ty}px) scale(${s})`, clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px)` },
      response: opts.response ?? 0.2,
      damping: opts.damping,
      delay: opts.delay,
    },
  );
  const done = () => {
    el.style.transformOrigin = '';
    el.style.zIndex = '';
  };
  anim.addEventListener('finish', done);
  anim.addEventListener('cancel', done);
}
