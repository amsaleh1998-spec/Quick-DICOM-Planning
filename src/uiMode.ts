/**
 * Phone detection and the desktop/mobile preference. index.html carries an
 * inline copy of this logic so phones are redirected before the desktop page renders.
 */
const UI_KEY = 'qdp.ui';

export function isPhone(): boolean {
  if (/Android.+Mobile|iPhone|iPod|Windows Phone|Mobi/i.test(navigator.userAgent)) return true;
  try {
    return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600;
  } catch {
    return false;
  }
}

/** Remember "desktop" (phone user chose the full version) or clear the choice. */
export function setUiPreference(v: 'desktop' | null) {
  try {
    if (v) localStorage.setItem(UI_KEY, v);
    else localStorage.removeItem(UI_KEY);
  } catch {
    /* storage unavailable */
  }
}
