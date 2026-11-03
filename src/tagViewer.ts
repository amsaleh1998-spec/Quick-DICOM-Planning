import type { MetaEntry } from './dicomMeta';

let modal: HTMLDivElement | null = null;
let current: MetaEntry[] = [];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function matches(e: MetaEntry, q: string): boolean {
  return (e.tag + ' ' + e.name + ' ' + e.vr + ' ' + e.value).toLowerCase().includes(q);
}

/** Does the entry or anything inside its sequence items match? */
function subtreeMatches(e: MetaEntry, q: string): boolean {
  return matches(e, q) || !!e.items?.some((it) => it.some((c) => subtreeMatches(c, q)));
}

function rows(entries: MetaEntry[], q: string, depth: number, out: string[]): number {
  let n = 0;
  for (const e of entries) {
    if (q && !subtreeMatches(e, q)) continue;
    n++;
    const pad = depth * 16;
    const isPrivate = e.name === 'Private tag' || e.name === 'Unknown';
    out.push(
      `<tr class="${isPrivate ? 'tv-private' : ''}${e.items ? ' tv-seq' : ''}">` +
        `<td class="tv-tag" style="padding-left:${8 + pad}px">${esc(e.tag)}</td>` +
        `<td>${esc(e.name)}</td><td class="tv-vr">${esc(e.vr)}</td>` +
        `<td class="tv-val">${esc(e.value)}</td></tr>`,
    );
    if (e.items) {
      e.items.forEach((item, i) => {
        // with a search, show only matching items' content
        if (q && !item.some((c) => subtreeMatches(c, q))) return;
        out.push(`<tr class="tv-item"><td colspan="4" style="padding-left:${24 + pad}px">Item ${i + 1}</td></tr>`);
        n += rows(item, q, depth + 1, out);
      });
    }
  }
  return n;
}

function asText(entries: MetaEntry[], depth = 0): string {
  return entries
    .map((e) => {
      const line = `${'  '.repeat(depth)}(${e.tag}) ${e.vr} ${e.name}: ${e.value}`;
      const sub = e.items ? e.items.map((it, i) => `${'  '.repeat(depth + 1)}Item ${i + 1}\n${asText(it, depth + 2)}`).join('\n') : '';
      return sub ? `${line}\n${sub}` : line;
    })
    .join('\n');
}

function render() {
  if (!modal) return;
  const q = modal.querySelector<HTMLInputElement>('.tv-search')!.value.trim().toLowerCase();
  const out: string[] = [];
  const n = rows(current, q, 0, out);
  modal.querySelector('tbody')!.innerHTML = out.join('') || `<tr><td colspan="4" class="tv-empty">No matching tags</td></tr>`;
  modal.querySelector('.tv-count')!.textContent = q ? `${n} matching` : `${current.length} tags`;
}

function build(): HTMLDivElement {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.innerHTML = `
    <div class="modal tv-modal" role="dialog" aria-modal="true" aria-labelledby="tv-title">
      <header>
        <h2 id="tv-title">DICOM tags</h2>
        <button class="modal-close" title="Close (Esc)">×</button>
      </header>
      <p class="intro tv-sub"></p>
      <div class="row tv-tools">
        <input class="tv-search" type="search" placeholder="Search tag, name or value (e.g. 0010, kVp, Manufacturer)" />
        <span class="muted small tv-count"></span>
        <button class="tv-copy" title="Copy all tags as text">Copy all</button>
      </div>
      <div class="tv-scroll">
        <table class="tv-table">
          <thead><tr><th>Tag</th><th>Name</th><th>VR</th><th>Value</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;
  const close = () => (m.style.display = 'none');
  m.addEventListener('pointerdown', (e) => {
    if (e.target === m) close();
  });
  m.querySelector<HTMLButtonElement>('.modal-close')!.onclick = close;
  m.querySelector<HTMLInputElement>('.tv-search')!.oninput = render;
  const copyBtn = m.querySelector<HTMLButtonElement>('.tv-copy')!;
  copyBtn.onclick = async () => {
    const text = asText(current);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
    } catch {
      // clipboard blocked (e.g. embedded page): fall back to a selectable text area
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.className = 'tv-fallback';
      m.querySelector('.tv-scroll')!.prepend(ta);
      ta.select();
      copyBtn.textContent = 'Select & copy';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy all'), 1500);
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && m.style.display !== 'none') {
        e.stopImmediatePropagation();
        close();
      }
    },
    true,
  );
  document.body.append(m);
  return m;
}

export function showTagViewer(meta: MetaEntry[], subtitle: string) {
  current = meta;
  if (!modal) modal = build();
  modal.querySelector('.tv-sub')!.textContent = subtitle;
  modal.querySelector<HTMLInputElement>('.tv-search')!.value = '';
  modal.querySelector('.tv-fallback')?.remove();
  modal.style.display = '';
  render();
  modal.querySelector<HTMLInputElement>('.tv-search')!.focus();
}
