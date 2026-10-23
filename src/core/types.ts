export type EngineKind = 'webllm' | 'native';
export type NativeEngineKind = 'ollama' | 'llamacpp';
export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  id?: string;
  role: MessageRole;
  content: string;
  createdAt?: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface NativeModel {
  id: string;
  name: string;
  size?: number;
  sizeBytes?: number;
  modifiedAt?: string;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  [key: string]: unknown;
}

export interface SystemStatus {
  os: string;
  arch: string;
  cpuName: string;
  cpuCores: number;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  totalDiskBytes: number;
  freeDiskBytes: number;
  gpus: Array<{ name: string; totalMemoryBytes: number | null; freeMemoryBytes: number | null; source: string }>;
  ollamaInstalled: boolean;
  llmfitInstalled: boolean;
}

export interface NativeStatus {
  engine: NativeEngineKind;
  connected: boolean;
  endpoint: string;
  version?: string;
  error?: string;
}

export interface BrowserSupport {
  supported: boolean;
  reason?: string;
  secureContext: boolean;
  webgpu: boolean;
  gpuName?: string;
  features: string[];
  maxStorageBufferBindingSize?: number;
  deviceMemoryGB?: number;
  storageUsage?: number;
  storageQuota?: number;
  persistentStorage?: boolean;
}

export type EnginePhase = 'idle' | 'checking' | 'loading' | 'downloading' | 'ready' | 'generating' | 'error';
export interface EngineState {
  currentEngine: EngineKind;
  nativeEngine: NativeEngineKind;
  selectedModel: string;
  loadedModel: string | null;
  phase: EnginePhase;
  statusText: string;
  downloadProgress: number | null;
  error: string | null;
  contextNotice: string | null;
  nativeModels: NativeModel[];
  nativeStatus: NativeStatus | null;
  cachedModels: string[];
  browserSupport: BrowserSupport | null;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  onToken?: (token: string, fullText: string) => void;
}

export interface CompletionResult {
  content: string;
  model: string;
}

export interface DownloadProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  percent: number | null;
}
