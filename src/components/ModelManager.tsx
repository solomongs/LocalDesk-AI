import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronRight, CircleHelp, Cpu, HardDrive, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { engineController, MOBILE_MODELS, NATIVE_MODEL_GUIDES, MODEL_SIZE_NOTE, formatBytes, getFitRecommendations, pullOllamaModel, deleteOllamaModel, startOllama, nativeTransport, type DownloadProgress, type ModelGuide, type FitRecommendations } from '../core';
import { useEngine } from '../core/useEngine';
import { getMobileModelCompatibility } from '../core/compatibility';
import './models.css';

type Props = { onNotify: (message: string) => void };
type FitRow = { name: string; fit?: string; score?: number; quant?: string; memory?: number; tps?: number };
const messageFor = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const textField = (value: Record<string, unknown>, keys: string[]) => keys.map(key => value[key]).find(item => typeof item === 'string') as string | undefined;
const numberField = (value: Record<string, unknown>, keys: string[]) => keys.map(key => value[key]).find(item => typeof item === 'number' && Number.isFinite(item)) as number | undefined;

function normalizeFits(payload: unknown): FitRow[] {
  const root = record(payload);
  const list = Array.isArray(payload) ? payload : root ? [root.models, root.recommendations, root.items, root.ranked_models].find(Array.isArray) : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap(value => {
    const row = record(value);
    if (!row) return [];
    const model = record(row.model);
    const name = textField(row, ['name', 'model_name', 'model', 'id']) ?? (model ? textField(model, ['name', 'id']) : undefined);
    if (!name) return [];
    return [{ name, fit: textField(row, ['fit_level', 'fit', 'fitLevel']), score: numberField(row, ['score', 'total_score']), quant: textField(row, ['best_quant', 'quantization', 'quant']), memory: numberField(row, ['memory_required_gb', 'estimated_memory_gb', 'memory_gb', 'required_memory_gb']), tps: numberField(row, ['estimated_tps', 'tps', 'tokens_per_second']) }];
  });
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { if (dialog?.open) dialog.close(); }; }, []);
  return <dialog className="modal models-modal" ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="models-modal-header"><h2>{title}</h2><button className="models-icon-btn" type="button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></header>{children}
  </dialog>;
}

