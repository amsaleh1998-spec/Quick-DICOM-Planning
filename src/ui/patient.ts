// Patient chip and popover: name (editable), scan details, DICOM tags; the window title.

import { formatDicomDate, formatPatientName, joinPersonName, splitPersonName } from '../dicomMeta';
import { showTagViewer } from '../tagViewer';
import { $, app, escapeHtml } from './shell';

const ptLast = $<HTMLInputElement>('pt-last');
const ptFirst = $<HTMLInputElement>('pt-first');
function updatePatientBadge() {
  const badge = $('patient-badge');
  const info = app.vol?.info;
  const label = info ? formatPatientName(info.patientName) || info.seriesDescription?.trim() || 'Unnamed scan' : 'No scan open';
  if (badge.textContent !== label) badge.textContent = label;
  const date = info?.studyDate ? `${info.modality === 'CT' ? 'CT' : 'CBCT'} ${formatDicomDate(info.studyDate)}` : '';
  if ($('patient-date').textContent !== date) $('patient-date').textContent = date;
  $('patient-chip').classList.toggle('empty', !info);
  updateWindowTitle();
}
/** Window / tab title starts with the patient (and scan date), so several open scans are easy to tell apart. */
function updateWindowTitle() {
  const info = app.vol?.info;
  const who = info ? formatPatientName(info.patientName) || info.seriesDescription?.trim() || '' : '';
  const date = info?.studyDate ? formatDicomDate(info.studyDate) : '';
  const lead = [who, date].filter(Boolean).join(' · ');
  const title = lead ? `${lead} – Quick DICOM Planning` : 'Quick DICOM Planning';
  if (document.title !== title) document.title = title;
}
const onNameInput = () => {
  if (!app.vol) return;
  // stored as a DICOM person name (Last^First) – saved with the project
  app.vol.info.patientName = joinPersonName(ptLast.value, ptFirst.value);
  updatePatientBadge();
};
ptLast.oninput = onNameInput;
ptFirst.oninput = onNameInput;
$('btn-tags').onclick = () => {
  const info = app.vol?.info;
  if (!info?.meta?.length) return;
  const who = formatPatientName(info.patientName);
  showTagViewer(info.meta, `First file of the series${who ? ` · ${who}` : ''}${info.seriesDescription ? ` · ${info.seriesDescription}` : ''}`);
};

export function refreshPatient() {
  const vol = app.vol;
  const info = vol?.info;
  $('patient-fields').classList.toggle('hidden', !vol);
  if (info) {
    const { last, first } = splitPersonName(info.patientName);
    if (document.activeElement !== ptLast) ptLast.value = last;
    if (document.activeElement !== ptFirst) ptFirst.value = first;
    const sexes: Record<string, string> = { M: 'male', F: 'female', O: 'other' };
    const details = [
      info.patientId ? `ID ${info.patientId}` : '',
      info.birthDate ? `born ${formatDicomDate(info.birthDate)}` : '',
      info.sex ? sexes[info.sex] ?? info.sex : '',
    ].filter(Boolean);
    $('pt-details').textContent = details.join(' · ');
  }
  updatePatientBadge();

  $('vol-info').innerHTML = vol
    ? [
        info!.seriesDescription ? `<div>${escapeHtml(info!.seriesDescription)}</div>` : '',
        info!.studyDate ? `<div>Study ${escapeHtml(formatDicomDate(info!.studyDate))}${info!.modality ? ` · ${escapeHtml(info!.modality)}` : ''}</div>` : '',
        info!.manufacturer || info!.model ? `<div>${escapeHtml([info!.manufacturer, info!.model].filter(Boolean).join(' '))}</div>` : '',
        `<div>${vol.nx} × ${vol.ny} × ${vol.nz} voxels</div>`,
        `<div>${vol.spacing.map((s) => s.toFixed(3)).join(' × ')} mm</div>`,
        `<div class="small">${escapeHtml(info!.source)}</div>`,
      ].join('')
    : 'Open a DICOM series (files or folder, or drag &amp; drop) or load the demo volume.';
  const tagsBtn = $('btn-tags');
  tagsBtn.classList.toggle('hidden', !vol);
  tagsBtn.textContent = info?.meta ? `DICOM tags (${info.meta.length})` : 'DICOM tags';
  tagsBtn.toggleAttribute('disabled', !info?.meta?.length);
  tagsBtn.title = info?.meta?.length ? 'Show every DICOM attribute of the series' : 'No DICOM tags (demo volume)';
}
