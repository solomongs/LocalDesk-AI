import type { BrowserSupport } from './types';
import type { ChatOptions, ModelRecord } from '@mlc-ai/web-llm';

/** Device memory and storage quota are estimates, not measurements of free GPU memory. */
export interface MobileCompatibilityModel {
  id: string;
  runtimeMemoryGB: number;
  downloadGB: number;
  modelType?: 'chat' | 'vision' | 'embedding';
  chatLoadable?: boolean;
  requiredFeatures?: readonly string[];
  bufferSizeRequiredBytes?: number;
  contextWindow?: number;
}

export interface MobileModelCompatibility {
  loadable: boolean;
  status: 'unsupported' | 'unavailable' | 'caution' | 'ready';
  label: string;
  reasons: string[];
  warnings: string[];
}

export function getMobileContextWindow(model?: Pick<MobileCompatibilityModel, 'contextWindow'>): number {
  const context = model?.contextWindow;
  return Number.isFinite(context) && context! > 0 ? Math.max(256, Math.min(2048, Math.floor(context!))) : 2048;
}

/** Keep model-specific sliding-window and recurrent-state settings intact. */
export function getMobileReloadOptions(record: Pick<ModelRecord, 'overrides'>, model?: Pick<MobileCompatibilityModel, 'contextWindow'>): ChatOptions {
  const options = { ...record.overrides };
  if (typeof options.sliding_window_size === 'number' && options.sliding_window_size > 0) {
    return { ...options, context_window_size: -1 };
  }
  const catalogLimit = options.context_window_size;
  const requestedLimit = getMobileContextWindow(model);
  return { ...options, context_window_size: typeof catalogLimit === 'number' && catalogLimit > 0 ? Math.min(catalogLimit, requestedLimit) : requestedLimit };
}

export function getMobileModelCompatibility(
  model: MobileCompatibilityModel,
  support: BrowserSupport | null | undefined,
  options: { cached?: boolean } = {},
): MobileModelCompatibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (model.chatLoadable === false || (model.modelType && model.modelType !== 'chat')) {
    const reason = model.modelType === 'embedding'
      ? 'Embedding models make search vectors; this app does not have an embedding workspace.'
      : 'This model needs an image input workflow that is not available in this chat.';
    return { loadable: false, status: 'unsupported', label: 'Browse only', reasons: [reason], warnings };
  }
  if (!support) return { loadable: false, status: 'unavailable', label: 'Checking device', reasons: ['Browser compatibility is still being checked.'], warnings };
  if (!support.supported) return { loadable: false, status: 'unavailable', label: 'WebGPU unavailable', reasons: [support.reason || 'This browser cannot run the LocalLLM engine.'], warnings };

  // Some upstream entries omit the explicit feature while naming an f16 library.
  const requiredFeatures = new Set(model.requiredFeatures ?? []);
  if (/(?:^|-)q\d+f16(?:_|-|$)/i.test(model.id)) requiredFeatures.add('shader-f16');
  const missing = [...requiredFeatures].filter(feature => !support.features.includes(feature));
  if (missing.length) reasons.push(`This variant needs a GPU feature this browser does not expose: ${missing.join(', ')}.`);
  if (model.bufferSizeRequiredBytes && support.maxStorageBufferBindingSize && model.bufferSizeRequiredBytes > support.maxStorageBufferBindingSize) {
    reasons.push('This variant needs a larger single GPU buffer than this browser allows.');
  }
  if (reasons.length) return { loadable: false, status: 'unsupported', label: 'Device limit', reasons, warnings };

  if (support.deviceMemoryGB && model.runtimeMemoryGB >= support.deviceMemoryGB) {
    warnings.push(`Estimated model memory is ${model.runtimeMemoryGB.toFixed(2)} GB; this browser reports about ${support.deviceMemoryGB} GB of device memory. Available GPU memory is lower and not measurable here.`);
  } else if (model.runtimeMemoryGB > 2) {
    warnings.push('This is a large model for a phone. The browser can run out of memory even when storage is available.');
  } else {
    warnings.push('WebGPU features match. Free GPU memory is not measurable; loading still depends on your device.');
  }
  if (!options.cached && support.storageQuota !== undefined && support.storageUsage !== undefined) {
    const freeStorage = Math.max(0, support.storageQuota - support.storageUsage);
    if (model.downloadGB * 1e9 > freeStorage) warnings.push('The estimated download is larger than the currently reported free browser storage. Free space or choose a smaller variant.');
  }
  return { loadable: true, status: model.runtimeMemoryGB > 2 || warnings.length > 1 || Boolean(support.deviceMemoryGB && model.runtimeMemoryGB >= support.deviceMemoryGB) ? 'caution' : 'ready', label: model.runtimeMemoryGB > 2 ? 'High memory' : 'Check memory', reasons, warnings };
}
