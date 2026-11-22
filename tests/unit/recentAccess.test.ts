// A Recent item kept from an earlier session that the browser no longer answers for: when reading
// still works it opens anyway, otherwise it is reported as stale (to be chosen again).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecentEntry, readRecent } from '../../src/ui/recent';

const never = () => new Promise<never>(() => {});
const file = (name: string) => ({ kind: 'file', name, getFile: async () => new File(['x'], name) });
function entry(handle: unknown): RecentEntry {
  return { id: '1', kind: 'folder', handles: [handle as FileSystemHandle], depth: 0, label: 'ANONYMOUS', sub: 'folder', when: 0 };
}

describe('Recent access', () => {
  afterEach(() => vi.useRealTimers());

  it('no answer about the access, and none when reading: stale', async () => {
    vi.useFakeTimers();
    const h = { kind: 'directory', name: 'ANONYMOUS', queryPermission: never, values: () => ({ [Symbol.asyncIterator]: () => ({ next: never }) }) };
    const p = readRecent(entry(h));
    const check = expect(p).rejects.toMatchObject({ name: 'StaleAccessError' });
    await vi.advanceTimersByTimeAsync(4000 + 5000 + 10);
    await check;
  });

  it('no answer about the access, but reading works: it opens', async () => {
    vi.useFakeTimers();
    const items = [file('a.dcm'), file('b.dcm')];
    const h = {
      kind: 'directory',
      name: 'ANONYMOUS',
      queryPermission: never,
      values: async function* () {
        yield* items;
      },
    };
    const p = readRecent(entry(h));
    await vi.advanceTimersByTimeAsync(4010);
    expect((await p).map((f) => f.name)).toEqual(['a.dcm', 'b.dcm']);
  });

  it('a granted item opens straight away', async () => {
    const h = {
      kind: 'directory',
      name: 'ANONYMOUS',
      queryPermission: async () => 'granted',
      values: async function* () {
        yield file('a.dcm');
      },
    };
    expect((await readRecent(entry(h))).length).toBe(1);
  });
});
