// Planning report (PDF): an overview of the planning views, the implant list and one page per
// implant with its data and the views centred on it (cross-sections, axial, tangential, 3D,
// panoramic). Made in the browser (jsPDF, loaded when a report is made).

import type { jsPDF as JsPdf } from 'jspdf';
import { formatDicomDate, formatPatientName } from '../dicomMeta';
import { Implant, apexOf, apicalDiameterOf, isTapered, platformOf } from '../implant';
import { addScaled } from '../math';
import { findModel } from '../implantLibrary';
import type { View } from '../views/View';
import { deliverFile } from './save';
import { setMode } from './layout';
import { $, app, hideLoading, setStatus, showLoading } from './shell';

const PAGE = { w: 297, h: 210, m: 7 };
const BAND = { y: 34, h: 9 };
const FOOT_Y = 193;
const INK: [number, number, number] = [24, 30, 40];
const MUTED: [number, number, number] = [110, 118, 132];
const BAND_FILL: [number, number, number] = [222, 227, 235];
const FOOT_FILL: [number, number, number] = [19, 26, 38];

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
async function settle() {
  await nextFrame();
  await nextFrame();
  await new Promise((r) => setTimeout(r, 120));
}

const mm = (v: number, d = 2) => `${v.toFixed(d)} mm`;

/** What the report says about an implant: label / value rows in sections. */
export function implantSections(imp: Implant): { title: string; rows: [string, string][] }[] {
  const out: { title: string; rows: [string, string][] }[] = [];
  const model = imp.lib ? findModel(imp.lib.id) : null;
  if (model) {
    out.push({
      title: 'Implant',
      rows: [
        ['Manufacturer', model.brand.name],
        ['System', model.system.name],
        ['Size', model.size.label],
        ['Length', mm(model.size.L)],
        ['Diameter', mm(model.size.d)],
        ['Length in bone (measured)', mm(imp.length)],
        ['Widest / apex Ø (measured)', `${imp.diameter.toFixed(2)} / ${apicalDiameterOf(imp).toFixed(2)} mm`],
      ],
    });
  } else {
    out.push({
      title: 'Implant',
      rows: [
        ['Type', isTapered(imp) ? 'Generic, tapered' : 'Generic, cylindrical'],
        ['Length', mm(imp.length)],
        ['Diameter (platform)', mm(imp.diameter)],
        ...(isTapered(imp) ? ([['Diameter (apex)', mm(apicalDiameterOf(imp))]] as [string, string][]) : []),
      ],
    });
  }
  const ab = imp.abutment;
  out.push({
    title: 'Abutment',
    rows: ab
      ? [
          ['Type', `Generic MUA, ${ab.angle ? `angled ${ab.angle}°` : 'straight 0°'}`],
          ['Gingival height', mm(ab.gingivalHeight, 1)],
          ...(ab.angle ? ([['Rotation (0° = buccal)', `${ab.rotation}°`]] as [string, string][]) : []),
        ]
      : [['Type', 'None']],
  });
  const pos: [string, string][] = [
    ['Jaw', app.implantJaw(imp) === 'upper' ? 'Maxilla' : 'Mandible'],
    ['Inclination from vertical', `${app.implantTilt(imp).toFixed(1)}°`],
  ];
  if (ab) {
    const d = app.prostheticAxis(imp);
    const up = app.frame[2];
    const t = (Math.acos(Math.min(1, Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]))) * 180) / Math.PI;
    pos.push(['Abutment axis from vertical', `${t.toFixed(1)}°`]);
  }
  for (const r of app.angleTable()) {
    if (r.a !== imp && r.b !== imp) continue;
    const other = r.a === imp ? r.b : r.a;
    pos.push([`Angle to ${other.name}`, `${r.implant.toFixed(1)}°${r.abutment !== null ? ` (MUA ${r.abutment.toFixed(1)}°)` : ''}`]);
  }
  for (const { nerve, d } of app.nerveDistances(imp)) pos.push([`Distance to ${nerve.name}`, d <= 0 ? 'touches the nerve!' : `${mm(d, 1)}${d < 2 ? ' (< 2 mm)' : ''}`]);
  out.push({ title: 'Position', rows: pos });
  return out;
}

