// Keyboard shortcuts of the desktop interface (listed in the ? help sheet).

import { showTrackpadGuide } from '../tutorial';
import { showHelp } from './help';
import { app } from './shell';
import { setMode } from './layout';
import { pickAndOpen, saveProject } from './files';
import { undoRedo } from './undoUi';

// ---- keyboard ---------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveProject();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    void pickAndOpen('files');
    return;
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
  // Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo (implant changes; unlimited)
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    const redo = e.key === 'y' || e.key === 'Y' || e.shiftKey;
    undoRedo(redo);
    return;
  }
  if (e.key === 'Enter' && app.segTool === 'cut' && app.cutDraft) {
    app.finishCut();
    return;
  }
  if (e.key === 'Escape' && app.segTool) {
    app.setSegTool(null);
    return;
  }
  if (e.key === 'Escape') {
    if (app.drawing) app.cancelDrawing();
    else if (app.ruler) app.setRuler(false);
    else if (app.placing) {
      app.placing = null;
      app.changed();
    } else app.selectImplant(null, false);
  } else if (e.key === 'Enter' && app.drawing) {
    // the Draw button usually still has focus: don't let Enter also "press" it (that restarted drawing)
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    app.finishCurve();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.hoverMeasurementId !== null) {
    app.deleteMeasurement(app.hoverMeasurementId);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && app.selectedId !== null && app.mode === 'plan') {
    app.deleteImplant(app.selectedId);
  } else if (e.key === 'f' || e.key === 'F') {
    app.fitAll();
  } else if (e.key === 'r' || e.key === 'R') {
    app.setRuler(!app.ruler);
  } else if ((e.key === 'm' || e.key === 'M') && app.activeView) {
    app.toggleMaximize(app.activeView);
  } else if ((e.key === '1' || e.key === '2') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setMode(e.key === '1' ? 'mpr' : 'plan');
  } else if (e.key === '?') {
    showHelp({ trackpadGuide: () => showTrackpadGuide() });
  }
});
