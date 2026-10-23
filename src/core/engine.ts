import type { AppConfig, WebWorkerMLCEngine } from '@mlc-ai/web-llm';
import { MOBILE_MODELS, isCuratedMobileModel } from './catalog';
import { createMobileAppConfig, inspectMobileCache } from './cache';
import { prepareMobilePrompt } from './budget';
import { checkBrowserSupport, detectEngine, requestPersistentStorage } from './environment';
import { nativeTransport, type NativeChatChunk, type NativeTransport, type Unlisten } from './native';
import { getSetting, setSetting } from './storage';
import type { ChatMessage, CompletionOptions, CompletionResult, EngineKind, EngineState, NativeEngineKind, NativeModel, NativeStatus } from './types';

function abortError(): DOMException { return new DOMException('Generation stopped.', 'AbortError'); }
function messageFor(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export interface EngineDependencies {
  /** Injection for native unit tests; the production singleton always auto-detects its environment. */
  mode?: EngineKind;
  nativeTransport?: NativeTransport;
}

export class EngineController {
  private state: EngineState;
  private listeners = new Set<() => void>();
  private transport: NativeTransport;
  private browserEngine: WebWorkerMLCEngine | null = null;
  private appConfig: AppConfig | null = null;
  private worker: Worker | null = null;
  private workerFailure: Promise<never> | null = null;
  private activeAbort: AbortController | null = null;
  private loadEpoch = 0;
  private initialization: Promise<void> | null = null;
  private workerCrashed = false;

  constructor(dependencies: EngineDependencies = {}) {
    const currentEngine = dependencies.mode ?? detectEngine();
    this.transport = dependencies.nativeTransport ?? nativeTransport;
    this.state = {
      currentEngine, nativeEngine: 'ollama', selectedModel: currentEngine === 'webllm' ? MOBILE_MODELS[0].id : '',
      loadedModel: null, phase: 'idle', statusText: 'Choose a model to get started.', downloadProgress: null,
      error: null, contextNotice: null, nativeModels: [], nativeStatus: null, cachedModels: [], browserSupport: null,
    };
  }

  getSnapshot = (): EngineState => this.state;
  getState = (): EngineState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(change: Partial<EngineState>): void {
    this.state = { ...this.state, ...change };
    this.listeners.forEach(listener => listener());
  }
  private ensureIdle(): void {
    if (['checking', 'loading', 'downloading', 'generating'].includes(this.state.phase)) throw new Error('Wait for the current operation to finish, or stop it first.');
  }

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.ensureIdle();
    this.initialization = this.initializeInternal();
    try { await this.initialization; } finally { this.initialization = null; }
  }

  private async initializeInternal(): Promise<void> {
    this.update({ phase: 'checking', error: null, statusText: 'Checking your device…' });
    try {
      const savedEngine = await getSetting<string>('nativeEngine', 'ollama');
      if (savedEngine === 'llamacpp' && this.state.currentEngine === 'native') this.update({ nativeEngine: savedEngine });
      const key = this.state.currentEngine === 'native' ? `model:${this.state.nativeEngine}` : 'model:webllm';
      const saved = await getSetting<string>(key, this.state.selectedModel);
      if (typeof saved === 'string' && (this.state.currentEngine === 'native' || isCuratedMobileModel(saved))) this.update({ selectedModel: saved });
    } catch { /* A storage problem must not prevent the hardware check or hide a usable model. */ }
    if (this.state.currentEngine === 'native') await this.fetchNativeModels();
    else {
      const browserSupport = await checkBrowserSupport();
      this.update({ browserSupport, phase: browserSupport.supported ? 'idle' : 'error',
        statusText: browserSupport.supported ? 'Choose a model, preview its capabilities, then download it.' : 'LocalLLM is unavailable on this browser.',
        error: browserSupport.supported ? null : browserSupport.reason ?? 'WebGPU is unavailable.' });
      if (browserSupport.supported) await this.refreshCache();
    }
  }

  async setNativeEngine(nativeEngine: NativeEngineKind): Promise<void> {
    if (this.state.currentEngine !== 'native') throw new Error('Mobile and browser apps only support LocalLLM through WebLLM.');
    this.ensureIdle();
    this.update({ nativeEngine, selectedModel: '', loadedModel: null, nativeModels: [], nativeStatus: null, phase: 'checking', error: null });
    let persistenceError: unknown;
    try {
      await setSetting('nativeEngine', nativeEngine);
      const selected = await getSetting<string>(`model:${nativeEngine}`, '');
      if (typeof selected === 'string') this.update({ selectedModel: selected });
    } catch (error) { persistenceError = error; }
    await this.fetchNativeModels();
    if (persistenceError) throw new Error(`The engine changed for this session, but its preference could not be saved: ${messageFor(persistenceError)}`);
  }

  selectModel(model: string): void {
    this.ensureIdle();
    if (this.state.currentEngine === 'webllm' && !isCuratedMobileModel(model)) throw new Error('Choose a model from the mobile model library.');
    if (this.state.currentEngine === 'native' && !this.state.nativeModels.some(m => m.id === model || m.name === model)) throw new Error('This model is not installed in the selected native engine.');
    this.update({ selectedModel: model, loadedModel: this.state.loadedModel === model ? model : null, phase: this.state.loadedModel === model ? 'ready' : 'idle', error: null });
    void setSetting(this.state.currentEngine === 'native' ? `model:${this.state.nativeEngine}` : 'model:webllm', model).catch(() => {});
  }

  async refreshModels(): Promise<NativeModel[]> {
    if (this.state.currentEngine !== 'native') return [];
    this.ensureIdle();
    return this.fetchNativeModels();
  }

  private async fetchNativeModels(): Promise<NativeModel[]> {
    const engine = this.state.nativeEngine;
    this.update({ phase: 'checking', error: null, statusText: `Connecting to ${engine === 'ollama' ? 'Ollama' : 'llama.cpp'}…` });
    try {
      const status = await this.transport.invoke<NativeStatus>('get_native_status', { engine });
      if (engine !== this.state.nativeEngine) return [];
      if (!status.connected) {
        this.update({ nativeStatus: status, nativeModels: [], loadedModel: null, phase: 'idle', statusText: status.error || 'Start your local engine to continue.' });
        return [];
      }
      const models = await this.transport.invoke<NativeModel[]>('native_list_models', { engine });
      if (engine !== this.state.nativeEngine) return [];
      const selected = models.some(m => m.id === this.state.selectedModel || m.name === this.state.selectedModel)
        ? this.state.selectedModel : models[0]?.id || models[0]?.name || '';
      this.update({ nativeStatus: status, nativeModels: models, selectedModel: selected, loadedModel: null, phase: 'idle',
        statusText: models.length ? 'Local engine connected. Choose a model to chat.' : 'Connected. Download a model in the Ollama manager.' });
      return models;
    } catch (error) {
      this.update({ nativeModels: [], loadedModel: null, phase: 'error', error: messageFor(error), statusText: 'Could not connect to the local engine.' });
      return [];
    }
  }

  async refreshCache(): Promise<string[]> {
    if (this.state.currentEngine !== 'webllm') return [];
    const epoch = this.loadEpoch;
    const webllm = await import('@mlc-ai/web-llm');
    const config = this.appConfig ?? createMobileAppConfig(webllm.prebuiltAppConfig);
    const cached = await Promise.all(MOBILE_MODELS.map(async model => {
      return (await inspectMobileCache(model.id, config, globalThis.caches, webllm.hasModelInCache)).complete ? model.id : null;
    }));
    const cachedModels = cached.filter((id): id is string => Boolean(id));
    if (epoch !== this.loadEpoch) return this.state.cachedModels;
    this.update({ cachedModels });
    return cachedModels;
  }

  private async ensureBrowserEngine(epoch: number): Promise<WebWorkerMLCEngine> {
    if (this.browserEngine) return this.browserEngine;
    const webllm = await import('@mlc-ai/web-llm');
    if (epoch !== this.loadEpoch) throw abortError();
    this.appConfig = createMobileAppConfig(webllm.prebuiltAppConfig);
    if (!this.appConfig.model_list.some(record => record.model_id === this.state.selectedModel)) {
      throw new Error('This app version does not include that model runtime. Choose another model or update LocalDesk AI.');
    }
    const worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module', name: 'localdesk-local-llm' });
    this.worker = worker;
    this.workerCrashed = false;
    this.workerFailure = new Promise<never>((_resolve, reject) => {
      const fail = (message: string) => {
        if (this.worker !== worker) return;
        this.workerCrashed = true;
        reject(new Error(message));
        if (this.state.phase === 'ready' || this.state.phase === 'idle') {
          this.destroyWorker();
          this.update({ loadedModel: null, phase: 'error', error: message, statusText: 'Reload your model to continue.' });
        }
      };
      worker.addEventListener('error', event => fail(event.message || 'The LocalLLM worker stopped. Reload the model and try again.'));
      worker.addEventListener('messageerror', () => fail('The LocalLLM worker returned an invalid message.'));
    });
    void this.workerFailure.catch(() => {});
    this.browserEngine = new webllm.WebWorkerMLCEngine(worker, {
      appConfig: this.appConfig,
      initProgressCallback: report => {
        if (epoch !== this.loadEpoch) return;
        const progress = Number.isFinite(report.progress) ? Math.round(Math.min(1, Math.max(0, report.progress)) * 100) : 0;
        this.update({ phase: progress < 100 ? 'downloading' : 'loading', downloadProgress: progress, statusText: report.text || 'Preparing your model…' });
      },
    });
    return this.browserEngine;
  }

  async loadModel(model = this.state.selectedModel): Promise<void> {
    this.ensureIdle();
    if (!model) throw new Error('Choose an installed model first.');
    if (this.state.currentEngine === 'webllm' && this.state.phase === 'ready' &&
        this.state.loadedModel === model && this.state.selectedModel === model &&
        this.browserEngine && !this.workerCrashed) return;
    if (model !== this.state.selectedModel) this.selectModel(model);
    if (this.state.currentEngine === 'native') {
      if (!this.state.nativeModels.some(item => item.id === model || item.name === model)) throw new Error('This model is not installed in the selected engine.');
      this.update({ loadedModel: model, phase: 'ready', error: null, statusText: 'Ready. Your local engine loads the model when you send a message.' });
      return;
    }
    if (!isCuratedMobileModel(model)) throw new Error('This model is not in the mobile library.');
    const epoch = ++this.loadEpoch;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.update({ phase: 'loading', loadedModel: null, error: null, downloadProgress: 0, statusText: 'Preparing LocalLLM…' });
    try {
      const support = this.state.browserSupport ?? await checkBrowserSupport();
      if (abort.signal.aborted || epoch !== this.loadEpoch) throw abortError();
      this.update({ browserSupport: support });
      if (!support.supported) throw new Error(support.reason || 'WebGPU is unavailable.');
      const engine = await this.ensureBrowserEngine(epoch);
      if (abort.signal.aborted || epoch !== this.loadEpoch) throw abortError();
      engine.setInitProgressCallback(report => {
        if (epoch !== this.loadEpoch) return;
        const progress = Number.isFinite(report.progress) ? Math.round(Math.min(1, Math.max(0, report.progress)) * 100) : 0;
        this.update({ phase: progress < 100 ? 'downloading' : 'loading', downloadProgress: progress, statusText: report.text || 'Preparing your model…' });
      });
      const record = this.appConfig?.model_list.find(item => item.model_id === model);
      const missing = record?.required_features?.filter(feature => !support.features.includes(feature)) ?? [];
      if (missing.length) throw new Error(`Your graphics adapter does not support this model's required feature: ${missing.join(', ')}.`);
      if (record?.buffer_size_required_bytes && support.maxStorageBufferBindingSize && record.buffer_size_required_bytes > support.maxStorageBufferBindingSize) {
        throw new Error('This model needs a larger GPU buffer than this browser provides. Choose a smaller model.');
      }
      const aborted = new Promise<never>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(abortError()), { once: true }));
      await Promise.race([engine.reload(model, { context_window_size: 2048 }), aborted, this.workerFailure!]);
      if (abort.signal.aborted || epoch !== this.loadEpoch) throw abortError();
      await requestPersistentStorage();
      if (abort.signal.aborted || epoch !== this.loadEpoch) throw abortError();
      const cache = await inspectMobileCache(model, this.appConfig!);
      if (abort.signal.aborted || epoch !== this.loadEpoch) throw abortError();
      this.update({ loadedModel: model, phase: 'ready', downloadProgress: 100, error: null,
        statusText: cache.complete ? 'Offline ready. This model is loaded on your device.' : 'Ready for this session. Some files were not retained; reload online before relying on offline use.',
        cachedModels: cache.complete ? Array.from(new Set([...this.state.cachedModels, model])) : this.state.cachedModels.filter(id => id !== model) });
    } catch (error) {
      if (epoch === this.loadEpoch) {
        this.update({ phase: abort.signal.aborted ? 'idle' : 'error', error: abort.signal.aborted ? null : messageFor(error),
          loadedModel: null, statusText: abort.signal.aborted ? 'Download stopped. Cached files may be reused next time.' : 'Could not load this model. Try a smaller model or reload the app.' });
        this.destroyWorker();
      }
      throw error;
    } finally { if (this.activeAbort === abort) this.activeAbort = null; }
  }

  stop(): void {
    this.activeAbort?.abort();
    if (this.state.phase === 'generating') this.browserEngine?.interruptGenerate();
    else if (this.state.currentEngine === 'webllm' && ['loading', 'downloading'].includes(this.state.phase)) {
      this.destroyWorker();
    }
  }

  private destroyWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerFailure = null;
    this.browserEngine = null;
    this.appConfig = null;
    this.workerCrashed = false;
  }

  async unloadModel(): Promise<void> {
    this.ensureIdle();
    if (this.browserEngine) {
      this.update({ phase: 'loading', statusText: 'Unloading your model…' });
      try {
        await bounded(Promise.race([
          this.browserEngine.unload(),
          this.workerFailure!,
        ]), 3000, 'Unloading timed out.');
      } catch { this.destroyWorker(); }
    }
    this.update({ loadedModel: null, phase: 'idle', error: null, downloadProgress: null, statusText: 'Model unloaded. Cached files remain on this device.' });
  }

  async removeCachedModel(model: string): Promise<void> {
    if (this.state.currentEngine !== 'webllm' || !isCuratedMobileModel(model)) throw new Error('Choose a mobile model to remove.');
    this.ensureIdle();
    if (this.state.loadedModel === model) await this.unloadModel();
    const webllm = await import('@mlc-ai/web-llm');
    await webllm.deleteModelAllInfoInCache(model, this.appConfig ?? createMobileAppConfig(webllm.prebuiltAppConfig));
    this.update({ cachedModels: this.state.cachedModels.filter(id => id !== model), statusText: 'Cached model removed from this browser.' });
  }

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<CompletionResult> {
    this.ensureIdle();
    if (!messages.length || messages.some(message => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw new Error('A valid conversation is required.');
    if (!this.state.selectedModel) throw new Error('Choose a model first.');
    if (this.state.currentEngine === 'webllm' && (!this.browserEngine || this.state.loadedModel !== this.state.selectedModel)) throw new Error('Download and load your selected model before chatting.');
    if (options.signal?.aborted) throw abortError();
    const mobilePrompt = this.state.currentEngine === 'webllm' ? prepareMobilePrompt(messages, options.maxTokens) : null;
    const requestMessages = mobilePrompt?.messages ?? messages;
    const abort = new AbortController();
    const forwardAbort = () => abort.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.activeAbort = abort;
    this.update({ phase: 'generating', error: null, contextNotice: mobilePrompt?.notice ?? null, statusText: 'Thinking on your device…' });
    const temperature = Number.isFinite(options.temperature) ? Math.min(2, Math.max(0, options.temperature!)) : 0.7;
    const maxTokens = mobilePrompt?.maxTokens ?? (Number.isFinite(options.maxTokens) ? Math.min(8192, Math.max(16, Math.round(options.maxTokens!))) : 512);
    try {
      const result = this.state.currentEngine === 'native'
        ? await this.completeNative(requestMessages, { ...options, temperature, maxTokens, signal: abort.signal })
        : await this.completeBrowser(requestMessages, { ...options, temperature, maxTokens, signal: abort.signal });
      this.update({ phase: 'ready', loadedModel: this.state.selectedModel, statusText: 'Ready. Your conversation stays on this device.' });
      return result;
    } catch (error) {
      if (this.state.currentEngine === 'webllm' && this.workerCrashed) {
        this.destroyWorker();
        this.update({ loadedModel: null });
      }
      if (abort.signal.aborted) {
        const needsReload = this.state.currentEngine === 'webllm' && !this.browserEngine;
        this.update({ phase: needsReload ? 'idle' : 'ready', statusText: needsReload ? 'Generation stopped. Reload your model to continue.' : 'Generation stopped.', error: null });
      }
      else this.update({ phase: 'error', statusText: 'Could not finish this response.', error: messageFor(error) });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private async completeNative(messages: ChatMessage[], options: CompletionOptions): Promise<CompletionResult> {
    const requestId = crypto.randomUUID();
    let text = '';
    let streamError: string | undefined;
    const unlisten: Unlisten = await this.transport.listen<NativeChatChunk>('native-chat-chunk', payload => {
      if (payload.requestId !== requestId || options.signal?.aborted) return;
      if (payload.error) streamError = payload.error;
      if (payload.content) { text += payload.content; options.onToken?.(payload.content, text); }
    });
    const onAbort = () => { void this.transport.invoke('native_cancel', { requestId }).catch(() => {}); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (options.signal?.aborted) throw abortError();
      const aborted = new Promise<never>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
      const result = await Promise.race([this.transport.invoke<CompletionResult>('native_chat', {
        requestId, engine: this.state.nativeEngine, model: this.state.selectedModel,
        messages: messages.map(({ role, content }) => ({ role, content })), temperature: options.temperature, maxTokens: options.maxTokens,
      }), aborted]);
      if (options.signal?.aborted) throw abortError();
      if (streamError) throw new Error(streamError);
      if (result.content !== text) options.onToken?.(result.content.startsWith(text) ? result.content.slice(text.length) : '', result.content);
      return result;
    } finally { unlisten(); options.signal?.removeEventListener('abort', onAbort); }
  }

  private async completeBrowser(messages: ChatMessage[], options: CompletionOptions): Promise<CompletionResult> {
    const engine = this.browserEngine!;
    const onAbort = () => engine.interruptGenerate();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const aborted = new Promise<never>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(abortError()), { once: true }));
    let text = '';
    let iterator: AsyncIterator<import('@mlc-ai/web-llm').ChatCompletionChunk> | undefined;
    const workerFailure = this.workerFailure!;
    try {
      const stream = await Promise.race([engine.chat.completions.create({
        model: this.state.selectedModel, messages: messages.map(({ role, content }) => ({ role, content })),
        stream: true, temperature: options.temperature, max_tokens: options.maxTokens,
      }), aborted, workerFailure]);
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), aborted, workerFailure]);
        if (next.done) break;
        if (options.signal?.aborted) throw abortError();
        const token = next.value.choices[0]?.delta.content ?? '';
        if (token) { text += token; options.onToken?.(token, text); }
      }
      return { content: text, model: this.state.selectedModel };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (iterator?.return) {
        let released = false;
        try {
          released = await bounded(iterator.return().then(() => true), 1500, 'The generation did not stop in time.');
        } catch { /* A failed worker cannot release a stream. */ }
        if (!released) {
          this.destroyWorker();
          this.update({ loadedModel: null });
          if (!options.signal?.aborted) throw new Error('The model worker stopped responding. Reload your model to continue.');
        }
      } else if (options.signal?.aborted) {
        // Cancellation during prefill may happen before the iterator is created.
        this.destroyWorker();
        this.update({ loadedModel: null });
      }
    }
  }

  async getAICompletion(prompt: string, options: CompletionOptions = {}): Promise<string> {
    return (await this.complete([{ role: 'user', content: prompt }], options)).content;
  }
  dispose(): void { this.stop(); this.loadEpoch++; this.destroyWorker(); this.listeners.clear(); }
}

export const engineController = new EngineController();
export const getAICompletion = (prompt: string, options?: CompletionOptions): Promise<string> => engineController.getAICompletion(prompt, options);
