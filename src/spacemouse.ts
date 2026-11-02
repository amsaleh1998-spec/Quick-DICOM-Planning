/**
 * 3Dconnexion SpaceMouse input for the 3D view.
 *
 * Chrome / Edge: WebHID (one "Connect" click grants access; afterwards the
 * device reconnects automatically on every visit). Other browsers: some expose
 * the SpaceMouse as a game controller, which is picked up automatically.
 *
 * Device values are converted to screen axes – X right, Y up, Z towards the
 * user – for translation and rotation (right-handed), normalised to ±1.
 */
import type { Vec3 } from './math';

/** What the SpaceMouse drives (the 3D view). */
export interface SpaceMouseTarget {
  /** t / r: translation / rotation in screen axes, ±1 at full deflection; dt in seconds */
  spaceMotion(t: Vec3, r: Vec3, dt: number): void;
  /** a device button was pressed (0 = left, 1 = right, …) */
  spaceButton(index: number): void;
}

export interface SpaceMouseSettings {
  speed: number;
  invertRotation: boolean;
  invertTranslation: boolean;
}

const SETTINGS_KEY = 'qdp.spacemouse';
/** 3Dconnexion and (older devices) Logitech vendor ids */
const VENDOR_3DCONNEXION = 0x256f;
const VENDOR_LOGITECH = 0x046d;
/** HID usage page "Generic Desktop", usage "Multi-axis Controller" */
const MULTI_AXIS = { usagePage: 0x01, usage: 0x08 };
/** raw value of a full deflection */
const FULL_SCALE = 350;
const DEAD_ZONE = 0.04;

// Minimal WebHID typings (not in the TypeScript DOM lib yet)
interface HIDDeviceLike extends EventTarget {
  opened: boolean;
  productName: string;
  vendorId: number;
  collections: { usagePage: number; usage: number }[];
  open(): Promise<void>;
  close(): Promise<void>;
}
interface HIDInputReportEventLike extends Event {
  reportId: number;
  data: DataView;
  device: HIDDeviceLike;
}
interface HIDLike extends EventTarget {
  getDevices(): Promise<HIDDeviceLike[]>;
  requestDevice(o: { filters: { vendorId?: number; usagePage?: number; usage?: number }[] }): Promise<HIDDeviceLike[]>;
}

const GAMEPAD_RE = /3dconnexion|spacemouse|space ?navigator|space ?pilot|space ?explorer|cadmouse|256f|046d.*c6[23]/i;

export class SpaceMouse {
  /** connected device name ('' = none) and how it is connected */
  name = '';
  via: 'hid' | 'gamepad' | null = null;
  settings: SpaceMouseSettings = { speed: 1, invertRotation: false, invertTranslation: false };
  /** UI refresh hook (connection changes) */
  onChange: () => void = () => {};
  /**
   * Called while the cap is moved. The 3Dconnexion driver also turns cap motion
   * into mouse-wheel scrolling / Ctrl+wheel zooming for browsers, which the app
   * ignores meanwhile (otherwise both inputs fight and the view jitters).
   */
  onActivity: () => void = () => {};

  private device: HIDDeviceLike | null = null;
  /** latest raw device axes (HID convention: x right, y towards user, z down) */
  private raw = { t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3 };
  private buttons = 0;
  private gamepadIndex: number | null = null;
  private loopRunning = false;
  private lastTime = 0;
  /** smoothed motion (screen axes) */
  private smT: Vec3 = [0, 0, 0];
  private smR: Vec3 = [0, 0, 0];
  /** devices with our report listener (never attach twice) */
  private listening = new WeakSet<object>();
  private opening: Promise<boolean> | null = null;

