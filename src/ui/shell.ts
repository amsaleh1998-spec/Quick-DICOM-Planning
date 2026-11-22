// Shared by every part of the desktop interface: the App, element lookup, the status bar and the
// loading overlay, and a few small HTML helpers.

import { App } from '../app';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const app = new App();
// exposed for debugging / automated tests
(window as unknown as { app: App }).app = app;

// ---- status / loading ---------------------------------------------------------
const statusMsg = $('status-msg');
let statusTimer = 0;
/** Status bar message; ordinary messages give way to the panel hint after a while, errors stay. */
export function setStatus(msg: string, error = false) {
  statusMsg.textContent = msg;
  statusMsg.title = msg;
  statusMsg.classList.toggle('error', error);
  clearTimeout(statusTimer);
  if (msg && !error) statusTimer = window.setTimeout(() => statusMsg.textContent === msg && (statusMsg.textContent = ''), 12000);
}
app.onCursor = (t) => ($('status-cursor').textContent = t);

const loading = $('loading');
const stall = $('loading-stall');
let stallTimer = 0;
let cancelWait: (() => void) | null = null;
const STALL_MS = 8000;
export function showLoading(text: string, f: number) {
  const changed = $('loading-text').textContent !== text || $('loading-bar').style.width !== `${Math.round(f * 100)}%`;
  loading.classList.remove('hidden');
  $('loading-text').textContent = text;
  $('loading-bar').style.width = `${Math.round(f * 100)}%`;
  if (changed) armStall();
}
export function hideLoading() {
  loading.classList.add('hidden');
  clearTimeout(stallTimer);
  stall.classList.add('hidden');
  cancelWait = null;
}
/** While waiting on the browser (opening files): after a while without progress, offer to cancel. */
export function cancellableWait(onCancel: (() => void) | null) {
  cancelWait = onCancel;
  armStall();
}
function armStall() {
  clearTimeout(stallTimer);
  stall.classList.add('hidden');
  if (cancelWait) stallTimer = window.setTimeout(() => stall.classList.remove('hidden'), STALL_MS);
}
$('loading-cancel').onclick = () => {
  const c = cancelWait;
  hideLoading();
  c?.();
};

/** A promise that gives up (TimeoutError) when it does not settle in time. */
export function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t = 0;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = window.setTimeout(() => reject(Object.assign(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`), { name: 'TimeoutError' })), ms);
    }),
  ]);
}
app.onStatus = (msg, error) => setStatus(msg, error);
app.onBusy = (text) => (text ? showLoading(text, 0.6) : hideLoading());

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function clampNum(v: string, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export const rgbCss = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const toHex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

/** Rebuild a small list only when its content changed (keeps clicks working). */
export function setList(el: HTMLElement, items: { key: string; html: string; sel: boolean; onClick: () => void; onButton?: (name: string) => void }[]) {
  const key = JSON.stringify(items.map((i) => [i.key, i.html, i.sel]));
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = it.html;
    li.className = it.sel ? 'sel' : '';
    li.onclick = (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn && it.onButton) {
        e.stopPropagation();
        it.onButton(btn.dataset.act ?? '');
      } else it.onClick();
    };
    el.append(li);
  }
}

/** "#rrggbb" → [r, g, b] */
export const fromHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const EYE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>';
export const EYE_OFF =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.6"/></svg>';
