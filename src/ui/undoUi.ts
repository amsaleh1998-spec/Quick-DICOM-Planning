// Undo / redo buttons in the top bar (and Ctrl+Z / Ctrl+Y, see keyboard.ts).

import { $, app, setStatus } from './shell';

export function undoRedo(redo: boolean) {
  const ok = redo ? app.redoImplants() : app.undoImplants();
  if (!ok) setStatus(redo ? 'Nothing to redo' : 'Nothing to undo');
  else setStatus(`${redo ? 'Redo' : 'Undo'} – ${app.undoCount} step${app.undoCount === 1 ? '' : 's'} to undo, ${app.redoCount} to redo`);
}
$('btn-undo').onclick = () => undoRedo(false);
$('btn-redo').onclick = () => undoRedo(true);

export function refreshUndo() {
  ($('btn-undo') as HTMLButtonElement).disabled = app.undoCount === 0;
  ($('btn-redo') as HTMLButtonElement).disabled = app.redoCount === 0;
}
