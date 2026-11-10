// Implants panel: add buttons, the implant list, the selected implant (size, taper, parallel,
// abutment), defaults and the angle table.

import type { Jaw } from '../app';
import { MAX_IMPLANT_LENGTH, MUA_HEIGHTS, apicalDiameterOf, isTapered, setApicalDiameter, setCoronalDiameter } from '../implant';
import { NERVE_SAFETY_MM } from '../nerve';
import { LibSystem, findModel, implantIndex, loadImplantIndex, modelId, nearestSize, setOnMeshesLoaded } from '../implantLibrary';
import { $, EYE, EYE_OFF, app, clampNum, escapeHtml } from './shell';

const placeButton = (jaw: Jaw) => () => {
  if (!app.vol) return;
  if (app.placing === jaw) {
    app.placing = null;
    app.changed();
  } else app.startPlacing(jaw);
};
$('btn-add-upper').onclick = placeButton('upper');
$('btn-add-lower').onclick = placeButton('lower');

const defD = $<HTMLInputElement>('def-d');
const defL = $<HTMLInputElement>('def-l');
defD.onchange = () => (app.defaultDiameter = clampNum(defD.value, 2, 8, 4));
const defTapered = $<HTMLInputElement>('def-tapered');
defTapered.onchange = () => (app.defaultTapered = defTapered.checked);
defL.onchange = () => (app.defaultLength = clampNum(defL.value, 4, MAX_IMPLANT_LENGTH, 10));
const impName = $<HTMLInputElement>('imp-name');
impName.oninput = () => {
  const imp = app.selectedImplant();
  // keep typing smooth: store as typed, empty is fixed up on blur
  if (imp) {
    imp.name = impName.value.slice(0, 40);
    app.changed();
  }
};
impName.onblur = () => {
  const imp = app.selectedImplant();
  if (imp) app.renameImplant(imp.id, impName.value);
};
impName.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') impName.blur();
};
const impD = $<HTMLInputElement>('imp-d');
const impTapered = $<HTMLInputElement>('imp-tapered');
const impAd = $<HTMLInputElement>('imp-ad');
impTapered.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  // default taper: apex 1 mm narrower than the platform
  if (impTapered.checked) setApicalDiameter(imp, Math.round((imp.diameter - 1) * 10) / 10);
  else imp.apicalDiameter = null;
  app.implantChanged(imp, true);
};
impAd.oninput = () => {
  const imp = app.selectedImplant();
  if (!imp || impAd.value === '') return;
  setApicalDiameter(imp, clampNum(impAd.value, 1.5, imp.diameter, apicalDiameterOf(imp)));
  app.implantChanged(imp, true);
};
const impL = $<HTMLInputElement>('imp-l');
impD.oninput = () => {
  const imp = app.selectedImplant();
  if (imp && impD.value) {
    setCoronalDiameter(imp, clampNum(impD.value, 1, 10, imp.diameter));
    app.changed();
  }
};
impL.oninput = () => {
  const imp = app.selectedImplant();
  if (imp && impL.value) app.setLength(imp.id, clampNum(impL.value, 2, MAX_IMPLANT_LENGTH, imp.length));
};

// ---- implant library: brand / system / size ----------------------------------------------------

