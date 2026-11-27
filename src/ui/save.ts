// Handing files to the user (projects, STL exports).

import { hideLoading, setStatus, showLoading } from './shell';
import { writeZip } from '../zip';

type DownloadsNs = { save(r: { filename: string; data: Blob }): Promise<unknown> };
type ClaudeHost = { use(name: string): Promise<unknown> };

/** Hand the file to the user: hosted page capability, native save dialog, or a plain download. */
export type FileTypeSpec = { description: string; accept: Record<string, string[]> };
/** Projects: .qdp files (a ZIP inside, like .docx – older projects were saved as .qdp.zip). */
export const PROJECT_MIME = 'application/x-quickdicom-project';
const PROJECT_FILE_TYPE: FileTypeSpec = { description: 'Quick DICOM Planning project', accept: { [PROJECT_MIME]: ['.qdp'] } };

/**
 * `onSaved` gets the saved file's handle where the browser's save dialog was used (Chrome, Edge) –
 * e.g. to list a saved project under Recent. Downloads give no handle.
 */
export async function deliverFile(
  blob: Blob,
  filename: string,
  fileType: FileTypeSpec = PROJECT_FILE_TYPE,
  onSaved?: (handle: FileSystemFileHandle) => void,
  /** where the save dialog opens: e.g. the project's own file (its folder, to replace it) */
  startIn?: FileSystemHandle,
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
        ...(startIn ? { startIn } : {}),
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

type PermissionHandle = {
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
};

/**
 * Permission to write the file. Requested at once – call it straight from the click (before any
 * await), while the click still counts as the person's: the browser then asks "allow editing?" for a
 * file it only had read access to (an opened project), or answers at once when it may already. (Not
 * asked first with queryPermission: on some Windows / Edge versions that never answers.) False when
 * not given, or when the browser does not answer in time.
 */
export async function canWrite(handle: FileSystemFileHandle, timeoutMs = 60_000): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (!h.requestPermission) return true; // no permission API: writing will tell
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const asked = h.requestPermission({ mode: 'readwrite' }).then((s) => s === 'granted');
    return await Promise.race([asked, new Promise<boolean>((res) => (t = setTimeout(() => res(false), timeoutMs)))]);
  } catch (e) {
    console.warn('[save] no permission to write', handle.name, e);
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Overwrite a file the person chose before. */
export async function writeFile(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const w = await (handle as unknown as { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
  await w.write(blob);
  await w.close();
}

export const exportHooks = {
  showLoading,
  hideLoading,
  setStatus,
  deliver: (blob: Blob, name: string, type: FileTypeSpec) => deliverFile(blob, name, type),
};
