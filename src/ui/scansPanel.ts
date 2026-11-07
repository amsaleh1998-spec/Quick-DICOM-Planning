// Scans panel: intraoral / surface scans (STL, PLY, OBJ) – import, placement, appearance, export.

import { readMeshFile } from '../meshio';
import { SCAN_KINDS, Scan, ScanKind, createScan, placementLabel } from '../scans';
import { showAlignment, showPlacement } from '../alignUi';
import { showExportStl } from '../exportStl';
import { $, app, fromHex, hideLoading, rgbCss, setList, setStatus, showLoading, toHex, escapeHtml } from './shell';
import { exportHooks } from './save';

const scanList = $('scan-list');
const scanInput = $<HTMLInputElement>('scan-input');
const scanName = $<HTMLInputElement>('scan-name');
const scanColor = $<HTMLInputElement>('scan-color');
const scanKind = $<HTMLSelectElement>('scan-kind');
const scanOpacity = $<HTMLInputElement>('scan-opacity');
const scanVcol = $<HTMLInputElement>('scan-vcol');
const alignHooks = { setStatus, showLoading, hideLoading };
scanKind.innerHTML = SCAN_KINDS.map((k) => `<option value="${k.kind}">${k.label}</option>`).join('');
const activeScan = (): Scan | null => app.scans.find((s) => s.id === app.activeScanId) ?? null;

$('btn-scan-import').onclick = () => {
  if (!app.vol) {
    setStatus('Open a CBCT first – the scan is placed in it.', true);
    return;
  }
  scanInput.click();
};
scanInput.onchange = async () => {
  const files = Array.from(scanInput.files ?? []);
  scanInput.value = '';
  await importScans(files);
};

/** Read STL / PLY / OBJ files and ask how to place each one. */
export async function importScans(files: File[]) {
  for (const f of files) {
    try {
      showLoading(`Reading ${f.name}…`, 0.3);
      await new Promise((r) => setTimeout(r, 0));
      const mesh = await readMeshFile(f);
      const scan = createScan(f.name, mesh);
      app.scans.push(scan);
      app.activeScanId = scan.id;
      hideLoading();
      app.changed();
      setStatus(`${f.name}: ${(mesh.idx.length / 3).toLocaleString()} triangles${mesh.col ? ', with colours' : ''}`);
      showPlacement(app, scan, alignHooks);
    } catch (e) {
      console.error(e);
      setStatus(`${f.name}: ${(e as Error).message}`, true);
    } finally {
      hideLoading();
    }
  }
}

scanName.oninput = () => {
  const s = activeScan();
  if (s) {
    s.name = scanName.value || s.fileName;
    app.changed();
  }
};
scanColor.oninput = () => {
  const s = activeScan();
  if (!s) return;
  const h = scanColor.value;
  s.color = fromHex(h);
  s.vertexColors = false;
  app.changed();
};
scanKind.onchange = () => {
  const s = activeScan();
  if (!s) return;
  s.kind = scanKind.value as ScanKind;
  app.changed();
};
scanOpacity.oninput = () => {
  const s = activeScan();
  if (!s) return;
  s.opacity = Number(scanOpacity.value);
  app.changed();
};
scanVcol.onchange = () => {
  const s = activeScan();
  if (!s) return;
  s.vertexColors = scanVcol.checked;
  app.changed();
};
$('btn-scan-align').onclick = () => {
  const s = activeScan();
  if (s) showAlignment(app, s, alignHooks);
};
$('btn-scan-place').onclick = () => {
  const s = activeScan();
  if (s) showPlacement(app, s, alignHooks);
};
$('btn-scan-export').onclick = () => {
  const s = activeScan();
  if (!s?.transform) {
    setStatus('Place the scan first (Align… or Place…).', true);
    return;
  }
  showExportStl(app, exportHooks, { scanId: s.id });
};
$('btn-scan-delete').onclick = () => {
  const s = activeScan();
  if (!s) return;
  setStatus(`“${s.name}” deleted – Ctrl+Z brings it back.`);
  app.scans = app.scans.filter((x) => x !== s);
  app.activeScanId = null;
  app.changed();
};
$<HTMLInputElement>('scan-show-2d').onchange = (e) => {
  app.showScanContours = (e.target as HTMLInputElement).checked;
  app.changed();
};

export function refreshScanUi() {
  setList(
    scanList,
    app.scans.map((s) => ({
      key: String(s.id),
      sel: s.id === app.activeScanId,
      html: `<span class="swatch" style="background:${rgbCss(s.color)}"></span><span class="name">${escapeHtml(s.name)}</span><span class="dim">${s.transform ? '' : 'not placed'}</span><button data-act="eye" class="${s.visible ? '' : 'off'}" title="Show / hide">${s.visible ? 'Hide' : 'Show'}</button>`,
      onClick: () => {
        app.activeScanId = s.id === app.activeScanId ? null : s.id;
        app.changed();
      },
      onButton: () => {
        s.visible = !s.visible;
        app.changed();
      },
    })),
  );
  $<HTMLInputElement>('scan-show-2d').checked = app.showScanContours;
  const s = activeScan();
  $('scan-edit').classList.toggle('hidden', !s);
  $('btn-scan-import').toggleAttribute('disabled', !app.vol);
  if (!s) return;
  if (document.activeElement !== scanName) scanName.value = s.name;
  if (document.activeElement !== scanColor) scanColor.value = toHex(s.color);
  scanKind.value = s.kind;
  if (document.activeElement !== scanOpacity) scanOpacity.value = String(s.opacity);
  $('scan-vcol-row').classList.toggle('hidden', !s.mesh.col);
  $('btn-scan-export').toggleAttribute('disabled', !s.transform);
  scanVcol.checked = s.vertexColors;
  const fit = s.placement?.target ? ` on ${s.placement.target}` : '';
  $('scan-info').textContent = `${s.fileName} · ${(s.mesh.idx.length / 3).toLocaleString()} triangles · ${placementLabel(s)}${fit}`;
}
