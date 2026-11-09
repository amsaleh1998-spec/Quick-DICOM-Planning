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
  opts: { from?: Keyframe; response?: number; damping?: number; duration?: number; easing?: string } = {},
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
    fill: 'none',
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
 * The view grows from (or shrinks back to) the rectangle it had before a layout change: call with
 * that rectangle right after the change. Pure layout, no movement, when less motion is asked for.
 */
export function flipFrom(el: HTMLElement, before: DOMRect) {
  if (reducedMotion()) return;
  const after = el.getBoundingClientRect();
  if (!after.width || !after.height || !before.width || !before.height) return;
  const sx = before.width / after.width;
  const sy = before.height / after.height;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
  el.style.transformOrigin = '0 0';
  const a = animateTo(el, { transform: 'none' }, { from: { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, response: 0.32 });
  a.addEventListener('finish', () => (el.style.transformOrigin = ''));
}
