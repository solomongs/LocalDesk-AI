import mobileCatalog from './mobile-models.generated.json';

export interface ModelGuide {
  id: string;
  name: string;
  parameters: string;
  downloadGB: number;
  runtimeMemoryGB: number;
  category: 'Everyday' | 'Writing' | 'Study' | 'Coding' | 'Reasoning' | 'Math' | 'Translation' | 'Embeddings' | 'Vision';
  company?: string;
  companySource?: string;
  family?: string;
  quantization?: string;
  modelType?: 'chat' | 'vision' | 'embedding';
  chatLoadable?: boolean;
  downloadBytes?: number;
  downloadSource?: 'manifest' | 'estimated';
  downloadManifest?: string;
  downloadNote?: string;
  memorySource?: 'webllm';
  contextWindow?: number;
  requiredFeatures?: string[];
  bufferSizeRequiredBytes?: number;
  useCaseTags?: string[];
  summary: string;
  useCases: string[];
  limitations: string[];
  examplePrompt: string;
  exampleResponse: string;
  recommended?: boolean;
  advanced?: boolean;
  nativeId?: string;
  source: string;
}

/** Original small-model guides are also retained for the native Ollama catalog. */
const STARTER_MODEL_GUIDES: readonly ModelGuide[] = [
  {
    id: 'SmolLM2-360M-Instruct-q4f32_1-MLC', name: 'SmolLM2 360M', parameters: '360 million',
    downloadGB: 0.23, runtimeMemoryGB: 0.58, category: 'Everyday', recommended: true,
    summary: 'A small first model for quick, simple conversations and trying LocalLLM.',
    useCases: ['Short notes and rewrites', 'Simple questions', 'Brainstorming quick ideas'],
    limitations: ['Less reliable for factual questions and detailed reasoning.', 'Keep requests short. Check important answers.'],
    examplePrompt: 'Write a friendly reminder to bring a notebook tomorrow.',
    exampleResponse: 'Quick reminder: please bring your notebook tomorrow. See you then!',
    nativeId: 'smollm2:360m', source: 'https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', name: 'Llama 3.2 1B', parameters: '1 billion',
    downloadGB: 0.72, runtimeMemoryGB: 1.13, category: 'Writing',
    summary: 'A compact assistant for writing, summaries and everyday questions.',
    useCases: ['Rewrite an email', 'Summarize pasted text', 'Plan a simple task'],
    limitations: ['Needs more memory than SmolLM2.', 'Not a substitute for expert advice or a current web search.'],
    examplePrompt: 'Turn these notes into a polite email: meeting moved to Friday, 10am.',
    exampleResponse: 'Hello, our meeting has moved to Friday at 10:00 a.m. Please let me know if that works for you.',
    nativeId: 'llama3.2:1b', source: 'https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct',
  },
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', name: 'Qwen2.5 1.5B', parameters: '1.5 billion',
    downloadGB: 0.99, runtimeMemoryGB: 1.89, category: 'Study',
    summary: 'A multilingual model for explaining concepts, organizing notes and structured writing.',
    useCases: ['Explain a topic in simpler language', 'Make a study checklist', 'Draft multilingual text'],
    limitations: ['Math and factual claims still need checking.', 'Can exceed the memory available to a mobile browser.'],
    examplePrompt: 'Explain opportunity cost with a simple everyday example.',
    exampleResponse: 'Opportunity cost is what you give up when you choose. If you spend an hour gaming instead of studying, the missed study time is the opportunity cost.',
    nativeId: 'qwen2.5:1.5b', source: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct',
  },
  {
    id: 'Llama-3.2-3B-Instruct-q4f32_1-MLC', name: 'Llama 3.2 3B', parameters: '3 billion',
    downloadGB: 1.91, runtimeMemoryGB: 2.96, category: 'Everyday', advanced: true,
    summary: 'A larger general assistant for compatible devices with more available memory.',
    useCases: ['Longer drafts and summaries', 'Compare ideas', 'Step-by-step task planning'],
    limitations: ['Not recommended as a first download on a phone.', 'May run slowly or fail to load when the browser is short on memory.'],
    examplePrompt: 'Give me a three-step plan for organizing a small community event.',
    exampleResponse: '1. Agree on the goal, budget and date. 2. Confirm the venue, helpers and supplies. 3. Invite guests and check the final arrangements.',
    nativeId: 'llama3.2:3b', source: 'https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct',
  },
] as const;

