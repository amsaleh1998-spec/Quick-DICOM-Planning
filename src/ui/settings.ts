// ⚙ Settings popover: input device and trackpad guide, right-drag behaviour, SpaceMouse,
// and the desktop-only entries (install, helper, mobile version).

import { saveInputPreference } from '../app';
import { initTrackpadGuide, showTrackpadGuide } from '../tutorial';
import { SpaceMouse, SpaceMouseTarget } from '../spacemouse';
import { MeshViewer } from '../meshViewer';
import { isPhone } from '../uiMode';
import { $, app, setStatus } from './shell';

// input device (mouse / trackpad) and the trackpad guide
const inputButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#input-seg button'));
function setInput(v: 'mouse' | 'trackpad') {
  app.input = v;
  saveInputPreference(v);
  app.changed();
}
inputButtons.forEach((b) => (b.onclick = () => setInput(b.dataset.input as 'mouse' | 'trackpad')));
$('btn-trackpad-guide').onclick = () => showTrackpadGuide();
// phone user on the full version: offer the way back
$('btn-mobile').classList.toggle('hidden', !isPhone());
initTrackpadGuide(setInput, () => app.input);

const rdButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#rd-seg button'));
rdButtons.forEach(
  (b) =>
    (b.onclick = () => {
      app.rightDrag = b.dataset.rd as 'zoom' | 'wl';
      app.changed();
    }),
);

// ---- 3Dconnexion SpaceMouse --------------------------------------------------------
// The cap drives whatever is under the mouse pointer: a pane of the scan alignment window, a 2D
// view (pan along the slice, push/pull = zoom) or the 3D view (also the default).
let smPointerEl: Element | null = null;
let smLastViewer: MeshViewer | null = null;
window.addEventListener('pointermove', (e) => (smPointerEl = e.target as Element), { capture: true, passive: true });
function spaceMouseTarget(): SpaceMouseTarget {
  const el = smPointerEl;
  if (MeshViewer.active.size) {
    // alignment window open: the pane under the pointer (or the last one used)
    for (const mv of MeshViewer.active) if (el && mv.el.contains(el)) return (smLastViewer = mv);
    return smLastViewer && MeshViewer.active.has(smLastViewer) ? smLastViewer : [...MeshViewer.active][0];
  }
  if (el) for (const v of app.views) if (v.visible && v.el.contains(el)) return v;
  return app.view3d;
}
const spaceMouse = new SpaceMouse({
  spaceMotion: (t, r, dt) => spaceMouseTarget().spaceMotion(t, r, dt),
  spaceButton: (i) => spaceMouseTarget().spaceButton(i),
});
// the 3Dconnexion driver also scrolls/zooms with the cap: ignore wheel events meanwhile
spaceMouse.onActivity = () => (app.wheelBlockedUntil = MeshViewer.wheelBlockedUntil = performance.now() + 300);
(window as unknown as { spaceMouse: SpaceMouse }).spaceMouse = spaceMouse; // debugging / tests
const smButton = $<HTMLButtonElement>('btn-spacemouse');
const smSpeed = $<HTMLInputElement>('sm-speed');
const smInvRot = $<HTMLInputElement>('sm-inv-rot');
const smInvTr = $<HTMLInputElement>('sm-inv-tr');
function refreshSpaceMouse() {
  const on = !!spaceMouse.name;
  smButton.textContent = on && spaceMouse.via === 'hid' ? 'Disconnect' : 'Connect SpaceMouse';
  smButton.classList.toggle('hidden', !spaceMouse.supported);
  $('sm-status').textContent = on
    ? `${spaceMouse.name}${spaceMouse.via === 'gamepad' ? ' (game controller)' : ''}`
    : spaceMouse.supported
      ? ''
      : 'Use Chrome or Edge to connect one (other browsers only if they expose it as a game controller).';
  $('sm-settings').classList.toggle('hidden', !on);
  smSpeed.value = String(spaceMouse.settings.speed);
  $('sm-speed-val').textContent = `${spaceMouse.settings.speed.toFixed(1)}×`;
  smInvRot.checked = spaceMouse.settings.invertRotation;
  smInvTr.checked = spaceMouse.settings.invertTranslation;
}
spaceMouse.onChange = () => {
  refreshSpaceMouse();
  if (spaceMouse.name) setStatus(`SpaceMouse connected: ${spaceMouse.name}`);
};
smButton.onclick = async () => {
  if (spaceMouse.via === 'hid') {
    await spaceMouse.disconnect();
    return;
  }
  const err = await spaceMouse.connect();
  if (err) setStatus(err, true);
};
smSpeed.oninput = () => {
  spaceMouse.settings.speed = Number(smSpeed.value);
  spaceMouse.saveSettings();
  refreshSpaceMouse();
};
smInvRot.onchange = () => {
  spaceMouse.settings.invertRotation = smInvRot.checked;
  spaceMouse.saveSettings();
};
smInvTr.onchange = () => {
  spaceMouse.settings.invertTranslation = smInvTr.checked;
  spaceMouse.saveSettings();
};
refreshSpaceMouse();
spaceMouse.autoConnect();

export function refreshSettings() {
  const desktopVisible = ['btn-install', 'btn-helper', 'btn-mobile'].some((id) => !$(id).classList.contains('hidden'));
  $('settings-desktop').classList.toggle('hidden', !desktopVisible);
  rdButtons.forEach((b) => b.classList.toggle('active', b.dataset.rd === app.rightDrag));
  inputButtons.forEach((b) => b.classList.toggle('active', b.dataset.input === app.input));
}
