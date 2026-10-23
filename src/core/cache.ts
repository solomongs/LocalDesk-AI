import type { AppConfig } from '@mlc-ai/web-llm';
import { isCuratedMobileModel } from './catalog';

/** All mobile operations share this cache policy; never rely on an upstream default. */
export function createMobileAppConfig(prebuilt: AppConfig): AppConfig {
  return { ...prebuilt, cacheBackend: 'cache', model_list: prebuilt.model_list.filter(record => isCuratedMobileModel(record.model_id)) };
}

export interface CacheInspection { complete: boolean; missing: string[] }
type WeightChecker = (id: string, config: AppConfig) => Promise<boolean>;

/** Mirrors WebLLM's URL normalization for the curated Hugging Face MLC records. */
export function modelArtifactBase(model: string): string {
  const suffix = model.endsWith('/') ? model : `${model}/`;
  return new URL(/\/.+\/resolve\/.+\//.test(suffix) ? suffix : `${suffix}resolve/main/`).href;
}

/**
 * WebLLM hasModelInCache checks only tensor manifest + shards. Check the separate
 * config, tokenizer and WASM caches as well before displaying a downloaded badge.
 * Cache scope names are pinned to the shipped @mlc-ai/web-llm 0.2.86 runtime.
 * This checks existing local records only and never downloads missing artifacts.
 */
export async function inspectMobileCache(
  modelId: string,
  config: AppConfig,
  storage: CacheStorage | undefined = globalThis.caches,
  weights?: WeightChecker,
): Promise<CacheInspection> {
  if (config.cacheBackend !== 'cache' || !storage) return { complete: false, missing: ['Browser cache unavailable'] };
  const record = config.model_list.find(item => item.model_id === modelId);
  if (!record) return { complete: false, missing: ['Model runtime unavailable'] };
  try {
    const missing: string[] = [];
    const base = modelArtifactBase(record.model);
    const [modelCache, configCache, wasmCache] = await Promise.all([
      storage.open('webllm/model'), storage.open('webllm/config'), storage.open('webllm/wasm'),
    ]);
    const configResponse = await configCache.match(new URL('mlc-chat-config.json', base).href);
    if (!configResponse?.ok) missing.push('Model configuration');
    if (!(await wasmCache.match(record.model_lib))?.ok) missing.push('WASM runtime');
    if (record.model_manifest && !(await configCache.match(new URL(record.model_manifest, base).href))?.ok) missing.push('Model package manifest');
    if (configResponse?.ok) {
      const chatConfig = await configResponse.json() as { tokenizer_files?: unknown };
      const files = Array.isArray(chatConfig.tokenizer_files) ? chatConfig.tokenizer_files : [];
      const tokenizer = files.includes('tokenizer.json') ? 'tokenizer.json' : files.includes('tokenizer.model') ? 'tokenizer.model' : null;
      if (!tokenizer || !(await modelCache.match(new URL(tokenizer, base).href))?.ok) missing.push('Tokenizer');
    }
    const checkWeights = weights ?? (await import('@mlc-ai/web-llm')).hasModelInCache;
    if (!(await checkWeights(modelId, config))) missing.push('Model weights');
    return { complete: missing.length === 0, missing };
  } catch { return { complete: false, missing: ['Cached files could not be verified'] }; }
}
