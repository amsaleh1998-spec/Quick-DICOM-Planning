// Handing files to the user (projects, STL exports).

import { hideLoading, setStatus, showLoading } from './shell';
import { writeZip } from '../zip';

type DownloadsNs = { save(r: { filename: string; data: Blob }): Promise<unknown> };
type ClaudeHost = { use(name: string): Promise<unknown> };

/** Hand the file to the user: hosted page capability, native save dialog, or a plain download. */
export type FileTypeSpec = { description: string; accept: Record<string, string[]> };
const PROJECT_FILE_TYPE: FileTypeSpec = { description: 'Quick DICOM Planning project', accept: { 'application/zip': ['.zip'] } };

/**
 * `onSaved` gets the saved file's handle where the browser's save dialog was used (Chrome, Edge) –
 * e.g. to list a saved project under Recent. Downloads give no handle.
 */
export async function deliverFile(
  blob: Blob,
  filename: string,
  fileType: FileTypeSpec = PROJECT_FILE_TYPE,
  onSaved?: (handle: FileSystemFileHandle) => void,
): Promise<boolean> {
  const host = (window as unknown as { claude?: ClaudeHost }).claude;
  if (host?.use) {
    const dl = (await host.use('downloads').catch(() => null)) as DownloadsNs | null;
    if (dl) {
      try {
        await dl.save({ filename, data: blob });
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'declined') return false;
        // a host that does not take this file type (e.g. .stl): hand it over packed in a ZIP
        if (code === 'rejected_extension' && !/\.zip$/i.test(filename)) {
          const zip = await writeZip([{ name: filename, data: new Uint8Array(await blob.arrayBuffer()) }]);
          try {
            await dl.save({ filename: `${filename}.zip`, data: zip });
            return true;
          } catch (e2) {
            if ((e2 as { code?: string }).code === 'declined') return false;
            throw new Error(`Saving failed (${(e2 as { code?: string }).code ?? (e2 as Error).message})`);
          }
        }
        throw new Error(`Saving failed (${code ?? (e as Error).message})`);
      }
    }
  }
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [fileType],
      });
      const w = await (handle as unknown as { createWritable(): Promise<WritableStream & { write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      onSaved?.(handle);
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return false;
      // e.g. not allowed in this frame – fall back to a normal download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export const exportHooks = {
  showLoading,
  hideLoading,
  setStatus,
  deliver: (blob: Blob, name: string, type: FileTypeSpec) => deliverFile(blob, name, type),
};
