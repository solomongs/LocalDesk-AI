import { describe, it, expect, vi } from 'vitest';
import { isPWA, isNativeDesktop, detectEngine } from './environment';
import { MOBILE_MODELS, getModelGuide, formatBytes } from './catalog';
import { importMcpConfig, hasUnresolvedMcpVariables } from './mcp';
import { isConversation } from './storage';
import { EngineController } from './engine';
import { createMobileAppConfig, inspectMobileCache, modelArtifactBase } from './cache';
import { prepareMobilePrompt } from './budget';
import { setSetting } from './storage';
import type { NativeChatChunk, NativeTransport } from './native';

vi.mock('./storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage')>(),
  getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
  setSetting: vi.fn(async () => {}),
}));

describe('environment boundary', () => {
  it('uses browser LocalLLM in an ordinary tab as well as an installed PWA', () => {
    expect(isPWA({ window: {} })).toBe(true);
    expect(detectEngine({ window: {} })).toBe('webllm');
    expect(isNativeDesktop({ window: { __TAURI_INTERNALS__: {} } })).toBe(true);
    expect(detectEngine({ window: { __TAURI_INTERNALS__: {} } })).toBe('native');
  });
});

describe('mobile model guidance', () => {
  it('contains only named lightweight MLC models and distinguishes memory from download size', async () => {
    const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    for (const model of MOBILE_MODELS) {
      expect(prebuiltAppConfig.model_list.some(item => item.model_id === model.id), model.id).toBe(true);
      expect(model.runtimeMemoryGB).toBeGreaterThan(model.downloadGB);
      expect(model.useCases.length).toBeGreaterThan(0);
      expect(model.limitations.length).toBeGreaterThan(0);
    }
    expect(getModelGuide('llama3.2:1b')?.name).toBe('Llama 3.2 1B');
    expect(formatBytes(undefined)).toBe('Not available');
  });
});

describe('MCP profile import', () => {
  it('imports Claude/Cursor stdio configuration without executing or retaining literal secrets', () => {
    const result = importMcpConfig(JSON.stringify({ mcpServers: { demo: { command: 'npx', args: ['-y', 'example-server'], env: { API_KEY: 'secret-value', HOME_DIR: '${env:HOME}' } } } }));
    expect(result.servers[0]).toMatchObject({ source: 'Claude/Cursor', enabled: false, transport: 'stdio', command: 'npx' });
    expect(result.servers[0].env?.API_KEY).toBeUndefined();
    expect(result.servers[0].requiredSecretKeys).toContain('env.API_KEY');
    expect(hasUnresolvedMcpVariables(result.servers[0])).toBe(true);
  });
  it('imports VS Code remote and OpenCode local formats', () => {
    expect(importMcpConfig('{"servers":{"demo":{"type":"http","url":"https://example.com/mcp"}}}').servers[0].transport).toBe('streamable-http');
    expect(importMcpConfig('{"mcp":{"demo":{"type":"local","command":["node","server.mjs"]}}}').servers[0].args).toEqual(['server.mjs']);
  });
  it('rejects URL credentials and insecure remote HTTP servers', () => {
    expect(() => importMcpConfig('{"servers":{"demo":{"url":"https://user:password@example.com/mcp"}}}')).toThrow();
    expect(() => importMcpConfig('{"servers":{"demo":{"url":"http://example.com/mcp"}}}')).toThrow();
    const local = importMcpConfig('{"servers":{"demo":{"url":"http://127.0.0.1:8000/mcp?api_key=secret"}}}').servers[0];
    expect(local.url).not.toContain('secret');
    expect(local.requiredSecretKeys).toContain('url.api_key');
  });
  it('does not accept arbitrary root shapes or prototype names', () => {
    expect(() => importMcpConfig('[]')).toThrow();
    expect(() => importMcpConfig('{"mcpServers":{"__proto__":{"command":"node"}}}')).toThrow();
  });
  it('flags unresolved editor placeholders in command arguments and URLs', () => {
    const command = importMcpConfig('{"servers":{"demo":{"command":"node","args":["${workspaceFolder}/server.js"]}}}').servers[0];
    expect(hasUnresolvedMcpVariables(command)).toBe(true);
    const remote = importMcpConfig('{"servers":{"demo":{"url":"https://example.com/${input:tenant}/mcp"}}}').servers[0];
    expect(hasUnresolvedMcpVariables(remote)).toBe(true);
  });
  it('redacts credential-bearing CLI arguments before they can be persisted', () => {
    const result = importMcpConfig(JSON.stringify({ mcpServers: { demo: { command: 'node', args: [
      'server.mjs', '--api-key', 'super-secret', '--token=other-secret', '-H', 'Authorization: Bearer third-secret',
      'https://example.com/mcp?api_key=fourth-secret', '--max-tokens', '512',
    ] } } }));
    const server = result.servers[0];
    const serialized = JSON.stringify(server);
    for (const secret of ['super-secret', 'other-secret', 'third-secret', 'fourth-secret']) expect(serialized).not.toContain(secret);
    expect(server.args).toContain('--max-tokens');
    expect(server.args).toContain('512');
    expect(server.args?.[3]).toBe('--token=${input:CLI_SECRET_3}');
    expect(server.requiredSecretKeys).toContain('args.2');
    expect(hasUnresolvedMcpVariables(server)).toBe(true);
  });
});

