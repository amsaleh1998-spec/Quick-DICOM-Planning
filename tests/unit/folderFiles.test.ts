// Listing a folder through file system handles: depth, progress, and a time limit when the
// browser does not answer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirLike, folderFiles } from '../../src/folderFiles';

const file = (name: string) => ({ kind: 'file' as const, name, getFile: async () => new File(['x'], name) });
const dir = (name: string, items: unknown[]): DirLike => ({
  kind: 'directory',
  name,
  values: async function* () {
    for (const i of items) yield i as never;
  },
});

describe('folder files', () => {
  afterEach(() => vi.useRealTimers());

  it('reads the files down to the depth asked, telling the progress', async () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`IM${i}.dcm`));
    const root = dir('ANONYMOUS', [...files, dir('sub', [file('a.dcm'), dir('deeper', [file('b.dcm')])])]);
    const steps: string[] = [];
    const all = await folderFiles(root, 1, (t) => steps.push(t));
    expect(all.map((f) => f.name).sort()).toEqual([...files.map((f) => f.name), 'a.dcm'].sort()); // b.dcm is 2 levels down
    expect(steps[0]).toBe('Looking through “ANONYMOUS”…');
    expect(steps).toContain('Looking through “ANONYMOUS”… 25 files');
    expect(steps[steps.length - 1]).toBe('Reading files… 41 of 41');
    expect((await folderFiles(root, 0)).length).toBe(40);
  });

  it('gives up, naming the folder, when the browser does not answer', async () => {
    vi.useFakeTimers();
    const stuck: DirLike = {
      kind: 'directory',
      name: 'ANONYMOUS',
      values: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }) as never,
    };
    const p = folderFiles(stuck, 4);
    const check = expect(p).rejects.toThrow('Listing the folder “ANONYMOUS” did not answer within 15 s');
    await vi.advanceTimersByTimeAsync(15001);
    await check;
  });
});