const MODEL_KEY = 'qdp.implantModel';
/** Three selects choosing Generic or a library model; `dims`: the nominal size to stay close to. */
function modelPicker(prefix: 'imp' | 'def', dims: () => { d: number; L: number }, apply: (id: string | null) => void) {
  const brandSel = $<HTMLSelectElement>(`${prefix}-brand`);
  const systemSel = $<HTMLSelectElement>(`${prefix}-system`);
  const sizeSel = $<HTMLSelectElement>(`${prefix}-size`);
  const row = $(`${prefix}-lib-row`);
  let shown = '\u0000';
  const systemOf = () => implantIndex()?.brands.find((b) => b.name === brandSel.value)?.systems.find((s) => s.name === systemSel.value) ?? null;
  const fillSystems = () => {
    const b = implantIndex()?.brands.find((x) => x.name === brandSel.value);
    systemSel.innerHTML = (b?.systems ?? []).map((s) => `<option>${escapeHtml(s.name)}</option>`).join('');
  };
  const fillSizes = (sys: LibSystem | null) => {
    if (!sys) return (sizeSel.innerHTML = '');
    // grouped by platform / line (NC, RC …) when the system has several
    const groups = [...new Set(sys.sizes.map((z) => z.prefix))];
    const opt = (z: LibSystem['sizes'][number]) => `<option value="${escapeHtml(z.label)}">${escapeHtml(groups.length > 1 ? z.label.replace(z.prefix + ' ', '') : z.label)}</option>`;
    sizeSel.innerHTML =
      groups.length > 1
        ? groups.map((g) => `<optgroup label="${escapeHtml(g || 'Standard')}">${sys.sizes.filter((z) => z.prefix === g).map(opt).join('')}</optgroup>`).join('')
        : sys.sizes.map(opt).join('');
  };
  const pick = () => {
    const sys = systemOf();
    if (!sys) return apply(null);
    apply(modelId(brandSel.value, sys.name, sizeSel.value));
  };
  brandSel.onchange = () => {
    if (!brandSel.value) return apply(null);
    fillSystems();
    const sys = systemOf();
    fillSizes(sys);
    if (sys) sizeSel.value = nearestSize(sys, dims().d, dims().L).label;
    pick();
  };
  systemSel.onchange = () => {
    const sys = systemOf();
    fillSizes(sys);
    if (sys) sizeSel.value = nearestSize(sys, dims().d, dims().L).label;
    pick();
  };
  sizeSel.onchange = pick;
  return {
    /** show a model (or generic) */
    set(id: string | null) {
      const ix = implantIndex();
      const key = `${id}|${ix ? (ix.library ?? 1) : 0}`; // a library update refills the lists
      row.classList.toggle('hidden', !id);
      if (key === shown) return;
      shown = key;
      brandSel.innerHTML = `<option value="">Generic</option>` + (ix?.brands ?? []).map((b) => `<option>${escapeHtml(b.name)}</option>`).join('');
      const f = id ? findModel(id) : null;
      brandSel.value = f ? f.brand.name : '';
      if (f) {
        fillSystems();
        systemSel.value = f.system.name;
        fillSizes(f.system);
        sizeSel.value = f.size.label;
      }
    },
  };
}

const nominal = (id: string | null | undefined) => (id ? findModel(id)?.size : null);
const impPicker = modelPicker(
  'imp',
  () => {
    const imp = app.selectedImplant();
    const n = nominal(imp?.lib?.id);
    return n ? { d: n.d, L: n.L } : { d: imp?.diameter ?? 4, L: imp?.length ?? 10 };
  },
  (id) => {
    const imp = app.selectedImplant();
    if (!imp) return;
    app.applyModel(imp, id);
    // the model chosen last is the one new implants get
    setDefaultModel(id);
    app.implantChanged(imp, true);
  },
);
const defPicker = modelPicker(
  'def',
  () => {
    const n = nominal(app.defaultModel);
    return n ? { d: n.d, L: n.L } : { d: app.defaultDiameter, L: app.defaultLength };
  },
  (id) => {
    setDefaultModel(id);
    app.changed();
  },
);
function setDefaultModel(id: string | null) {
  app.defaultModel = id;
  try {
    if (id) localStorage.setItem(MODEL_KEY, id);
    else localStorage.removeItem(MODEL_KEY);
  } catch {
    /* not remembered */
  }
}
try {
  app.defaultModel = localStorage.getItem(MODEL_KEY);
} catch {
  /* none */
}
setOnMeshesLoaded(() => app.changed());
loadImplantIndex()
  .then(() => {
    // implants of an opened project start loading their meshes
    for (const imp of app.implants) if (imp.lib) app.applyModel(imp, imp.lib.id);
    app.changed();
  })
  .catch(() => {
    /* offline: generic implants only */
  });

// parallel placement
const placeParallel = $<HTMLInputElement>('place-parallel');
placeParallel.onchange = () => (app.placeParallel = placeParallel.checked);
const parallelTo = $<HTMLSelectElement>('parallel-to');
$('btn-parallel').onclick = () => {
  if (app.selectedId !== null && parallelTo.value) app.makeParallel(app.selectedId, Number(parallelTo.value));
};
$('btn-flip').onclick = () => app.selectedId !== null && app.flipImplant(app.selectedId);