type MobileLibraryProps = {
  locked: boolean;
  onPreview: (guide: ModelGuide) => void;
  onChoose: (id: string) => void;
  onRemove: (guide: ModelGuide) => void;
};
type MobileGuide = ModelGuide & {
  company?: string; family?: string; quantization?: string; modelType?: 'chat' | 'vision' | 'embedding';
  chatLoadable?: boolean; downloadSource?: 'manifest' | 'estimated'; memorySource?: string;
  contextWindow?: number; requiredFeatures?: string[]; bufferSizeRequiredBytes?: number; useCaseTags?: string[];
};
type Compatibility = { label: string; detail: string; blocked: boolean; tone: 'neutral' | 'warning' | 'blocked' };
const companyOf = (guide: MobileGuide) => guide.company || 'Other';
const familyOf = (guide: MobileGuide) => guide.family || guide.name;
const usesOf = (guide: MobileGuide) => guide.useCaseTags?.length ? guide.useCaseTags : [guide.category];
const sizeLabel = (gb: number) => gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb.toFixed(gb < 10 ? 2 : 1).replace(/\.?0+$/, '')} GB`;
const memoryGroup = (gb: number) => gb <= 1 ? 'Up to 1 GB memory' : gb <= 2 ? '1–2 GB memory' : gb <= 4 ? '2–4 GB memory' : gb <= 8 ? '4–8 GB memory' : 'Over 8 GB memory';
function compatibilityFor(guide: MobileGuide, support: ReturnType<typeof useEngine>['browserSupport'], cached = false): Compatibility {
  const result = getMobileModelCompatibility(guide, support, {cached});
  return {
    label: result.label, detail: [...result.reasons, ...result.warnings].join(' '), blocked: !result.loadable,
    tone: result.status === 'caution' ? 'warning' : result.loadable || guide.chatLoadable === false ? 'neutral' : 'blocked',
  };
}

function MobilePreviewDetails({guide}: {guide: MobileGuide}) {
  const engine = useEngine();
  const compatibility = compatibilityFor(guide, engine.browserSupport, engine.cachedModels.includes(guide.id));
  return <>
    <dl className="mobile-preview-details">
      <div><dt>Company</dt><dd>{companyOf(guide)}</dd></div>
      <div><dt>Variant</dt><dd>{guide.quantization || guide.id}</dd></div>
      {guide.contextWindow ? <div><dt>Catalog context</dt><dd>{guide.contextWindow.toLocaleString()} tokens</dd></div> : null}
      <div className="mobile-preview-id"><dt>Model ID</dt><dd>{guide.id}</dd></div>
    </dl>
    <div className={`mobile-preview-compatibility ${compatibility.tone}`}><CircleHelp size={18}/><div><strong>{compatibility.label}</strong><p>{compatibility.detail}</p></div></div>
    <p className="mobile-preview-storage">Download size covers model weights. Tokenizer, WebLLM runtime and other files need extra space. Working memory is the catalog estimate and is separate from storage; the app uses a smaller chat context where possible.</p>
    <a className="models-doc-link" href={guide.source} target="_blank" rel="noreferrer">View model source ↗</a>
  </>;
}

function MobileModelLibrary({ locked, onPreview, onChoose, onRemove }: MobileLibraryProps) {
  const engine = useEngine();
  const models = MOBILE_MODELS as readonly MobileGuide[];
  const [query, setQuery] = useState('');
  const [company, setCompany] = useState('all');
  const [useCase, setUseCase] = useState('all');
  const [memory, setMemory] = useState('all');
  const [download, setDownload] = useState('all');
  const [onlyCached, setOnlyCached] = useState(false);
  const [groupBy, setGroupBy] = useState('company');
  const [sortBy, setSortBy] = useState('recommended');
  const [visibleCount, setVisibleCount] = useState(12);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const companies = useMemo(() => [...new Set(models.map(companyOf))].sort(), [models]);
  const useCases = useMemo(() => [...new Set(models.flatMap(usesOf))].sort(), [models]);
  const allFamilies = useMemo(() => new Set(models.map(guide => `${companyOf(guide)}:${familyOf(guide)}`)).size, [models]);
  useEffect(() => { setVisibleCount(12); }, [query, company, useCase, memory, download, onlyCached, groupBy, sortBy]);
  const filtered = useMemo(() => models.filter(guide => {
    const text = [guide.name, guide.id, companyOf(guide), familyOf(guide), guide.quantization, guide.parameters, guide.summary, ...guide.useCases, ...usesOf(guide)].filter(Boolean).join(' ').toLowerCase();
    return (!query.trim() || query.trim().toLowerCase().split(/\s+/).every(term => text.includes(term))) &&
      (company === 'all' || companyOf(guide) === company) && (useCase === 'all' || usesOf(guide).includes(useCase)) &&
      (memory === 'all' || guide.runtimeMemoryGB <= Number(memory)) && (download === 'all' || guide.downloadGB <= Number(download)) &&
      (!onlyCached || engine.cachedModels.includes(guide.id));
  }), [models, query, company, useCase, memory, download, onlyCached, engine.cachedModels]);
  const families = useMemo(() => {
    const map = new Map<string, MobileGuide[]>();
    for (const guide of filtered) {
      const key = `${companyOf(guide)}:${familyOf(guide)}`;
      map.set(key, [...map.get(key) || [], guide]);
    }
    return [...map].map(([key, variants]) => {
      variants.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.runtimeMemoryGB - b.runtimeMemoryGB || a.id.localeCompare(b.id));
      const guide = variants.find(model => model.id === selectedVariants[key]) || variants.find(model => model.id === engine.selectedModel) || variants.find(model => engine.cachedModels.includes(model.id)) || variants.find(model => getMobileModelCompatibility(model, engine.browserSupport).loadable) || variants[0];
      return { key, variants, guide };
    }).sort((a, b) => sortBy === 'memory' ? a.guide.runtimeMemoryGB - b.guide.runtimeMemoryGB : sortBy === 'download' ? a.guide.downloadGB - b.guide.downloadGB : sortBy === 'name' ? familyOf(a.guide).localeCompare(familyOf(b.guide)) : Number(Boolean(b.guide.recommended)) - Number(Boolean(a.guide.recommended)) || Number(a.guide.chatLoadable === false) - Number(b.guide.chatLoadable === false) || a.guide.runtimeMemoryGB - b.guide.runtimeMemoryGB);
  }, [filtered, selectedVariants, engine.selectedModel, engine.cachedModels, engine.browserSupport, sortBy]);
  const groups = useMemo(() => {
    const map = new Map<string, typeof families>();
    for (const item of families.slice(0, visibleCount)) {
      const title = groupBy === 'company' ? companyOf(item.guide) : groupBy === 'use' ? useCase !== 'all' && usesOf(item.guide).includes(useCase) ? useCase : usesOf(item.guide)[0] : groupBy === 'memory' ? memoryGroup(item.guide.runtimeMemoryGB) : familyOf(item.guide);
      map.set(title, [...map.get(title) || [], item]);
    }
    return [...map];
  }, [families, visibleCount, groupBy, useCase]);
  const activeFilters = Boolean(query || company !== 'all' || useCase !== 'all' || memory !== 'all' || download !== 'all' || onlyCached);
  const clearFilters = () => { setQuery(''); setCompany('all'); setUseCase('all'); setMemory('all'); setDownload('all'); setOnlyCached(false); };
  const availableStorage = engine.browserSupport?.storageQuota !== undefined && engine.browserSupport?.storageUsage !== undefined ? Math.max(0, engine.browserSupport.storageQuota - engine.browserSupport.storageUsage) : undefined;

  return <section className="models-section mobile-library" aria-labelledby="mobile-library-title">
    <div className="models-section-line"><div><p className="eyebrow">THE COMPLETE WEBLLM LIBRARY</p><h2 id="mobile-library-title">Find the right model for your phone.</h2><p>Browse {allFamilies} model families and {models.length} variants. Start small, then compare capabilities before downloading.</p></div></div>
    <div className="mobile-library-help"><CircleHelp size={17}/><p>All models in this app’s WebLLM catalog are listed. Large and specialized models may not run on your phone. <strong>Download size</strong> uses storage; <strong>working memory</strong> is used while the model runs.</p></div>
    <div className="mobile-library-filters card">
      <label className="models-search"><Search size={18}/><input aria-label="Search all mobile models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search company, model, task or variant…"/></label>
      <div className="mobile-library-filter-grid">
        <label>Company<select value={company} onChange={event => setCompany(event.target.value)}><option value="all">All companies</option>{companies.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Use case<select value={useCase} onChange={event => setUseCase(event.target.value)}><option value="all">All use cases</option>{useCases.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Working memory budget<select value={memory} onChange={event => setMemory(event.target.value)}><option value="all">Any memory size</option>{[1, 2, 4, 8, 16, 32].map(value => <option key={value} value={value}>Up to {value} GB</option>)}</select></label>
        <label>Max model download<select value={download} onChange={event => setDownload(event.target.value)}><option value="all">Any download size</option><option value="0.5">Up to 500 MB</option>{[1, 2, 4, 8, 16, 32].map(value => <option key={value} value={value}>Up to {value} GB</option>)}</select></label>
        <label>Group by<select value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="company">Company</option><option value="use">Use case</option><option value="memory">Working memory</option><option value="family">Model family</option></select></label>
        <label>Sort models<select value={sortBy} onChange={event => setSortBy(event.target.value)}><option value="recommended">Recommended, then smaller</option><option value="memory">Lowest working memory</option><option value="download">Smallest download</option><option value="name">Name A–Z</option></select></label>
      </div>
      <div className="mobile-library-filter-footer"><label className="mobile-library-check"><input type="checkbox" checked={onlyCached} onChange={event => setOnlyCached(event.target.checked)}/>Downloaded on this device</label>{activeFilters && <button className="mobile-library-clear" onClick={clearFilters}><X size={14}/>Clear filters</button>}</div>
      <p className="mobile-library-budget-note">Memory filters use model estimates, not a measurement of free RAM. Variants change precision and context size. Download filters cover model weights; runtime and tokenizer files need extra storage. {availableStorage !== undefined ? `About ${formatBytes(availableStorage)} remains in this browser’s storage allowance.` : 'Browser storage allowance may be unavailable.'}</p>
    </div>
    <div className="mobile-library-results" role="status" aria-live="polite"><strong>{families.length} {families.length === 1 ? 'family' : 'families'} · {filtered.length} {filtered.length === 1 ? 'variant' : 'variants'}</strong><span>{families.length ? `Showing ${Math.min(visibleCount, families.length)} families` : 'Try a broader search or budget'}</span></div>
    {groups.map(([title, items]) => <section className="mobile-library-group" aria-label={title} key={title}><header><h3>{title}</h3><span>{items.length} {items.length === 1 ? 'family' : 'families'}</span></header><div className="models-grid">{items.map(({key, variants, guide}) => {
      const cached = engine.cachedModels.includes(guide.id);
      const compatibility = compatibilityFor(guide, engine.browserSupport, cached);
      return <article className="models-guide card mobile-model-card" key={key}>
        <div className="models-guide-top"><span className="mobile-model-company">{companyOf(guide)}</span>{cached ? <span className="badge"><Check size={12}/>Downloaded</span> : guide.recommended ? <span className="badge">Start here</span> : <span className="muted models-category">{guide.modelType === 'embedding' ? 'Embedding' : guide.modelType === 'vision' ? 'Vision' : usesOf(guide)[0]}</span>}</div>
        <h4>{familyOf(guide)}</h4><p className="models-parameter">{guide.parameters} parameters · {variants.length} {variants.length === 1 ? 'matching variant' : 'matching variants'}</p>
        <p className="models-summary">{guide.summary}</p><div className="mobile-model-use-tags">{usesOf(guide).slice(0, 3).map(use => <span key={use}>{use}</span>)}</div>
        <label className="mobile-model-variant">Model variant<select aria-label={`Variant for ${familyOf(guide)}`} value={guide.id} onChange={event => setSelectedVariants(current => ({...current,[key]:event.target.value}))}>{variants.map(model => <option key={model.id} value={model.id}>{model.quantization || model.id}{model.contextWindow ? ` · ${model.contextWindow.toLocaleString()} context` : ''} · {sizeLabel(model.runtimeMemoryGB)} RAM</option>)}</select></label>
        <div className="mobile-model-sizes"><div><HardDrive size={16}/><span><strong>≈ {sizeLabel(guide.downloadGB)}</strong><small>{guide.downloadSource === 'manifest' ? 'Model weights' : 'Estimated weights'}</small></span></div><div><Cpu size={16}/><span><strong>≈ {sizeLabel(guide.runtimeMemoryGB)}</strong><small>Working memory</small></span></div></div>
        <div className={`mobile-model-compatibility ${compatibility.tone}`}><CircleHelp size={14}/><span>{compatibility.label}</span></div>
        <button className="btn btn-secondary models-preview-btn" onClick={() => onPreview(guide)}>Preview details & requirements<ChevronRight size={15}/></button>
        {cached && <div className="models-cached-actions"><button className="btn btn-primary" disabled={locked || compatibility.blocked} onClick={() => onChoose(guide.id)}><Play size={14}/>{engine.loadedModel === guide.id ? 'Use loaded model' : 'Load model'}</button><button className="models-icon-btn danger" disabled={locked} aria-label={`Remove ${guide.name}`} onClick={() => onRemove(guide)}><Trash2 size={16}/></button></div>}
      </article>;
    })}</div></section>)}
    {!families.length && <div className="mobile-library-empty card"><Search size={28}/><h3>No models match these filters.</h3><p>Try another company or use case, increase your budget, or search a shorter model name.</p><button className="btn btn-secondary" onClick={clearFilters}>Show all models</button></div>}
    {families.length > visibleCount && <button className="btn btn-secondary mobile-library-more" onClick={() => setVisibleCount(count => count + 12)}>Show 12 more families <span>({families.length - visibleCount} remaining)</span></button>}
    <p className="models-estimate-note"><CircleHelp size={15}/>{MODEL_SIZE_NOTE}</p>
  </section>;
}

export default function ModelManager({ onNotify }: Props) {
  const engine = useEngine();
  const mobile = engine.currentEngine === 'webllm';
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [preview, setPreview] = useState<ModelGuide | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitResult, setFitResult] = useState<FitRecommendations | null>(null);
  const [fitBusy, setFitBusy] = useState(false);
  const [fitUseCase, setFitUseCase] = useState('chat');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const locked = Boolean(busy) || ['loading', 'downloading', 'generating'].includes(engine.phase);
  const guides = mobile ? MOBILE_MODELS : NATIVE_MODEL_GUIDES;
  const filteredGuides = useMemo(() => guides.filter(guide => (category === 'All' || guide.category === category) && `${guide.name} ${guide.summary} ${guide.useCases.join(' ')}`.toLowerCase().includes(search.toLowerCase())), [guides, search, category]);
  const installed = new Set(engine.nativeModels.flatMap(model => [model.id, model.name]));
  const fitRows = useMemo(() => normalizeFits(fitResult?.recommendations), [fitResult]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name); setError(null);
    try { await fn(); } catch (failure) { const message = messageFor(failure); if (alive.current) setError(message); onNotify(message); }
    finally { if (alive.current) setBusy(null); }
  }

  async function openOfficialDownload(url: string) {
    await run('open-download', async () => { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); });
  }

  async function download(guide: ModelGuide) {
    setPreview(null);
    if (mobile) {
      await run(guide.id, () => engineController.loadModel(guide.id));
      return;
    }
    if (engine.nativeEngine !== 'ollama') { setError('Switch to Ollama to download these models. Manage llama.cpp model files in your llama.cpp installation.'); return; }
    const id = guide.nativeId;
    if (!id) { setError('No Ollama model name is available for this guide.'); return; }
    await run(id, async () => {
      setProgress({ model: id, status: 'Starting download…', percent: 0, completed: 0, total: 0 });
      try {
        await pullOllamaModel(id, update => { if (alive.current) setProgress(update); });
        await engineController.refreshModels();
        onNotify(`${guide.name} is downloaded. Select it when you are ready to chat.`);
      } finally { if (alive.current) setProgress(null); }
    });
  }

  async function choose(id: string) {
    await run(id, async () => { engineController.selectModel(id); await engineController.loadModel(id); onNotify('Model selected. You can return to Chat.'); });
  }

  async function removeModel() {
    if (!deleting) return;
    const model = deleting;
    setDeleting(null);
    await run(model.id, async () => {
      if (mobile) await engineController.removeCachedModel(model.id);
      else { await deleteOllamaModel(model.id); await engineController.refreshModels(); }
      onNotify(`${model.name} was removed. Your conversations are unchanged.`);
    });
  }

  async function refreshFits() {
    setFitBusy(true); setError(null);
    try { const result = await getFitRecommendations(fitUseCase); if (alive.current) setFitResult(result); }
    catch (failure) { if (alive.current) setError(messageFor(failure)); }
    finally { if (alive.current) setFitBusy(false); }
  }

  const percent = progress && typeof progress.percent === 'number' && Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : mobile ? engine.downloadProgress : null;
  const showProgress = progress !== null || (mobile && ['loading', 'downloading'].includes(engine.phase));
  const availableMobile = engine.browserSupport?.supported !== false;

  return <section className="panel models-panel">
    <header className="panel-header"><div><p className="eyebrow">YOUR LOCAL AI LIBRARY</p><h1>Find a model that fits.</h1><p className="muted">Preview what a model is useful for before using your storage or data.</p></div><button className="btn btn-secondary" disabled={locked} onClick={() => void run('refresh', () => mobile ? engineController.refreshCache() : engineController.refreshModels())}><RefreshCw size={16} />Refresh</button></header>

    <div className="models-engine-line card"><span className="models-engine-symbol"><Cpu size={21} /></span><div><strong>{mobile ? 'LocalLLM · on this device' : engine.nativeEngine === 'ollama' ? 'Ollama · on this computer' : 'llama.cpp · on this computer'}</strong><p className="muted">{mobile ? 'WebLLM runs compatible models inside this browser. No desktop server is used.' : engine.nativeStatus?.connected ? engine.nativeStatus.endpoint : engine.nativeStatus?.error ?? 'Connect to your local engine to see installed models.'}</p></div><span className={`badge ${mobile ? availableMobile ? '' : 'danger' : engine.nativeStatus?.connected ? '' : 'models-badge-offline'}`}>{mobile ? engine.browserSupport?.supported ? 'WebGPU ready' : engine.browserSupport ? 'Not compatible' : 'Checking device' : engine.nativeStatus?.connected ? 'Connected' : 'Offline'}</span></div>

    {!mobile && <div className="models-runtime-controls"><div className="field"><label htmlFor="native-runtime">Desktop runtime</label><select id="native-runtime" value={engine.nativeEngine} disabled={locked} onChange={event => void run('runtime', () => engineController.setNativeEngine(event.target.value as 'ollama' | 'llamacpp'))}><option value="ollama">Ollama — model downloads & management</option><option value="llamacpp">llama.cpp — your existing local server</option></select></div>{engine.nativeEngine === 'ollama' && !engine.nativeStatus?.connected && <button className="btn btn-secondary" disabled={locked} onClick={() => void run('start-ollama', async () => { const result = await startOllama(); onNotify(typeof result === 'string' ? result : 'Ollama startup requested.'); await engineController.refreshModels(); })}><Play size={15} />Start Ollama</button>}{engine.nativeEngine === 'ollama' && !engine.nativeStatus?.connected && <button className="btn btn-secondary" disabled={locked} onClick={() => void openOfficialDownload('https://ollama.com/download')}><ArrowDownToLine size={15} />Get Ollama</button>}</div>}

    {(error || (mobile && engine.error)) && <div role="alert" className="notice danger">{error || engine.error}</div>}

    {showProgress && <div className="models-download card" role="status" aria-live="polite"><div className="models-section-line"><strong><LoaderCircle className="models-spin" size={17} />{progress ? 'Downloading with Ollama' : 'Preparing LocalLLM'}</strong><button className="btn btn-secondary" onClick={() => { if (mobile) engineController.stop(); else if (progress) void nativeTransport.invoke('cancel_ollama_pull', { model: progress.model }).catch(failure => setError(messageFor(failure))); }}>Stop</button></div><p>{progress?.status ?? engine.statusText}</p><progress max={100} value={percent === null ? undefined : percent} aria-label="Model download progress" /><div className="models-download-meta"><span>{percent !== null ? `${Math.round(percent)}%` : 'Working…'}</span>{progress && progress.total > 0 && <span>{formatBytes(progress.completed)} of {formatBytes(progress.total)}</span>}</div></div>}

    {!mobile && <section className="models-section"><div className="models-section-line"><h2>Installed on this computer</h2><span className="muted">{engine.nativeModels.length} {engine.nativeModels.length === 1 ? 'model' : 'models'}</span></div>{engine.nativeModels.length ? <div className="models-installed-list">{engine.nativeModels.map(model => <div className="models-installed card" key={model.id}><div className="models-installed-info"><strong>{model.name}</strong><p className="muted">{[model.parameterSize, model.quantization, model.sizeBytes !== undefined || model.size !== undefined ? formatBytes(model.sizeBytes ?? model.size) : null].filter(Boolean).join(' · ') || 'Installed local model'}</p></div>{engine.selectedModel === model.id && <span className="badge"><Check size={12} />Selected</span>}<button className="btn btn-secondary" disabled={locked} onClick={() => void choose(model.id)}><Play size={14} />Use model</button>{engine.nativeEngine === 'ollama' && <button className="models-icon-btn danger" disabled={locked} title={`Remove ${model.name}`} aria-label={`Remove ${model.name}`} onClick={() => setDeleting({ id: model.id, name: model.name })}><Trash2 size={17} /></button>}</div>)}</div> : <div className="notice">{engine.nativeStatus?.connected ? 'No models are installed yet. Open a model preview below and choose Download.' : 'Start your local runtime, then refresh. The model guide below is available before installation.'}</div>}</section>}

    {!mobile && <section className="models-fit-section card"><div className="models-section-line"><div><p className="eyebrow">LLMFIT HARDWARE CHECK</p><h2>Personal recommendations</h2></div><Sparkles size={23} /></div><p className="muted">Check your actual computer with llmfit. Its fit and speed scores are estimates, not a benchmark or guarantee.</p><div className="models-fit-controls"><div className="field"><label htmlFor="fit-use-case">What will you use it for?</label><select id="fit-use-case" value={fitUseCase} disabled={fitBusy} onChange={event => setFitUseCase(event.target.value)}><option value="chat">Everyday chat</option><option value="coding">Coding with your editor</option><option value="reasoning">Reasoning and planning</option><option value="general">General assistance</option></select></div><button className="btn btn-secondary" disabled={fitBusy || locked} onClick={() => void refreshFits()}>{fitBusy ? <LoaderCircle size={16} className="models-spin" /> : <Cpu size={16} />}{fitBusy ? 'Checking hardware…' : 'Find my best fits'}</button></div>
      {fitResult && !fitResult.available && <div className="notice"><strong>llmfit is not available yet.</strong><p>{fitResult.error || 'Install the official tool to enable hardware-based recommendations.'} You can still explore the model guides below.</p><button className="models-doc-link" disabled={locked} onClick={() => void openOfficialDownload('https://github.com/AlexsJones/llmfit/releases')}>Official llmfit downloads ↗</button></div>}
      {fitResult?.available && (fitRows.length ? <div className="models-fit-results">{fitRows.map((fit, index) => <article className="models-fit-row" key={`${fit.name}-${index}`}><div><strong>{fit.name}</strong><p className="muted">{[fit.quant, fit.memory !== undefined ? `Estimated memory ${fit.memory.toFixed(1)} GB` : null, fit.tps !== undefined ? `Estimated ${fit.tps.toFixed(1)} tokens/sec` : null].filter(Boolean).join(' · ') || 'Hardware-based estimate at a 4K context limit'}</p></div><div className="models-fit-tags">{fit.fit && <span className="badge">{fit.fit.replaceAll('_', ' ')}</span>}{fit.score !== undefined && <span className="muted">Score {fit.score.toFixed(1)}</span>}</div></article>)}</div> : <div className="notice">llmfit completed but did not return a supported recommendation list for this filter. Try General assistance, or use the model guides below.</div>)}
    </section>}

    {mobile && <MobileModelLibrary locked={locked} onPreview={setPreview} onChoose={id => void choose(id)} onRemove={guide => setDeleting({id:guide.id,name:guide.name})}/>}
    {!mobile && <section className="models-section"><div className="models-section-line"><div><h2>{mobile ? 'Choose your first model' : 'Explore model guides'}</h2><p className="muted">{mobile ? 'Start small. You can try a larger model later if your device has enough memory.' : engine.nativeEngine === 'ollama' ? 'These guides include an Ollama download option.' : 'Guide sizes are approximate. Model-file installation is managed in llama.cpp.'}</p></div></div><div className="models-filters"><label className="models-search"><Search size={17} /><input aria-label="Search model guides" value={search} placeholder="Search models or use cases" onChange={event => setSearch(event.target.value)} /></label><div className="models-categories" aria-label="Filter by use case">{['All', 'Everyday', 'Writing', 'Study', ...(mobile ? [] : ['Coding'])].map(value => <button type="button" aria-pressed={category === value} className={category === value ? 'models-chip selected' : 'models-chip'} key={value} onClick={() => setCategory(value)}>{value}</button>)}</div></div>
      <div className="models-grid">{filteredGuides.map(guide => { const id = mobile ? guide.id : guide.nativeId ?? guide.id; const cached = mobile ? engine.cachedModels.includes(guide.id) : installed.has(id); return <article className="models-guide card" key={id}><div className="models-guide-top"><span className="models-guide-icon"><Sparkles size={20} /></span>{cached ? <span className="badge"><Check size={12} />Downloaded</span> : guide.recommended ? <span className="badge">Start here</span> : guide.advanced ? <span className="badge models-badge-offline">Advanced</span> : <span className="muted models-category">{guide.category}</span>}</div><h3>{guide.name}</h3><p className="models-parameter">{guide.parameters} parameters</p><p className="models-summary">{guide.summary}</p><div className="models-size-line"><span><HardDrive size={14} />≈ {guide.downloadGB} GB download</span><span><Cpu size={14} />≈ {guide.runtimeMemoryGB} GB memory</span></div><button className="btn btn-secondary models-preview-btn" onClick={() => setPreview(guide)}>Preview capabilities<ChevronRight size={15} /></button>{mobile && cached && <div className="models-cached-actions"><button className="btn btn-primary" disabled={locked || !availableMobile} onClick={() => void choose(guide.id)}><Play size={14} />{engine.loadedModel === guide.id ? 'Use loaded model' : 'Load model'}</button><button className="models-icon-btn danger" disabled={locked} aria-label={`Remove ${guide.name}`} onClick={() => setDeleting({ id: guide.id, name: guide.name })}><Trash2 size={16} /></button></div>}</article>; })}</div>{filteredGuides.length === 0 && <div className="notice">No model guides match your search.</div>}<p className="models-estimate-note"><CircleHelp size={15} />{MODEL_SIZE_NOTE}</p>
    </section>}
    {preview && <Modal title={preview.name} onClose={() => setPreview(null)}><div className="models-modal-body"><p className="muted">{preview.summary}</p>{mobile && <MobilePreviewDetails guide={preview as MobileGuide}/>}<div className="models-preview-stats"><span><HardDrive size={19} /><strong>≈ {sizeLabel(preview.downloadGB)}</strong><small>{mobile ? 'Model weights download' : 'Estimated download'}</small></span><span><Cpu size={19} /><strong>≈ {sizeLabel(preview.runtimeMemoryGB)}</strong><small>Estimated working memory</small></span><span><Sparkles size={19} /><strong>{preview.parameters}</strong><small>Model parameters</small></span></div><div className="models-preview-columns"><section><h3>Good for</h3><ul>{preview.useCases.map(item => <li key={item}><Check size={15} />{item}</li>)}</ul></section><section><h3>Know its limits</h3><ul>{preview.limitations.map(item => <li key={item}><CircleHelp size={15} />{item}</li>)}</ul></section></div><section className="models-example"><div><ShieldCheck size={16} /><strong>Illustrative capability preview</strong></div><p className="muted">This written example explains a possible use case. It is not a live response, performance test, or quality guarantee.</p><p className="models-example-prompt">{preview.examplePrompt}</p><p className="models-example-response">{preview.exampleResponse}</p></section><p className="models-estimate-note">Model files download once, then run locally. Internet is needed for the initial download. Memory needs increase with longer conversations.</p></div><footer className="models-modal-footer"><button className="btn btn-secondary" onClick={() => setPreview(null)}>Back to models</button>{mobile ? <button className="btn btn-primary" disabled={locked || compatibilityFor(preview as MobileGuide, engine.browserSupport).blocked} onClick={() => void download(preview)}>{engine.cachedModels.includes(preview.id) ? <Play size={16} /> : <ArrowDownToLine size={16} />}{(preview as MobileGuide).chatLoadable === false ? 'Browse only — chat unavailable' : engine.cachedModels.includes(preview.id) ? 'Load on this device' : 'Download & load'}</button> : engine.nativeEngine === 'ollama' && <button className="btn btn-primary" disabled={locked || !engine.nativeStatus?.connected} onClick={() => { const id = preview.nativeId ?? preview.id; if (installed.has(id)) { setPreview(null); void choose(id); } else void download(preview); }}><ArrowDownToLine size={16} />{installed.has(preview.nativeId ?? preview.id) ? 'Use installed model' : 'Download with Ollama'}</button>}</footer></Modal>}

    {deleting && <Modal title={`Remove ${deleting.name}?`} onClose={() => setDeleting(null)}><div className="models-modal-body"><p>This removes the downloaded model from {mobile ? 'this browser' : 'Ollama on this computer'} and frees its storage. You will need to download it again to use it.</p><p className="muted">Your conversations and saved settings will remain.</p></div><footer className="models-modal-footer"><button autoFocus className="btn btn-secondary" onClick={() => setDeleting(null)}>Keep model</button><button className="btn models-delete-btn" onClick={() => void removeModel()}><Trash2 size={16} />Remove model</button></footer></Modal>}
  </section>;
}