/** Overview: every planning view where it is on screen, as one image. */
function captureLayout(): HTMLCanvasElement | null {
  const layout = app.planAxial.el.parentElement;
  if (!layout) return null;
  const L = layout.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(L.width * dpr);
  c.height = Math.round(L.height * dpr);
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0f17';
  g.fillRect(0, 0, c.width, c.height);
  for (const v of app.views) {
    if (!v.visible || v.el.parentElement !== layout) continue;
    const img = v.capture();
    if (!img) continue;
    const r = v.el.getBoundingClientRect();
    g.drawImage(img, (r.x - L.x) * dpr, (r.y - L.y) * dpr, r.width * dpr, r.height * dpr);
  }
  return c;
}

/** Aspect ratios (width / height) of the image boxes on an implant page. */
const SQUARE = 1;
const WIDE = 2.03;

/**
 * One view for an implant page: enlarged to the whole layout while it is drawn, then cut to the
 * box's shape – around the implant (`around`: how much of the view, from the implant's length or
 * a width in mm when it is seen end-on), or the middle of the view (`whole`).
 */
async function shot(v: View, imp: Implant, aspect: number, how: 'along' | 'endOn' | 'whole'): Promise<HTMLCanvasElement | null> {
  const wasMax = v.el.classList.contains('max');
  if (!wasMax) app.toggleMaximize(v);
  await settle();
  const c = v.capture();
  const W = v.el.clientWidth, H = v.el.clientHeight;
  let cx = W / 2, cy = H / 2, h = H;
  if (how !== 'whole') {
    const a = v.screenPoint(platformOf(imp)), b = v.screenPoint(apexOf(imp));
    if (a && b) {
      cx = (a[0] + b[0]) / 2;
      cy = (a[1] + b[1]) / 2;
      if (how === 'along') h = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]) * 2.6, 140);
      else {
        // seen from above: 36 mm across
        const e = v.screenPoint(addScaled(imp.center, app.frame[0], 18));
        h = e ? Math.max(2 * Math.hypot(e[0] - cx, e[1] - cy), 140) : H;
      }
    }
  }
  if (!wasMax) app.toggleMaximize(v);
  if (!c) return null;
  // the crop, in the view and then in the captured image
  h = Math.min(h, H, W / aspect);
  const w = h * aspect;
  const x0 = Math.min(Math.max(0, cx - w / 2), W - w), y0 = Math.min(Math.max(0, cy - h / 2), H - h);
  const k = c.width / Math.max(1, W);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * k));
  out.height = Math.max(1, Math.round(h * k));
  out.getContext('2d')!.drawImage(c, x0 * k, y0 * k, w * k, h * k, 0, 0, out.width, out.height);
  return out;
}

interface ImplantShots {
  imp: Implant;
  cross: (HTMLCanvasElement | null)[];
  axial: HTMLCanvasElement | null;
  tang: HTMLCanvasElement | null;
  v3d: HTMLCanvasElement | null;
  pano: HTMLCanvasElement | null;
}