/** Every prebuilt variant in the pinned WebLLM runtime; specialized types are listed but cannot be loaded into chat. */
export const MOBILE_MODELS: readonly ModelGuide[] = (mobileCatalog.models as ModelGuide[]).map(model => {
  const starter = STARTER_MODEL_GUIDES.find(guide => guide.id === model.id);
  return starter ? { ...model, summary: starter.summary, useCases: starter.useCases, limitations: [...starter.limitations, ...model.limitations], examplePrompt: starter.examplePrompt, exampleResponse: starter.exampleResponse, recommended: starter.recommended, nativeId: starter.nativeId } : model;
}).sort((a, b) => {
  const ai = STARTER_MODEL_GUIDES.findIndex(model => model.id === a.id);
  const bi = STARTER_MODEL_GUIDES.findIndex(model => model.id === b.id);
  if (ai !== -1 || bi !== -1) return ai === -1 ? 1 : bi === -1 ? -1 : ai - bi;
  return a.runtimeMemoryGB - b.runtimeMemoryGB || a.name.localeCompare(b.name);
});

export const MOBILE_CATALOG_VERSION = mobileCatalog.runtimeVersion;
export const MOBILE_CATALOG_SOURCE = mobileCatalog.source;

export const NATIVE_MODEL_GUIDES: readonly ModelGuide[] = [
  ...STARTER_MODEL_GUIDES,
  {
    id: 'qwen2.5-coder:3b', nativeId: 'qwen2.5-coder:3b', name: 'Qwen2.5 Coder 3B', parameters: '3 billion',
    downloadGB: 1.9, runtimeMemoryGB: 3.1, category: 'Coding',
    summary: 'A compact coding model for connecting your own editor or coding agent.',
    useCases: ['Explain code in your editor', 'Suggest functions through a coding agent', 'Help with small refactors'],
    limitations: ['Small models can struggle with large repositories and tool calls.', 'Review generated changes inside your chosen editor.'],
    examplePrompt: 'Explain the difference between a list and a set in Python.',
    exampleResponse: 'A list keeps item order and permits duplicates. A set stores unique items and is useful for membership checks.',
    source: 'https://ollama.com/library/qwen2.5-coder',
  },
  {
    id: 'qwen2.5-coder:7b', nativeId: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', parameters: '7 billion',
    downloadGB: 4.7, runtimeMemoryGB: 6.0, category: 'Coding',
    summary: 'A larger coding model for laptops with enough memory, especially a dedicated GPU.',
    useCases: ['Editor-assisted coding', 'Code explanation and review', 'Structured coding prompts'],
    limitations: ['Uses more memory and storage.', 'Editor tool support depends on that agent and the model.'],
    examplePrompt: 'Suggest a clear validation strategy for an email field.',
    exampleResponse: 'Validate the shape on the client, repeat validation on the server, normalize surrounding whitespace, and verify ownership using an email confirmation flow.',
    source: 'https://ollama.com/library/qwen2.5-coder',
  },
] as const;

export const MODEL_SIZE_NOTE = 'Download sizes cover model weights; tokenizer, runtime and other assets need additional storage. Working-memory estimates are not measured free device RAM. Context length, runtime, device, and quantization change actual requirements. Sample previews are illustrative, not a live response or a benchmark.';
export const LOCAL_LLM_EXPLANATION = 'LocalLLM is the name for local AI inside LocalDesk AI. On your phone, it uses the open-source WebLLM runtime to run a downloaded MLC model with WebGPU. On desktop, it connects to Ollama or llama.cpp on this computer. Your model generates answers locally; the first model download and optional remote MCP services still need internet.';

export function getModelGuide(id: string): ModelGuide | undefined {
  return MOBILE_MODELS.find(model => model.id === id) ?? NATIVE_MODEL_GUIDES.find(model => model.id === id || model.nativeId === id);
}

export function isCuratedMobileModel(id: string): boolean {
  return MOBILE_MODELS.some(model => model.id === id && model.chatLoadable !== false);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Not available';
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