  constructor(private target: SpaceMouseTarget) {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
      if (s) this.settings = { ...this.settings, ...s };
    } catch {
      /* storage unavailable */
    }
    const hid = this.hid;
    if (hid) {
      hid.addEventListener('connect', (e) => this.open((e as unknown as { device: HIDDeviceLike }).device));
      hid.addEventListener('disconnect', (e) => {
        if ((e as unknown as { device: HIDDeviceLike }).device === this.device) this.detach();
      });
    }
    window.addEventListener('gamepadconnected', (e) => this.gamepadConnected((e as GamepadEvent).gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      if ((e as GamepadEvent).gamepad.index === this.gamepadIndex) {
        this.gamepadIndex = null;
        if (this.via === 'gamepad') this.detach();
      }
    });
  }

  /** WebHID is available (Chrome / Edge on desktop). */
  get supported(): boolean {
    return !!this.hid;
  }

  private get hid(): HIDLike | null {
    return (navigator as unknown as { hid?: HIDLike }).hid ?? null;
  }

  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
  }

  /** Reconnect a device the user already granted (no prompt). */
  async autoConnect() {
    const hid = this.hid;
    if (!hid) return;
    try {
      for (const d of await hid.getDevices()) if (await this.open(d)) return;
    } catch (e) {
      console.warn('SpaceMouse:', e);
    }
  }

  /** Ask the user to pick the SpaceMouse (needs a click). Returns an error message or ''. */
  async connect(): Promise<string> {
    const hid = this.hid;
    if (!hid) return 'This browser cannot access a SpaceMouse directly – use Chrome or Edge.';
    try {
      const devices = await hid.requestDevice({
        filters: [
          { vendorId: VENDOR_3DCONNEXION },
          { vendorId: VENDOR_LOGITECH, ...MULTI_AXIS },
        ],
      });
      for (const d of devices) if (await this.open(d)) return '';
      return devices.length ? 'Could not open the SpaceMouse (is another program using it exclusively?)' : '';
    } catch (e) {
      return (e as Error).message;
    }
  }

  async disconnect() {
    const d = this.device;
    this.detach();
    if (d?.opened) await d.close().catch(() => {});
  }

  /** One open at a time (auto-connect, the connect event and a click can overlap). */
  private open(d: HIDDeviceLike): Promise<boolean> {
    const prev = this.opening ?? Promise.resolve(false);
    const p = prev.then(() => this.openNow(d));
    this.opening = p.finally(() => {
      if (this.opening === p) this.opening = null;
    });
    return p;
  }

  private async openNow(d: HIDDeviceLike): Promise<boolean> {
    if (this.device === d) return true;
    // only the multi-axis collection (receivers also expose keyboard/mouse interfaces)
    if (d.collections.length && !d.collections.some((c) => c.usagePage === MULTI_AXIS.usagePage && c.usage === MULTI_AXIS.usage)) return false;
    try {
      if (!d.opened) await d.open();
    } catch (e) {
      console.warn('SpaceMouse: cannot open', d.productName, e);
      return false;
    }
    if (this.device && this.device !== d) await this.disconnect();
    this.device = d;
    this.via = 'hid';
    this.name = d.productName || 'SpaceMouse';
    if (!this.listening.has(d)) {
      this.listening.add(d);
      d.addEventListener('inputreport', (e) => {
        if (d === this.device) this.onReport(e as HIDInputReportEventLike);
      });
    }
    this.onChange();
    return true;
  }

  private detach() {
    this.device = null;
    this.via = this.gamepadIndex !== null ? 'gamepad' : null;
    this.name = this.via ? this.name : '';
    this.raw = { t: [0, 0, 0], r: [0, 0, 0] };
    this.smT = [0, 0, 0];
    this.smR = [0, 0, 0];
    this.onChange();
  }

  /**
   * HID reports: id 1 = translation (x, y, z; newer devices append rx, ry, rz),
   * id 2 = rotation, id 3 = buttons. Values are little-endian int16.
   */
  handleReport(reportId: number, d: DataView) {
    const i16 = (o: number) => (d.byteLength >= o + 2 ? d.getInt16(o, true) : 0);
    if (reportId === 1) {
      this.raw.t = [i16(0), i16(2), i16(4)];
      if (d.byteLength >= 12) this.raw.r = [i16(6), i16(8), i16(10)];
    } else if (reportId === 2) {
      this.raw.r = [i16(0), i16(2), i16(4)];
    } else if (reportId === 3) {
      let b = 0;
      for (let k = 0; k < Math.min(4, d.byteLength); k++) b |= d.getUint8(k) << (8 * k);
      this.pressed(b);
    }
    if (this.raw.t.some((v) => v !== 0) || this.raw.r.some((v) => v !== 0)) this.onActivity();
    this.startLoop();
  }

  private onReport(e: HIDInputReportEventLike) {
    this.handleReport(e.reportId, e.data);
  }

  /** Fire spaceButton for newly pressed buttons. */
  private pressed(b: number) {
    const down = b & ~this.buttons;
    this.buttons = b;
    for (let i = 0; i < 32; i++) if (down & (1 << i)) this.target.spaceButton(i);
  }

  private gamepadConnected(g: Gamepad) {
    if (!GAMEPAD_RE.test(g.id) || g.axes.length < 6) return;
    this.gamepadIndex = g.index;
    if (!this.device) {
      this.via = 'gamepad';
      this.name = g.id.replace(/\s*\(.*\)\s*/g, ' ').trim() || 'SpaceMouse';
      this.onChange();
    }
    this.startLoop();
  }

  private pollGamepad() {
    if (this.gamepadIndex === null || this.device) return;
    const g = navigator.getGamepads?.()[this.gamepadIndex];
    if (!g) return;
    const a = g.axes;
    this.raw.t = [a[0] * FULL_SCALE, a[1] * FULL_SCALE, a[2] * FULL_SCALE];
    this.raw.r = [a[3] * FULL_SCALE, a[4] * FULL_SCALE, a[5] * FULL_SCALE];
    let b = 0;
    g.buttons.forEach((btn, i) => btn.pressed && i < 32 && (b |= 1 << i));
    this.pressed(b);
  }

  private startLoop() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.tick);
  }

  /** Rate control: deflection = speed; runs while the cap is moved (or a gamepad is connected). */
  private tick = (now: number) => {
    // capped so a stalled tab does not jump, but slow frames (big volumes, weak GPUs) keep their speed
    const dt = Math.min(0.12, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    this.pollGamepad();
    const n = (v: number) => {
      let x = Math.max(-1, Math.min(1, v / FULL_SCALE));
      const s = Math.sign(x);
      x = Math.abs(x) < DEAD_ZONE ? 0 : (Math.abs(x) - DEAD_ZONE) / (1 - DEAD_ZONE);
      return s * (0.4 * x + 0.6 * x * x); // finer control near the centre
    };
    const [x, y, z] = this.raw.t;
    const [rx, ry, rz] = this.raw.r;
    // HID (x right, y towards user, z down) -> screen (X right, Y up, Z towards user)
    const st = this.settings.invertTranslation ? -1 : 1;
    const sr = this.settings.invertRotation ? -1 : 1;
    const t: Vec3 = [st * n(x), st * n(-z), st * n(y)];
    const r: Vec3 = [sr * n(rx), sr * n(-rz), sr * n(ry)];
    // light smoothing (~40 ms) evens out noisy / unevenly timed reports
    const a = dt > 0 ? 1 - Math.exp(-dt / 0.04) : 0;
    let any = false;
    for (let i = 0; i < 3; i++) {
      this.smT[i] += (t[i] - this.smT[i]) * a;
      this.smR[i] += (r[i] - this.smR[i]) * a;
      if (t[i] === 0 && Math.abs(this.smT[i]) < 0.003) this.smT[i] = 0;
      if (r[i] === 0 && Math.abs(this.smR[i]) < 0.003) this.smR[i] = 0;
      any ||= this.smT[i] !== 0 || this.smR[i] !== 0;
    }
    if (any && dt > 0) {
      this.onActivity();
      this.target.spaceMotion([...this.smT] as Vec3, [...this.smR] as Vec3, dt * this.settings.speed);
    }
    if (any || this.gamepadIndex !== null) requestAnimationFrame(this.tick);
    else this.loopRunning = false;
  };
}