// abutments
const impAxis = $<HTMLInputElement>('imp-axis');
impAxis.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  imp.showProstheticAxis = impAxis.checked;
  app.changed();
};
const abType = $<HTMLSelectElement>('ab-type');
const abHeight = $<HTMLSelectElement>('ab-height');
const abRot = $<HTMLInputElement>('ab-rot');
abHeight.innerHTML = MUA_HEIGHTS.map((h) => `<option value="${h}">${h}</option>`).join('');
abHeight.value = '2';
abType.onchange = () => {
  const imp = app.selectedImplant();
  if (!imp) return;
  if (abType.value === 'none') imp.abutment = null;
  else {
    if (!imp.abutment) imp.showProstheticAxis = true; // adding an MUA shows its axis (can be switched off)
    const angle = Number(abType.value);
    imp.abutment = { angle, gingivalHeight: imp.abutment?.gingivalHeight ?? Number(abHeight.value), rotation: imp.abutment?.rotation ?? 0 };
  }
  app.changed();
};
abHeight.onchange = () => {
  const imp = app.selectedImplant();
  if (imp?.abutment) {
    imp.abutment.gingivalHeight = Number(abHeight.value);
    app.changed();
  }
};
abRot.oninput = () => {
  const imp = app.selectedImplant();
  if (imp?.abutment) {
    imp.abutment.rotation = Number(abRot.value);
    app.changed();
  }
};
$('btn-ab-auto').onclick = () => app.selectedId !== null && app.autoAlignAbutment(app.selectedId);
$('btn-upright').onclick = () => app.selectedId !== null && app.uprightImplant(app.selectedId);
$('btn-deselect').onclick = () => app.selectImplant(null, false);
$('btn-delete').onclick = () => app.selectedId !== null && app.deleteImplant(app.selectedId);

const implantList = $('implant-list');
// eye / MUA toggles inside list entries (handled before the entry's own click = select)
for (const type of ['click', 'dblclick'] as const) {
  implantList.addEventListener(
    type,
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.vis-btn');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      if (type === 'dblclick') return;
      const id = Number(btn.dataset.id);
      const imp = app.implantById(id);
      if (!imp) return;
      if (btn.dataset.kind === 'ab') app.setAbutmentHidden(id, !imp.abutmentHidden);
      else app.setImplantHidden(id, !imp.hidden);
    },
    true,
  );
}
$('btn-show-all-implants').onclick = () => app.showAllImplants();
const listItems = new Map<number, HTMLLIElement>();

