import { isNativeDesktop } from './environment';
import type { ChatMessage, CompletionResult, DownloadProgress, NativeEngineKind, NativeModel, NativeStatus, SystemStatus } from './types';

export interface NativeChatChunk { requestId: string; content: string; done: boolean; error?: string }
export type Unlisten = () => void;
export interface NativeTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, callback: (payload: T) => void): Promise<Unlisten>;
}

export const nativeTransport: NativeTransport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!isNativeDesktop()) throw new Error('This action is available in the desktop app only. Mobile uses LocalLLM in this browser.');
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  },
  async listen<T>(event: string, callback: (payload: T) => void): Promise<Unlisten> {
    if (!isNativeDesktop()) throw new Error('Desktop events are unavailable in the browser.');
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, value => callback(value.payload));
  },
};

export const getSystemStatus = (): Promise<SystemStatus> => nativeTransport.invoke('get_system_status');
export const getNativeStatus = (engine: NativeEngineKind): Promise<NativeStatus> => nativeTransport.invoke('get_native_status', { engine });
export const getNativeModels = (engine: NativeEngineKind): Promise<NativeModel[]> => nativeTransport.invoke('native_list_models', { engine });
export const startOllama = (): Promise<unknown> => nativeTransport.invoke('start_ollama');
export const deleteOllamaModel = (model: string): Promise<void> => nativeTransport.invoke('delete_ollama_model', { model });

export async function pullOllamaModel(model: string, onProgress: (progress: DownloadProgress) => void): Promise<unknown> {
  const unlisten = await nativeTransport.listen<DownloadProgress>('model-download-progress', value => {
    if (value.model === model) onProgress(value);
  });
  try { return await nativeTransport.invoke('pull_ollama_model', { model }); } finally { unlisten(); }
}

export interface FitRecommendations {
  available: boolean;
  source: 'llmfit';
  recommendations: unknown;
  error?: string;
}
export const getFitRecommendations = (useCase = 'chat'): Promise<FitRecommendations> =>
  nativeTransport.invoke('get_fit_recommendations', { useCase });

export interface NativeCompletionRequest {
  requestId: string;
  engine: NativeEngineKind;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}
export const requestNativeCompletion = (request: NativeCompletionRequest): Promise<CompletionResult> =>
  nativeTransport.invoke('native_chat', { ...request });
