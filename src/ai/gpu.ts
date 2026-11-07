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

/** How to make Chrome / Edge use the dedicated graphics card on Windows (HTML). */
export const DEDICATED_GPU_HELP = `
  <ol>
    <li>Windows <b>Settings → System → Display → Graphics</b>.</li>
    <li>Find <b>Google Chrome</b> (or <b>Microsoft Edge</b>) in the list – if it is missing, add it with
      <i>Browse</i>: <code>C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe</code>
      (Edge: <code>C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe</code>).</li>
    <li>Set its graphics preference to <b>High performance</b> (your NVIDIA card) and save.</li>
    <li>Close <b>every</b> Chrome window, including the installed Quick DICOM Planning app, and open it again.</li>
  </ol>
  <p>Alternatively: <b>NVIDIA Control Panel → Manage 3D settings → Program Settings</b> → Google Chrome →
    <i>High-performance NVIDIA processor</i>. Keep the laptop plugged in – on battery the NVIDIA card is slowed down.
    This dialog then shows the NVIDIA card.</p>`;
