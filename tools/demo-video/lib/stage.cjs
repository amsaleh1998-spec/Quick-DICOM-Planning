// Frame-accurate screen capture of the app.
//
// The page's clock is stepped by hand (Playwright's fake clock for timers / requestAnimationFrame /
// performance.now, and the animation timeline frozen through the DevTools protocol, with every
// running CSS / Web-Animations animation advanced by the same step). One step = one video frame,
// so the recording is smooth however long a frame takes to render (the 3D view is ray-cast in
// software here). Long computations (loading, matching, AI) run in real time and are sampled.
//
// Every frame is logged with the mouse position and cursor shape; the cursor itself is drawn later
// by the compositor, together with camera moves and captions.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** minimum-jerk easing: starts and stops gently, like a hand */
const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);

/** deterministic small random numbers (cursor paths look hand-made but repeat between runs) */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The native <select> list is drawn by the operating system and never reaches a page screenshot:
// for the recording the pickers are rendered in the page instead (same options, same behaviour).
const SELECT_CSS = `
select, ::picker(select) { appearance: base-select; }
select { align-items: center; gap: 4px; padding-inline-start: 8px; }
select::picker-icon { content: ''; width: 9px; height: 9px; flex: none; background: currentColor; opacity: .85;
  clip-path: polygon(8% 30%, 50% 78%, 92% 30%, 80% 20%, 50% 55%, 20% 20%); }
::picker(select) { background: #242427; color: #ececef; border: 1px solid #4a4a50; border-radius: 7px; padding: 4px; margin: 3px 0 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.55); font: inherit; overflow-y: auto; min-width: anchor-size(width);
  /* under its select, as high as the room there (a longer list scrolls) */
  position-try-fallbacks: none; }
select option { padding: 4px 10px 4px 8px; border-radius: 4px; min-height: 0; gap: 6px; white-space: nowrap; }
select option:hover, select option:focus-visible { background: #3a3a40; outline: none; }
select option:checked { background: #34343a; font-weight: 500; }
select option::checkmark { width: 12px; font-size: 11px; }
select optgroup { padding: 2px 0; font-weight: 600; color: #a1a1a8; }
/* progress bars are sampled in real time: no easing between their steps */
#loading-bar, #ai-bar-fill, .lib-progress div { transition: none !important; }
`;

