import type { BrowserSupport, EngineKind } from './types';

/** Browser/PWA sandbox detection; installation status is deliberately separate. */
export function isNativeDesktop(scope: unknown = globalThis): boolean {
  if (!scope || typeof scope !== 'object') return false;
  const root = scope as Record<string, unknown>;
  const win = root.window && typeof root.window === 'object' ? root.window as Record<string, unknown> : root;
  return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI__);
}

/** True for both an installed PWA and its normal browser tab. Neither can use native engines. */
export function isPWA(scope: unknown = globalThis): boolean {
  return !isNativeDesktop(scope);
}

export function detectEngine(scope: unknown = globalThis): EngineKind {
  return isNativeDesktop(scope) ? 'native' : 'webllm';
}

export function isInstalledPWA(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

type Adapter = {
  features: Iterable<string>;
  limits: { maxStorageBufferBindingSize?: number };
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
};
type GPU = { requestAdapter(options?: { powerPreference?: string }): Promise<Adapter | null> };

export async function checkBrowserSupport(): Promise<BrowserSupport> {
  if (typeof navigator === 'undefined') return {
    supported: false, reason: 'LocalLLM needs a browser with WebGPU.', secureContext: false, webgpu: false, features: [],
  };
  const nav = navigator as Navigator & { gpu?: GPU; deviceMemory?: number };
  const secure = globalThis.isSecureContext === true;
  const support: BrowserSupport = {
    supported: false, secureContext: secure, webgpu: Boolean(nav.gpu), features: [],
    deviceMemoryGB: nav.deviceMemory,
  };
  try {
    const estimate = await nav.storage?.estimate();
    support.storageUsage = estimate?.usage;
    support.storageQuota = estimate?.quota;
    support.persistentStorage = await nav.storage?.persisted?.();
  } catch { /* Storage estimates are optional and can be unavailable in private browsing. */ }
  if (!secure) return { ...support, reason: 'Open the app over HTTPS. LocalLLM requires a secure browser context.' };
  if (!nav.gpu) return { ...support, reason: 'WebGPU is not available in this browser. Try an up-to-date browser with WebGPU support on a compatible device.' };
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ...support, reason: 'No compatible graphics adapter was available. Update your browser and graphics driver, then try again.' };
    return { ...support, supported: true, features: Array.from(adapter.features),
      gpuName: adapter.info?.description || [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || 'WebGPU adapter',
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize };
  } catch (error) {
    return { ...support, reason: error instanceof Error ? error.message : 'The browser could not initialize WebGPU.' };
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
}