describe('complete mobile cache inspection', () => {
  it('uses a shared Cache API policy and requires config, tokenizer and WASM in addition to weights', async () => {
    const { prebuiltAppConfig } = await import('@mlc-ai/web-llm');
    const config = createMobileAppConfig({ ...prebuiltAppConfig, cacheBackend: 'indexeddb' });
    expect(config.cacheBackend).toBe('cache');
    const model = config.model_list[0];
    const base = modelArtifactBase(model.model);
    const entries = new Map<string, Response>([
      [new URL('mlc-chat-config.json', base).href, Response.json({ tokenizer_files: ['tokenizer.json'] })],
      [new URL('tokenizer.json', base).href, Response.json({})],
    ]);
    const storage = { open: async () => ({ match: async (key: string) => entries.get(key)?.clone() }) } as unknown as CacheStorage;
    const weights = vi.fn(async () => true);
    expect((await inspectMobileCache(model.model_id, config, storage, weights)).missing).toContain('WASM runtime');
    entries.set(model.model_lib, new Response('wasm'));
    expect((await inspectMobileCache(model.model_id, config, storage, weights)).complete).toBe(true);
    expect(weights).toHaveBeenCalledWith(model.model_id, config);
  });
});

describe('mobile context budget', () => {
  it('preserves the system instruction and most recent user turn while dropping oldest complete turns', () => {
    const prompt = prepareMobilePrompt([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'x'.repeat(750) }, { role: 'assistant', content: 'y'.repeat(550) },
      { role: 'user', content: 'Explain this simply.' },
    ], 2048);
    expect(prompt.maxTokens).toBe(512);
    expect(prompt.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(prompt.messages.at(-1)?.content).toBe('Explain this simply.');
    expect(prompt.omittedMessages).toBe(2);
    expect(prompt.notice).toContain('complete chat remains saved');
    expect(prompt.conservativeInputTokens + prompt.maxTokens).toBeLessThanOrEqual(2048);
  });
  it('rejects an oversized latest prompt instead of cutting the user request silently', () => {
    expect(() => prepareMobilePrompt([{ role: 'user', content: '字'.repeat(700) }])).toThrow('too long');
  });
});

describe('conversation data', () => {
  it('accepts only valid local conversation shapes', () => {
    expect(isConversation({ id: 'x', title: 'Hi', updatedAt: 1, messages: [{ role: 'user', content: 'Hi' }] })).toBe(true);
    expect(isConversation({ id: 'x', title: 'Hi', updatedAt: 1, messages: [{ role: 'tool', content: 'unexpected' }] })).toBe(false);
  });
});