class Stage {
  /**
   * @param {object} o
   * @param {string} o.url        app URL
   * @param {string} o.outDir     capture directory (frames/ and log.json are written here)
   * @param {number} [o.width]    CSS viewport
   * @param {number} [o.height]
   * @param {number} [o.dsf]      device scale factor of the screenshots
   * @param {number} [o.fps]      video frames per second (60 or 30)
   */
  static async launch(o) {
    const st = new Stage();
    st.W = o.width ?? 1440;
    st.H = o.height ?? 810;
    st.dsf = o.dsf ?? 2;
    st.fps = o.fps ?? 60;
    // app time per frame: a whole number of 16 ms animation frames (the fake clock's rAF period)
    st.dt = st.fps >= 60 ? 16 : st.fps >= 30 ? 32 : 64;
    st.outDir = o.outDir;
    st.framesDir = path.join(o.outDir, 'frames');
    fs.mkdirSync(st.framesDir, { recursive: true });
    st.browser = await chromium.launch({
      // WebGL on the software renderer (no graphics card in a headless container); the page itself is
      // composited in software too: screenshots at 2x come back about 2.5x faster than through software GL
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-gpu-compositing', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'],
    });
    st.ctx = await st.browser.newContext({
      viewport: { width: st.W, height: st.H },
      deviceScaleFactor: st.dsf,
      serviceWorkers: 'block',
      colorScheme: 'dark',
      acceptDownloads: true,
    });
    // no native save dialog in a headless browser: Save / Export deliver downloads
    await st.ctx.addInitScript(() => {
      window.showSaveFilePicker = undefined;
    });
    // remembered preferences of the person at the keyboard (the app keeps them in localStorage)
    if (o.storage) {
      await st.ctx.addInitScript((items) => {
        for (const [k, v] of Object.entries(items)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      }, o.storage);
    }
    st.page = await st.ctx.newPage();
    st.page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    st.page.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text().slice(0, 300)));
    await st.page.clock.install();
    await st.page.goto(o.url);
    await st.page.addStyleTag({ content: SELECT_CSS });
    st.cdp = await st.ctx.newCDPSession(st.page);
    await st.cdp.send('Animation.enable');
    st.log = { meta: { w: st.W, h: st.H, dsf: st.dsf, fps: st.fps, dt: st.dt }, frames: [], marks: {}, rects: {}, events: [], scenes: [] };
    st.x = st.W / 2;
    st.y = st.H / 2;
    st.down = false;
    st.cursor = 'default';
    st.scene = null;
    st.lastHash = null;
    st.lastFile = null;
    st.n = 0;
    st.rand = rng(o.seed ?? 7);
    st.stepping = false;
    st.t0 = Date.now();
    return st;
  }

  // ---- time ------------------------------------------------------------------------------------

  /** Freeze the page: from here on time only moves in frame() steps. */
  async freeze() {
    if (this.stepping) return;
    await this.cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await this._pause();
    this.stepping = true;
  }

  /** Stop the page's clock just ahead of where it is (it keeps running until the call lands). */
  async _pause() {
    for (const margin of [20, 100, 400, 1500, 5000]) {
      try {
        const now = await this.page.evaluate(() => Date.now());
        await this.page.clock.pauseAt(now + margin);
        return;
      } catch (e) {
        if (!/past/.test(String(e))) throw e;
      }
    }
    throw new Error('could not pause the page clock');
  }

  /** Let the page run freely, animations included (set-up off camera). */
  async thaw() {
    if (!this.stepping) return;
    await this.page.clock.resume();
    await this.cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    this.stepping = false;
  }

  /** Run something off camera in real time (set-up between scenes). */
  async offcam(fn) {
    const was = this.stepping;
    await this.thaw();
    try {
      return await fn(this.page);
    } finally {
      if (was) await this.freeze();
    }
  }

  /** Advance the page by `ms` of app time without recording (must be frozen). */
  async advance(ms) {
    for (let left = ms; left > 0; left -= 16) {
      const d = Math.min(16, left);
      await this.page.clock.runFor(d);
      await this.stepAnimations(d);
    }
  }

  /**
   * Advance every running animation by `ms`. With `holdNew`, animations that appeared since the
   * last call stay at their start (so one that begins during a real-time stretch plays in full
   * once frames are stepped again).
   */
  async stepAnimations(ms, holdNew = false) {
    await this.page.evaluate(
      ([ms, holdNew]) => {
        for (const a of document.getAnimations()) {
          if (a.playState === 'finished' || a.playState === 'idle') continue;
          if (holdNew && !a.__seen) {
            a.__seen = true;
            continue;
          }
          a.__seen = true;
          a.currentTime = (Number(a.currentTime) || 0) + ms;
        }
      },
      [ms, holdNew],
    );
  }

  // ---- recording -------------------------------------------------------------------------------

  begin(scene) {
    this.scene = scene;
    this.log.scenes.push({ name: scene, from: this.log.frames.length, to: this.log.frames.length });
    console.log(`[scene] ${scene} @ frame ${this.log.frames.length} (${((Date.now() - this.t0) / 1000).toFixed(0)} s)`);
  }

  mark(name) {
    this.log.marks[name] = this.log.frames.length;
  }

  /** Remember a rectangle (CSS px) by name for the editor: an element, a selector or [x, y, w, h]. */
  async rect(name, target) {
    let r = target;
    if (typeof target === 'string') {
      r = await this.page.evaluate((sel) => {
        const b = document.querySelector(sel).getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      }, target);
    }
    this.log.rects[name] = r.map((v) => Math.round(v * 10) / 10);
    return r;
  }

  /**
   * A picture of the page at device resolution, as PNG. Taken on the page's own DevTools session
   * (where Playwright set the device scale factor): one call, encoded for speed. Without access to
   * that session (another Playwright version), Playwright's own screenshot is used (slower).
   */
  async shot() {
    if (this._shotClient === undefined) {
      try {
        const impl = this.page._connection.toImpl(this.page);
        this._shotClient = (impl.delegate ?? impl._delegate)._mainFrameSession._client;
      } catch {
        this._shotClient = null;
      }
    }
    if (this._shotClient) {
      const { data } = await this._shotClient.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: this.W, height: this.H, scale: 1 } });
      return Buffer.from(data, 'base64');
    }
    return this.page.screenshot({ type: 'png', caret: 'initial', animations: 'allow', timeout: 0 });
  }

  async readCursor() {
    try {
      return await this.page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return 'default';
          let c = getComputedStyle(el).cursor;
          if (c === 'auto') c = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea') ? 'text' : el.closest('a[href]') ? 'pointer' : 'default';
          return c;
        },
        [this.x, this.y],
      );
    } catch {
      return this.cursor;
    }
  }

  /** Write one frame to the log (and to disk unless it is identical to the previous one). */
  async record(extra = {}) {
    const buf = await this.shot();
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    let file = this.lastFile;
    if (hash !== this.lastHash) {
      file = String(++this.n).padStart(6, '0') + '.png';
      fs.writeFileSync(path.join(this.framesDir, file), buf);
      this.lastHash = hash;
      this.lastFile = file;
    }
    this.cursor = await this.readCursor();
    this.log.frames.push({ f: file, s: this.scene, x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10, c: this.cursor, d: this.down ? 1 : 0, ...extra });
    const sc = this.log.scenes[this.log.scenes.length - 1];
    if (sc) sc.to = this.log.frames.length;
  }

  /** One video frame: advance the app by one frame of time, then record it. `appMs` overrides how much app time passes. */
  async frame(appMs) {
    await this.freeze();
    await this.advance(appMs ?? this.dt);
    await this.record();
  }

  /** Hold for `sec` seconds of video. */
  async hold(sec, appMs) {
    const n = Math.max(1, Math.round(sec * this.fps));
    for (let i = 0; i < n; i++) await this.frame(appMs);
  }

  /**
   * Real time: the page's clock runs freely until `until()` resolves true (loading, matching,
   * AI …); a frame is recorded every `every` ms and the editor plays the stretch as a time-lapse.
   * Animations stay on the stepped timeline: they are advanced by the real time between samples.
   */
  async realtime(until, { every = 250, timeout = 2400_000, label = 'rt', shotTimeout = 60_000 } = {}) {
    await this.freeze();
    await this.page.clock.resume();
    const t0 = Date.now();
    let last = t0;
    const first = this.log.frames.length;
    for (;;) {
      const now = Date.now();
      try {
        await this.stepAnimations(now - last, true);
      } catch {
        /* page busy */
      }
      last = now;
      try {
        await Promise.race([this.record({ rt: now - t0, lapse: label }), sleep(shotTimeout).then(() => Promise.reject(new Error('shot timeout')))]);
      } catch (e) {
        console.log(`  [realtime:${label}] frame skipped (${e.message})`);
      }
      let done = false;
      try {
        done = await until(this.page);
      } catch {
        /* page busy */
      }
      if (done) break;
      if (Date.now() - t0 > timeout) throw new Error(`realtime(${label}) timed out`);
      await sleep(every);
    }
    await this._pause();
    // how long the wait really was (the editor labels long ones as a time-lapse)
    this.log.events.push({ i: first, type: 'lapse', label, to: this.log.frames.length, ms: Date.now() - t0 });
    console.log(`  [realtime:${label}] ${((Date.now() - t0) / 1000).toFixed(1)} s, ${this.log.frames.length - first} frames`);
  }

  // ---- mouse -----------------------------------------------------------------------------------

  /** Put the cursor somewhere without recording (scene set-up). */
  async place(x, y) {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
  }

  async _move(x, y) {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
  }

  /** Resolve a target to a point: [x, y], a selector (its centre), or {sel, fx, fy} (fraction inside the element). */
  async point(target) {
    if (Array.isArray(target)) return target;
    const t = typeof target === 'string' ? { sel: target } : target;
    const r = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    }, t.sel);
    if (!r) throw new Error(`no element ${t.sel}`);
    return [r[0] + r[2] * (t.fx ?? 0.5) + (t.dx ?? 0), r[1] + r[3] * (t.fy ?? 0.5) + (t.dy ?? 0)];
  }

  /** Time a pointer takes for a distance (Fitts-like): quick, never instant. */
  moveTime(d) {
    return clamp(0.22 + 0.11 * Math.log2(1 + d / 40), 0.25, 0.85);
  }

  /** Move the cursor to a target along a slightly curved path with gentle start and stop. */
  async moveTo(target, { dur, curve = 1, appMs } = {}) {
    const [x1, y1] = await this.point(target);
    const x0 = this.x, y0 = this.y;
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d < 0.5) return;
    const T = dur ?? this.moveTime(d);
    const n = Math.max(2, Math.round(T * this.fps));
    // control point off the straight line: a hand moves in a shallow arc
    const bend = (this.rand() - 0.5) * 0.16 * d * curve;
    const mx = (x0 + x1) / 2 - ((y1 - y0) / (d || 1)) * bend;
    const my = (y0 + y1) / 2 + ((x1 - x0) / (d || 1)) * bend;
    for (let i = 1; i <= n; i++) {
      const s = minJerk(i / n);
      const a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
      await this._move(a * x0 + b * mx + c * x1, a * y0 + b * my + c * y1);
      await this.frame(appMs);
    }
  }

  async press(button = 'left', clickCount = 1) {
    await this.page.mouse.down({ button, clickCount });
    this.down = true;
    this.log.events.push({ i: this.log.frames.length, type: 'down', x: this.x, y: this.y, button });
  }

  async release(button = 'left', clickCount = 1) {
    await this.page.mouse.up({ button, clickCount });
    this.down = false;
    this.log.events.push({ i: this.log.frames.length, type: 'up', x: this.x, y: this.y, button });
  }

  /** Click where the cursor is (optionally move there first). */
  async click(target, { dur, holdFrames, after = 0.12, clickCount = 1, appMs } = {}) {
    if (target) await this.moveTo(target, { dur, appMs });
    const hf = holdFrames ?? Math.max(2, Math.round(0.07 * this.fps));
    await this.press('left', clickCount);
    this.log.events.push({ i: this.log.frames.length, type: 'click', x: this.x, y: this.y });
    for (let i = 0; i < hf; i++) await this.frame(appMs);
    await this.release('left', clickCount);
    if (after > 0) await this.hold(after, appMs);
  }

  /**
   * Drag along points [[x, y], ...] (the first is where the button goes down). `dur` is the whole
   * drag; the pointer speed follows a gentle start / stop over the whole path.
   */
  async drag(points, { dur = 1, before = 0.1, after = 0.12, moveDur, ease = minJerk, appMs } = {}) {
    await this.moveTo(points[0], { dur: moveDur, appMs });
    await this.hold(before, appMs);
    await this.press();
    await this.frame(appMs);
    await this.dragMove(points, { dur, ease, appMs });
    await this.release();
    if (after > 0) await this.hold(after, appMs);
  }

  /**
   * Move along a polyline at eased speed (used while a button is down). Every vertex passed
   * since the previous frame is sent to the page, so the app sees the same pointer path
   * whatever the frame rate.
   */
  async dragMove(points, { dur = 1, ease = minJerk, appMs } = {}) {
    const seg = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const l = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      seg.push(l);
      total += l;
    }
    const n = Math.max(2, Math.round(dur * this.fps));
    let sent = 0; // index of the last vertex already passed
    for (let k = 1; k <= n; k++) {
      let dist = ease(k / n) * total;
      let i = 0;
      while (i < seg.length - 1 && dist > seg[i]) dist -= seg[i++];
      for (; sent < i; sent++) await this.page.mouse.move(points[sent + 1][0], points[sent + 1][1]);
      const f = seg[i] ? Math.min(1, dist / seg[i]) : 1;
      await this._move(points[i][0] + (points[i + 1][0] - points[i][0]) * f, points[i][1] + (points[i + 1][1] - points[i][1]) * f);
      await this.frame(appMs);
    }
  }

  /**
   * Drag files from the desktop onto the page (real drag events through the DevTools protocol).
   * The pointer and a ghost of the files are drawn by the compositor between the two events.
   */
  async dragFiles(files, from, to, { dur = 1.0, label = '', after = 0, leave = true } = {}) {
    const data = { items: [], files, dragOperationsMask: 1 };
    const n = Math.max(2, Math.round(dur * this.fps));
    // the pointer goes out of the window to where the files are, then comes back with them
    if (leave && Math.hypot(this.x - from[0], this.y - from[1]) > 2) {
      await this.moveTo(from);
      await this.hold(0.15);
    }
    this.x = from[0];
    this.y = from[1];
    this.log.events.push({ i: this.log.frames.length, type: 'dragstart', label });
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const bend = 0.1 * d;
    const mx = (from[0] + to[0]) / 2 - ((to[1] - from[1]) / d) * bend;
    const my = (from[1] + to[1]) / 2 + ((to[0] - from[0]) / d) * bend;
    for (let k = 0; k <= n; k++) {
      const s = minJerk(k / n);
      const a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
      this.x = a * from[0] + b * mx + c * to[0];
      this.y = a * from[1] + b * my + c * to[1];
      const inside = this.x >= 0 && this.y >= 0 && this.x < this.W && this.y < this.H;
      if (inside) {
        await this.cdp.send('Input.dispatchDragEvent', { type: this._dragIn ? 'dragOver' : 'dragEnter', x: Math.round(this.x), y: Math.round(this.y), data });
        this._dragIn = true;
      }
      await this.frame();
    }
    await this.hold(0.12);
    await this.cdp.send('Input.dispatchDragEvent', { type: 'drop', x: Math.round(this.x), y: Math.round(this.y), data });
    this._dragIn = false;
    this.log.events.push({ i: this.log.frames.length, type: 'drop', x: this.x, y: this.y, label });
    await this.page.mouse.move(this.x, this.y);
    if (after > 0) await this.hold(after);
  }

  /** Type text into the focused field, a few characters per frame group. */
  async type(text, { cps = 14 } = {}) {
    const per = Math.max(1, Math.round(this.fps / cps));
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      for (let i = 0; i < per; i++) await this.frame();
    }
  }

  /**
   * `notches` wheel steps (negative = up) spread over `dur` seconds. `delta` is the size of one
   * step (100 = a notch of an ordinary wheel; smaller steps for a smooth Ctrl+wheel zoom, which
   * the app scales by the amount scrolled). `native`: the wheel scrolls something of the browser's
   * own (an open list) instead of reaching a wheel handler of the page.
   */
  async wheel(notches, { dur = 0.6, ctrl = false, delta = 100, native = false, appMs } = {}) {
    const n = Math.round((Math.abs(notches) * 100) / delta);
    const frames = Math.max(1, Math.round(dur * this.fps));
    let sent = 0;
    if (ctrl) await this.page.keyboard.down('Control');
    for (let k = 1; k <= frames; k++) {
      // eased: the wheel spins up and slows down
      const want = Math.round(minJerk(k / frames) * n);
      while (sent < want) {
        // a wheel handler of the page sees the delta divided by the device scale factor; what the
        // browser scrolls itself moves by the delta as given
        await this.page.mouse.wheel(0, Math.sign(notches) * delta * (native ? 1 : this.dsf));
        sent++;
      }
      await this.frame(appMs);
    }
    if (ctrl) await this.page.keyboard.up('Control');
  }

  async key(k, { after = 0.1 } = {}) {
    await this.page.keyboard.press(k);
    this.log.events.push({ i: this.log.frames.length, type: 'key', key: k });
    if (after > 0) await this.hold(after);
  }

  // ---- end -------------------------------------------------------------------------------------

  save() {
    fs.writeFileSync(path.join(this.outDir, 'log.json'), JSON.stringify(this.log));
  }

  async close() {
    this.save();
    await this.browser.close();
    console.log(`[done] ${this.log.frames.length} frames (${this.n} distinct) in ${((Date.now() - this.t0) / 1000).toFixed(0)} s -> ${this.outDir}`);
  }
}

module.exports = { Stage, sleep, clamp, minJerk };