/** Make the report (resolves to the PDF bytes). */
export async function makeReport(progress: (f: number, text: string) => void): Promise<ArrayBuffer> {
  const vol = app.vol!;
  // the planning layout with every view in its cell; put back afterwards
  const saved = {
    mode: app.mode,
    maxed: app.views.find((v) => v.el.classList.contains('max')) ?? null,
    selected: app.selectedId,
    s: app.s,
    focusC: app.focusC,
    tang: app.tangAngle,
  };
  const shots: ImplantShots[] = [];
  let overview: HTMLCanvasElement | null = null;
  try {
    if (app.mode !== 'plan') setMode('plan');
    if (saved.maxed) app.toggleMaximize(saved.maxed);
    await settle();
    progress(0.05, 'Capturing the views…');
    overview = captureLayout();
    const list = app.implants.filter((i) => !i.hidden);
    for (let k = 0; k < list.length; k++) {
      const imp = list[k];
      progress(0.1 + (0.7 * k) / Math.max(1, list.length), `Capturing ${imp.name}…`);
      app.selectImplant(imp.id, true);
      app.tangAngle = 0;
      app.changed();
      await settle();
      const cross: (HTMLCanvasElement | null)[] = [];
      for (const v of app.crossViews) cross.push(await shot(v, imp, SQUARE, 'along'));
      shots.push({
        imp,
        cross,
        axial: await shot(app.planAxial, imp, SQUARE, 'endOn'),
        tang: await shot(app.tang, imp, WIDE, 'along'),
        v3d: await shot(app.view3d, imp, SQUARE, 'whole'),
        pano: await shot(app.pano, imp, WIDE, 'whole'),
      });
    }
  } finally {
    app.selectImplant(saved.selected, false);
    app.s = saved.s;
    app.focusC = saved.focusC;
    app.tangAngle = saved.tang;
    if (saved.maxed) app.toggleMaximize(saved.maxed);
    if (saved.mode !== 'plan') setMode(saved.mode);
    app.changed();
  }

  progress(0.85, 'Writing the PDF…');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const info = vol.info;
  const patient = {
    name: formatPatientName(info.patientName) || '–',
    birth: formatDicomDate(info.birthDate) || '–',
    id: info.patientId?.trim() || '–',
  };
  const printed = new Date();
  const pages: ((pdf: JsPdf) => void)[] = [];

  // overview
  pages.push((pdf) => {
    frame(pdf, 'Overview');
    if (overview) image(pdf, overview, PAGE.m, BAND.y + BAND.h + 3, PAGE.w - 2 * PAGE.m, FOOT_Y - (BAND.y + BAND.h + 3) - 3);
  });
  // implant list
  pages.push((pdf) => {
    frame(pdf, 'Implant list');
    implantTable(pdf);
  });
  // one page per implant
  for (const s of shots)
    pages.push((pdf) => {
      frame(pdf, 'Implant details');
      implantPage(pdf, s);
    });

  pages.forEach((draw, i) => {
    if (i) doc.addPage();
    draw(doc);
    footer(doc, i + 1, pages.length);
  });
  progress(1, 'Done');
  return doc.output('arraybuffer');

  // ---- page parts -----------------------------------------------------------------

  function frame(pdf: JsPdf, title: string) {
    pdf.setDrawColor(...BAND_FILL);
    pdf.setLineWidth(0.3);
    pdf.rect(PAGE.m, PAGE.m, PAGE.w - 2 * PAGE.m, PAGE.h - 2 * PAGE.m);
    pdf.setTextColor(...INK);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text('Quick DICOM Planning', PAGE.m + 4, PAGE.m + 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...MUTED);
    pdf.text('Implant planning report', PAGE.m + 4, PAGE.m + 14);
    pdf.text(`Scan: ${info.seriesDescription?.trim() || 'CBCT'}`, PAGE.m + 4, PAGE.m + 19);
    pdf.setTextColor(...INK);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10);
    const px = 90;
    pdf.text('Patient data', px, PAGE.m + 8);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.text(`Name: ${patient.name}`, px, PAGE.m + 14);
    pdf.text(`Date of birth: ${patient.birth}`, px, PAGE.m + 19);
    pdf.text(`Patient ID: ${patient.id}`, px, PAGE.m + 24);
    pdf.setTextColor(...MUTED);
    pdf.text(`Implants: ${app.implants.filter((i) => !i.hidden).map((i) => i.name).join(', ') || 'none'}`, 180, PAGE.m + 14);
    pdf.setFillColor(...BAND_FILL);
    pdf.rect(PAGE.m, BAND.y, PAGE.w - 2 * PAGE.m, BAND.h, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text(title, PAGE.w / 2, BAND.y + 6.3, { align: 'center' });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...MUTED);
    pdf.text(`${app.implants.filter((i) => !i.hidden).length} implants`, PAGE.w - PAGE.m - 3, BAND.y + 6, { align: 'right' });
  }

  function footer(pdf: JsPdf, n: number, total: number) {
    const y = FOOT_Y;
    pdf.setFillColor(...FOOT_FILL);
    pdf.rect(PAGE.m, y, PAGE.w - 2 * PAGE.m, PAGE.h - PAGE.m - y, 'F');
    pdf.setTextColor(200, 210, 225);
    pdf.setFontSize(6.2);
    pdf.setFont('helvetica', 'normal');
    const disclaimer =
      'This report shows the plan as entered in Quick DICOM Planning, research software for implant planning on CBCT. It does not replace the ' +
      'assessment of the case by a qualified dental professional, who is responsible for checking every value, image and position before treatment. ' +
      'Images are not for diagnostic use.';
    pdf.text(pdf.splitTextToSize(disclaimer, 190), PAGE.m + 3, y + 3.6);
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.text(`Printed: ${printed.toLocaleString()}`, PAGE.w - PAGE.m - 3, y + 4.5, { align: 'right' });
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Page ${n} of ${total}`, PAGE.w - PAGE.m - 3, y + 8.5, { align: 'right' });
  }

  function image(pdf: JsPdf, c: HTMLCanvasElement | null, x: number, y: number, w: number, h: number) {
    pdf.setFillColor(0, 0, 0);
    pdf.rect(x, y, w, h, 'F');
    if (!c || !c.width || !c.height) {
      pdf.setTextColor(...MUTED);
      pdf.setFontSize(8);
      pdf.text('not shown', x + w / 2, y + h / 2, { align: 'center' });
      return;
    }
    const k = Math.min(w / c.width, h / c.height);
    const iw = c.width * k, ih = c.height * k;
    pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  }

  function implantTable(pdf: JsPdf) {
    const cols: [string, number, 'left' | 'right'][] = [
      ['Position', 30, 'left'],
      ['Manufacturer', 30, 'left'],
      ['System / model', 58, 'left'],
      ['Size', 32, 'left'],
      ['Length', 20, 'right'],
      ['Ø 1', 18, 'right'],
      ['Ø 2', 18, 'right'],
      ['Abutment', 50, 'left'],
      ['Inclination', 27, 'right'],
    ];
    let y = BAND.y + BAND.h + 4;
    const x0 = PAGE.m + 2;
    const rowH = 8;
    const row = (cells: string[], head: boolean) => {
      if (head) {
        pdf.setFillColor(...BAND_FILL);
        pdf.rect(x0, y, PAGE.w - 2 * PAGE.m - 4, rowH, 'F');
      }
      pdf.setFont('helvetica', head ? 'bold' : 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...INK);
      let x = x0;
      cells.forEach((c, i) => {
        const [, w, al] = cols[i];
        const t = pdf.splitTextToSize(c, w - 3)[0] ?? '';
        pdf.text(t, al === 'right' ? x + w - 2 : x + 2, y + 5.4, { align: al });
        x += w;
      });
      pdf.setDrawColor(...BAND_FILL);
      pdf.line(x0, y + rowH, PAGE.w - PAGE.m - 2, y + rowH);
      y += rowH;
    };
    row(cols.map((c) => c[0]), true);
    const list = app.implants.filter((i) => !i.hidden);
    if (!list.length) {
      pdf.setTextColor(...MUTED);
      pdf.text('No implants in the plan.', x0 + 2, y + 6);
      return;
    }
    for (const imp of list) {
      const m = imp.lib ? findModel(imp.lib.id) : null;
      const ab = imp.abutment;
      row(
        [
          imp.name,
          m ? m.brand.name : 'Generic',
          m ? m.system.name : isTapered(imp) ? 'Tapered' : 'Cylindrical',
          m ? m.size.label : `${imp.diameter.toFixed(1)} × ${imp.length.toFixed(1)} mm`,
          mm(m ? m.size.L : imp.length),
          mm(m ? m.size.d : imp.diameter),
          mm(m ? imp.diameter : apicalDiameterOf(imp)),
          ab ? `MUA ${ab.angle}°, GH ${ab.gingivalHeight} mm` : '–',
          `${app.implantTilt(imp).toFixed(1)}°`,
        ],
        false,
      );
    }
    pdf.setFontSize(7.5);
    pdf.setTextColor(...MUTED);
    pdf.text(
      'Ø 1: nominal diameter (library implants) or platform diameter. Ø 2: widest measured diameter in bone (library implants) or apex diameter. ' +
        'Abutments are generic multi-unit abutments (MUA).',
      x0 + 2,
      y + 6,
    );
  }

  function implantPage(pdf: JsPdf, s: ImplantShots) {
    const top = BAND.y + BAND.h + 3;
    // left: the data
    const lx = PAGE.m + 3, lw = 88;
    let y = top + 3;
    pdf.setTextColor(...INK);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text('Position:', lx, y + 2);
    pdf.text(s.imp.name, lx + lw, y + 2, { align: 'right' });
    y += 6;
    for (const sec of implantSections(s.imp)) {
      pdf.setDrawColor(...BAND_FILL);
      pdf.line(lx, y, lx + lw, y);
      y += 4.6;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(sec.title, lx, y);
      y += 4.8;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8.6);
      for (const [k, v] of sec.rows) {
        pdf.setTextColor(...INK);
        pdf.text(k, lx, y);
        const warn = /nerve|< 2 mm/.test(v);
        if (warn) pdf.setTextColor(200, 60, 40);
        const vv = pdf.splitTextToSize(v, lw - pdf.getTextWidth(k) - 4);
        pdf.text(vv, lx + lw, y, { align: 'right' });
        y += 4.4 * Math.max(1, vv.length);
      }
      y += 1;
    }
    // right: the views, centred on this implant
    const rx = PAGE.m + 100, rw = PAGE.w - PAGE.m - 3 - rx;
    const gap = 2;
    const rh = (FOOT_Y - 3 - top - 2 * gap) / 3;
    const cw = (rw - 2 * gap) / 3;
    s.cross.forEach((c, i) => image(pdf, c, rx + i * (cw + gap), top, cw, rh));
    image(pdf, s.axial, rx, top + rh + gap, cw, rh);
    image(pdf, s.tang, rx + cw + gap, top + rh + gap, 2 * cw + gap, rh);
    image(pdf, s.v3d, rx, top + 2 * (rh + gap), cw, rh);
    image(pdf, s.pano, rx + cw + gap, top + 2 * (rh + gap), 2 * cw + gap, rh);
  }
}

/** File name for the report: the patient and the date. */
export function reportName(): string {
  const info = app.vol?.info;
  const who = formatPatientName(info?.patientName).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '') || 'patient';
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${who}_planning_report_${date}.pdf`;
}

let busy = false;
$('btn-export-report').onclick = async () => {
  if (busy) return;
  if (!app.vol) {
    setStatus('Open a CBCT first.', true);
    return;
  }
  busy = true;
  try {
    const bytes = await makeReport((f, text) => showLoading(text, f));
    hideLoading();
    const ok = await deliverFile(new Blob([bytes], { type: 'application/pdf' }), reportName(), { description: 'PDF report', accept: { 'application/pdf': ['.pdf'] } });
    if (ok) setStatus(`Planning report saved (${app.implants.filter((i) => !i.hidden).length} implants).`);
  } catch (e) {
    hideLoading();
    setStatus(`The report could not be made: ${(e as Error).message}`, true);
  } finally {
    busy = false;
  }
};
