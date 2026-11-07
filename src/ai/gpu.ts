// Which graphics card WebGPU gives us (laptops often have a slow integrated GPU next to a fast
// NVIDIA / AMD one, and Chrome on Windows picks the GPU set for the browser in Windows, not the
// one a page asks for).

interface GpuAdapterLike {
  limits: Record<string, number>;
  info?: { vendor?: string; architecture?: string; description?: string; device?: string };
}

export interface GpuInfo {
  adapter: unknown;
  vendor: string;
  /** e.g. "NVIDIA ampere", "Intel gen-12lp" */
  label: string;
  /** an integrated Intel GPU (Iris / UHD / Xe-LP): a dedicated card would be much faster */
  integrated: boolean;
}

const VENDORS: Record<string, string> = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', google: 'Google' };

/** The high-performance WebGPU adapter, or the reason there is none. */
export async function findGpu(): Promise<GpuInfo | string> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return 'this browser has no WebGPU';
  try {
    const a = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return 'no WebGPU graphics adapter';
    const info = a.info ?? {};
    const vendor = (info.vendor || '').toLowerCase();
    const arch = info.architecture || '';
    const name = info.description || [VENDORS[vendor] ?? vendor, arch].filter(Boolean).join(' ') || 'unknown graphics card';
    // Intel "lp" architectures are integrated; Arc cards are "hpg"
    const integrated = vendor === 'intel' && !/hpg|arc/i.test(`${arch} ${info.description ?? ''}`);
    return { adapter: a, vendor, label: name, integrated };
  } catch (e) {
    return (e as Error).message || 'WebGPU is not available';
  }
}

/** Largest activation of the network: 64 × 130 × 160 × 112 floats (≈ 600 MB). */
export function gpuBuffersTooSmall(g: GpuInfo): boolean {
  const l = (g.adapter as GpuAdapterLike).limits;
  return (l.maxStorageBufferBindingSize ?? 0) < 600e6 || (l.maxBufferSize ?? 0) < 600e6;
}

/** Running in Microsoft Edge (rather than Chrome)? */
export function inEdge(): boolean {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return brands ? brands.some((b) => /Edge/i.test(b.brand)) : /\bEdg\//.test(navigator.userAgent);
}

const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WIN_GRAPHICS = '<b>Settings → System → Display → Graphics</b>';

/**
 * How to run only this app on the dedicated graphics card on Windows (HTML). Windows picks the
 * GPU per program and the installed app runs inside its browser's program, so the app gets the
 * NVIDIA card on its own by living in Microsoft Edge (a separate program) while Chrome stays as is.
 */
export function dedicatedGpuHelp(appUrl: string): string {
  if (inEdge())
    return `
  <ol>
    <li>Windows ${WIN_GRAPHICS} → <b>Microsoft Edge</b> (missing? <i>Add desktop app → Browse</i>: <code>${EDGE_EXE}</code>)
      → <b>High performance</b> (your NVIDIA card) → Save.</li>
    <li>Close Edge completely (also its icon next to the clock, if any) and open Quick DICOM Planning again.</li>
  </ol>
  <p>Chrome is not affected. Keep the laptop plugged in – on battery the NVIDIA card is slowed down.</p>`;
  return `
  <p>Windows chooses the graphics card per program, and the installed app runs inside Chrome – so it cannot get the
    NVIDIA card without Chrome getting it too. Run the app in <b>Microsoft Edge</b> instead (a separate program,
    everything works the same) and give only Edge the NVIDIA card:</p>
  <ol>
    <li>Open <code>${appUrl}</code> in <b>Microsoft Edge</b> and click <b>Install app</b>.</li>
    <li>Windows ${WIN_GRAPHICS} → <b>Microsoft Edge</b> (missing? <i>Add desktop app → Browse</i>: <code>${EDGE_EXE}</code>)
      → <b>High performance</b> → Save.</li>
    <li>Close Edge completely and start Quick DICOM Planning from the Start menu (the Edge copy).</li>
    <li>Using the double-click helper? Run it again – it then opens scans in the Edge copy. The Chrome copy can be
      removed (in Chrome: <code>chrome://apps</code> → right-click → Remove).</li>
  </ol>
  <p>Chrome keeps using the Intel graphics (pages you open in Edge itself would use the NVIDIA card too). Keep the
    laptop plugged in – on battery the NVIDIA card is slowed down. This dialog then shows the NVIDIA card.</p>`;
}