export function refreshImplantsPanel() {
  for (const jaw of ['upper', 'lower'] as Jaw[]) {
    const b = $(`btn-add-${jaw}`);
    b.textContent = app.placing === jaw ? 'Click in a view… (Esc)' : `+ ${jaw === 'upper' ? 'Upper' : 'Lower'} implant`;
    b.classList.toggle('active', app.placing === jaw);
  }
  if (document.activeElement !== defD) defD.value = String(app.defaultDiameter);
  defTapered.checked = app.defaultTapered;
  if (document.activeElement !== defL) defL.value = String(app.defaultLength);

  // update the list in place (keeps elements alive so double-click works)
  const seen = new Set<number>();
  app.implants.forEach((imp, idx) => {
    seen.add(imp.id);
    let li = listItems.get(imp.id);
    if (!li) {
      li = document.createElement('li') as HTMLLIElement;
      const id = imp.id;
      li.title = 'Click to select · double-click to rename';
      li.onclick = () => {
        const imp = app.implantById(id);
        const sl = imp && app.curves.length > 1 ? app.curveForImplant(imp) : null;
        if (sl) app.activateCurve(sl.id); // e.g. an upper implant shows the maxilla curve
        app.selectImplant(id, true);
      };
      li.ondblclick = () => {
        app.selectImplant(id, true);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            impName.focus();
            impName.select();
          }),
        );
      };
      listItems.set(id, li);
    }
    const ab = imp.abutment ? ` · MUA ${imp.abutment.angle}°/${imp.abutment.gingivalHeight}` : '';
    const dia = isTapered(imp) ? `Ø${imp.diameter.toFixed(1)}→${apicalDiameterOf(imp).toFixed(1)}` : `Ø${imp.diameter.toFixed(1)}`;
    const near = app.nerveDistances(imp).some((x) => x.d < NERVE_SAFETY_MM);
    const warn = near ? ' <span class="warn" title="Closer than 2 mm to the nerve">⚠</span>' : '';
    const eye = `<button class="vis-btn${imp.hidden ? ' off' : ''}" data-id="${imp.id}" data-kind="imp" title="${imp.hidden ? 'Show' : 'Hide'} this implant">${imp.hidden ? EYE_OFF : EYE}</button>`;
    const muaBtn = imp.abutment
      ? `<button class="vis-btn mua${imp.abutmentHidden ? ' off' : ''}" data-id="${imp.id}" data-kind="ab" title="${imp.abutmentHidden ? 'Show' : 'Hide'} the abutment (MUA)">MUA</button>`
      : '';
    const size = imp.lib ? imp.lib.id.split(' / ').slice(1).join(' ') : `${dia} × ${imp.length.toFixed(1)}`;
    const html = `<span class="vis">${eye}${muaBtn}</span><span class="nm">${escapeHtml(imp.name)}${warn}</span><span class="dim">${escapeHtml(size)} · ${app.implantTilt(imp).toFixed(0)}°${ab}</span>`;
    if (li.innerHTML !== html) li.innerHTML = html;
    li.className = (imp.id === app.selectedId ? 'sel' : '') + (imp.hidden ? ' hidden-imp' : '');
    if (implantList.children[idx] !== li) implantList.insertBefore(li, implantList.children[idx] ?? null);
  });
  $('btn-show-all-implants').classList.toggle('hidden', !app.implants.some((i) => i.hidden || (i.abutment && i.abutmentHidden)));
  for (const [id, li] of listItems) {
    if (!seen.has(id)) {
      li.remove();
      listItems.delete(id);
    }
  }
  const sel = app.selectedImplant();
  $('implant-edit').classList.toggle('hidden', !sel);
  defPicker.set(app.defaultModel && findModel(app.defaultModel) ? app.defaultModel : null);
  $('def-generic').classList.toggle('hidden', !!(app.defaultModel && findModel(app.defaultModel)));
  if (sel) {
    impPicker.set(sel.lib?.id ?? null);
    $('imp-generic').classList.toggle('hidden', !!sel.lib);
    if (document.activeElement !== impName) impName.value = sel.name;
    if (document.activeElement !== impD) impD.value = sel.diameter.toFixed(1);
    const tapered = sel.apicalDiameter !== null;
    impTapered.checked = tapered;
    impAd.disabled = !tapered;
    impAd.max = String(sel.diameter);
    $('imp-ad-label').classList.toggle('muted', !tapered);
    if (document.activeElement !== impAd) impAd.value = apicalDiameterOf(sel).toFixed(1);
    if (document.activeElement !== impL) impL.value = sel.length.toFixed(1);
    const others = app.implants.filter((i) => i !== sel);
    const lines = [`Inclination ${app.implantTilt(sel).toFixed(1)}° from vertical`];
    if (sel.lib) {
      const ap = isTapered(sel) ? ` → apex Ø${apicalDiameterOf(sel).toFixed(2)}` : '';
      lines.unshift(`Body Ø${sel.diameter.toFixed(2)}${ap} · ${sel.length.toFixed(2)} mm in bone${sel.lib.top > 0.05 ? ` + ${sel.lib.top.toFixed(1)} mm above the platform` : ''}`);
    }
    if (sel.abutment) {
      const d = app.prostheticAxis(sel);
      const t = (Math.acos(Math.min(1, Math.abs(d[0] * app.frame[2][0] + d[1] * app.frame[2][1] + d[2] * app.frame[2][2]))) * 180) / Math.PI;
      lines.push(`Abutment axis ${t.toFixed(1)}° from vertical`);
    }
    const nerveLines = app.nerveDistances(sel).map(
      ({ nerve, d }) =>
        `<div class="${d < NERVE_SAFETY_MM ? 'warn' : ''}">${escapeHtml(nerve.name)}: ${d <= 0 ? 'touches the nerve!' : `${d.toFixed(1)} mm`}${
          d > 0 && d < NERVE_SAFETY_MM ? ` (&lt; ${NERVE_SAFETY_MM} mm)` : ''
        }</div>`,
    );
    $('imp-info').innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') + nerveLines.join('');
    // parallel-to options
    const prev = parallelTo.value;
    parallelTo.innerHTML = others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    if (others.some((o) => String(o.id) === prev)) parallelTo.value = prev;
    $('parallel-row').classList.toggle('hidden', !others.length);
    // abutment
    impAxis.checked = sel.showProstheticAxis;
    abType.value = sel.abutment ? String(sel.abutment.angle) : 'none';
    abHeight.disabled = !sel.abutment;
    if (sel.abutment) abHeight.value = String(sel.abutment.gingivalHeight);
    $('ab-rot-row').classList.toggle('hidden', !sel.abutment);
    if (sel.abutment && document.activeElement !== abRot) abRot.value = String(sel.abutment.rotation);
    $('ab-rot-val').textContent = sel.abutment ? `${sel.abutment.rotation}°` : '';
  }
  placeParallel.checked = app.placeParallel;

  // angle table
  const rows = app.angleTable();
  $('angles-box').classList.toggle('hidden', !rows.length);
  const anyAb = rows.some((r) => r.abutment !== null);
  $('angle-table').innerHTML =
    `<tr><th>Implants</th><th>Angle</th>${anyAb ? '<th>Abutments</th>' : ''}</tr>` +
    rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.a.name.replace('Implant ', '#'))} – ${escapeHtml(r.b.name.replace('Implant ', '#'))}</td><td>${r.implant.toFixed(1)}°</td>${
            anyAb ? `<td>${r.abutment === null ? '–' : r.abutment.toFixed(1) + '°'}</td>` : ''
          }</tr>`,
      )
      .join('');
}