describe('native completion abstraction', () => {
  function mockTransport() {
    let listener: ((payload: NativeChatChunk) => void) | undefined;
    const unlisten = vi.fn();
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_native_status') return { engine: 'ollama', connected: true, endpoint: 'http://127.0.0.1:11434' };
      if (command === 'native_list_models') return [{ id: 'test-model', name: 'test-model', sizeBytes: 1 }];
      if (command === 'native_chat') {
        listener?.({ requestId: 'unrelated', content: 'ignored', done: false });
        listener?.({ requestId: args?.requestId as string, content: 'Hello', done: false });
        listener?.({ requestId: args?.requestId as string, content: ' locally', done: true });
        return { content: 'Hello locally', model: 'test-model' };
      }
      return null;
    });
    const transport: NativeTransport = {
      invoke: invoke as NativeTransport['invoke'],
      listen: async <T>(_event: string, callback: (payload: T) => void) => {
        listener = payload => callback(payload as T);
        return unlisten;
      },
    };
    return { transport, invoke, unlisten };
  }
  it('reads installed models through native commands, filters stream events, and releases the listener', async () => {
    const mock = mockTransport();
    const engine = new EngineController({ mode: 'native', nativeTransport: mock.transport });
    await engine.initialize();
    const onToken = vi.fn();
    const result = await engine.complete([{ role: 'user', content: 'Hello' }], { onToken });
    expect(result.content).toBe('Hello locally');
    expect(onToken.mock.calls).toEqual([['Hello', 'Hello'], [' locally', 'Hello locally']]);
    expect(mock.invoke).toHaveBeenCalledWith('native_list_models', { engine: 'ollama' });
    expect(mock.unlisten).toHaveBeenCalledOnce();
    expect(engine.getState().phase).toBe('ready');
  });
  it('does not dispatch a prompt when the caller already cancelled', async () => {
    const mock = mockTransport();
    const engine = new EngineController({ mode: 'native', nativeTransport: mock.transport });
    await engine.initialize();
    const abort = new AbortController(); abort.abort();
    await expect(engine.complete([{ role: 'user', content: 'Hello' }], { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.invoke.mock.calls.some(call => call[0] === 'native_chat')).toBe(false);
  });
  it('cancels an in-flight native request and releases its stream listener', async () => {
    const mock = mockTransport();
    const original = mock.transport.invoke;
    let started = false;
    mock.transport.invoke = (async (command, args) => {
      if (command === 'native_chat') { started = true; return new Promise(() => {}); }
      return original(command, args);
    }) as NativeTransport['invoke'];
    const engine = new EngineController({ mode: 'native', nativeTransport: mock.transport });
    await engine.initialize();
    const pending = engine.complete([{ role: 'user', content: 'Wait for cancellation' }]);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(engine.complete([{ role: 'user', content: 'Second request' }])).rejects.toThrow('Wait for the current operation');
    engine.stop();
    await rejected;
    expect(mock.invoke.mock.calls.some(call => call[0] === 'native_cancel')).toBe(true);
    expect(mock.unlisten).toHaveBeenCalledOnce();
    expect(engine.getState().phase).toBe('ready');
  });
  it('prevents a browser instance from selecting a native engine', async () => {
    const browser = new EngineController({ mode: 'webllm' });
    await expect(browser.setNativeEngine('ollama')).rejects.toThrow('only support LocalLLM');
    expect(() => browser.selectModel('arbitrary-model')).toThrow('mobile model library');
  });
  it('recovers from a native preference write failure without remaining stuck in checking', async () => {
    const mock = mockTransport();
    const engine = new EngineController({ mode: 'native', nativeTransport: mock.transport });
    await engine.initialize();
    vi.mocked(setSetting).mockRejectedValueOnce(new Error('Disk full'));
    await expect(engine.setNativeEngine('llamacpp')).rejects.toThrow('preference could not be saved');
    expect(engine.getState().phase).toBe('idle');
    expect(engine.getState().nativeEngine).toBe('llamacpp');
  });
});

describe('mobile worker cleanup', () => {
  function fixture(create: () => Promise<unknown>, unload: () => Promise<unknown> = async () => {}) {
    const engine = new EngineController({ mode: 'webllm' });
    const terminate = vi.fn();
    Object.assign(engine, {
      state: { ...engine.getState(), phase: 'ready', loadedModel: MOBILE_MODELS[0].id },
      browserEngine: { chat: { completions: { create } }, interruptGenerate: vi.fn(), unload },
      worker: { terminate }, workerFailure: new Promise(() => {}),
    });
    return { engine, terminate };
  }
  it('reuses the already loaded mobile model instead of allocating a second runtime', async () => {
    const { engine, terminate } = fixture(async () => {});
    await expect(engine.loadModel(MOBILE_MODELS[0].id)).resolves.toBeUndefined();
    expect(engine.getState()).toMatchObject({ phase: 'ready', loadedModel: MOBILE_MODELS[0].id });
    expect(terminate).not.toHaveBeenCalled();
  });
  it('terminates a worker when cancelled during unresolved prefill', async () => {
    const create = vi.fn(() => new Promise(() => {}));
    const { engine, terminate } = fixture(create);
    const pending = engine.complete([{ role: 'user', content: 'Hello' }]);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    engine.stop();
    await rejection;
    expect(terminate).toHaveBeenCalledOnce();
    expect(engine.getState()).toMatchObject({ phase: 'idle', loadedModel: null });
  });
  it('terminates after a stalled iterator cleanup instead of marking the model ready', async () => {
    vi.useFakeTimers();
    try {
      const next = vi.fn(() => new Promise(() => {}));
      const iterator = { next, return: vi.fn(() => new Promise(() => {})) };
      const create = async () => ({ [Symbol.asyncIterator]: () => iterator });
      const { engine, terminate } = fixture(create);
      const pending = engine.complete([{ role: 'user', content: 'Hello' }]);
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      engine.stop();
      await vi.advanceTimersByTimeAsync(1501);
      await rejection;
      expect(terminate).toHaveBeenCalledOnce();
      expect(engine.getState()).toMatchObject({ phase: 'idle', loadedModel: null });
    } finally { vi.useRealTimers(); }
  });
  it('bounds unloading and clears a nonresponsive worker', async () => {
    vi.useFakeTimers();
    try {
      const { engine, terminate } = fixture(async () => {}, () => new Promise(() => {}));
      const unloading = engine.unloadModel();
      await vi.advanceTimersByTimeAsync(3001);
      await unloading;
      expect(terminate).toHaveBeenCalledOnce();
      expect(engine.getState()).toMatchObject({ phase: 'idle', loadedModel: null });
    } finally { vi.useRealTimers(); }
  });
});
