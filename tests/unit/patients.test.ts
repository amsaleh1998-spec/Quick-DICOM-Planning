// A folder with scans of several patients: the loader groups them by patient and lets the user
// choose; with one patient nothing is asked. (Made-up patients only.)
import { describe, expect, it } from 'vitest';
import { LoadCancelled, loadDicomFiles, type PatientGroup } from '../../src/dicom';
import { formatPatientName, patientFolderName } from '../../src/dicomMeta';
import { testSeriesFiles } from './helpers';

const jane = { name: 'Doe^Jane', id: 'PAT-1001', birth: '19700101', sex: 'F' };
const richard = { name: 'Roe^Richard', id: 'PAT-2002', birth: '19650505', sex: 'M' };
const mixed = () => [
  ...testSeriesFiles({ patient: jane, uid: '1.2.826.0.1.3680043.8.498.71', prefix: 'A', slices: 30 }),
  ...testSeriesFiles({ patient: richard, uid: '1.2.826.0.1.3680043.8.498.72', prefix: 'B', slices: 40 }),
];

describe('several patients in one folder', () => {
  it('asks which patient, describes each one, and opens the one chosen', async () => {
    let seen: PatientGroup[] = [];
    const vol = await loadDicomFiles(mixed(), () => {}, {
      choosePatient: async (p) => {
        seen = p;
        return p.findIndex((x) => x.id === 'PAT-1001'); // the smaller scan
      },
    });
    expect(seen.map((p) => [formatPatientName(p.name), p.id, p.birthDate, p.sex]).sort()).toEqual([
      ['DOE, Jane', 'PAT-1001', '19700101', 'F'],
      ['ROE, Richard', 'PAT-2002', '19650505', 'M'],
    ]);
    const byId: Record<string, PatientGroup> = Object.fromEntries(seen.map((p) => [p.id, p]));
    expect(byId['PAT-1001'].files.length).toBe(30);
    expect(byId['PAT-2002'].files.length).toBe(40);
    expect(byId['PAT-1001'].files.every((f) => f.name.startsWith('A'))).toBe(true);
    expect(byId['PAT-2002'].series[0].slices).toBe(40);
    expect(formatPatientName(vol.info.patientName)).toBe('DOE, Jane');
    expect(Math.max(vol.nx, vol.ny, vol.nz)).toBeGreaterThanOrEqual(30);
  });

  it('cancelling opens nothing', async () => {
    await expect(loadDicomFiles(mixed(), () => {}, { choosePatient: async () => null })).rejects.toBeInstanceOf(LoadCancelled);
  });

  it('one patient: nothing is asked', async () => {
    let asked = false;
    await loadDicomFiles(testSeriesFiles(), () => {}, {
      choosePatient: async () => {
        asked = true;
        return 0;
      },
    });
    expect(asked).toBe(false);
  });

  it('names the patient folders after the patient', () => {
    expect(patientFolderName({ name: 'Doe^Jane', id: 'PAT-1001' }, 0)).toBe('DOE Jane (ID PAT-1001)');
    expect(patientFolderName({ name: 'O:Brien^Ann', birthDate: '19800101' }, 1)).toBe('O_BRIEN Ann (born 1980-01-01)');
    expect(patientFolderName({}, 2)).toBe('Patient 3');
  });
});
