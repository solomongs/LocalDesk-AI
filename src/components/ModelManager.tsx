import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronRight, CircleHelp, Cpu, HardDrive, LoaderCircle, Play, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { engineController, MOBILE_MODELS, NATIVE_MODEL_GUIDES, MODEL_SIZE_NOTE, formatBytes, getFitRecommendations, pullOllamaModel, deleteOllamaModel, startOllama, nativeTransport, type DownloadProgress, type ModelGuide, type FitRecommendations } from '../core';
import { useEngine } from '../core/useEngine';
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

    <section className="models-section"><div className="models-section-line"><div><h2>{mobile ? 'Choose your first model' : 'Explore model guides'}</h2><p className="muted">{mobile ? 'Start small. You can try a larger model later if your device has enough memory.' : engine.nativeEngine === 'ollama' ? 'These guides include an Ollama download option.' : 'Guide sizes are approximate. Model-file installation is managed in llama.cpp.'}</p></div></div><div className="models-filters"><label className="models-search"><Search size={17} /><input aria-label="Search model guides" value={search} placeholder="Search models or use cases" onChange={event => setSearch(event.target.value)} /></label><div className="models-categories" aria-label="Filter by use case">{['All', 'Everyday', 'Writing', 'Study', ...(mobile ? [] : ['Coding'])].map(value => <button type="button" aria-pressed={category === value} className={category === value ? 'models-chip selected' : 'models-chip'} key={value} onClick={() => setCategory(value)}>{value}</button>)}</div></div>
      <div className="models-grid">{filteredGuides.map(guide => { const id = mobile ? guide.id : guide.nativeId ?? guide.id; const cached = mobile ? engine.cachedModels.includes(guide.id) : installed.has(id); return <article className="models-guide card" key={id}><div className="models-guide-top"><span className="models-guide-icon"><Sparkles size={20} /></span>{cached ? <span className="badge"><Check size={12} />Downloaded</span> : guide.recommended ? <span className="badge">Start here</span> : guide.advanced ? <span className="badge models-badge-offline">Advanced</span> : <span className="muted models-category">{guide.category}</span>}</div><h3>{guide.name}</h3><p className="models-parameter">{guide.parameters} parameters</p><p className="models-summary">{guide.summary}</p><div className="models-size-line"><span><HardDrive size={14} />≈ {guide.downloadGB} GB download</span><span><Cpu size={14} />≈ {guide.runtimeMemoryGB} GB memory</span></div><button className="btn btn-secondary models-preview-btn" onClick={() => setPreview(guide)}>Preview capabilities<ChevronRight size={15} /></button>{mobile && cached && <div className="models-cached-actions"><button className="btn btn-primary" disabled={locked || !availableMobile} onClick={() => void choose(guide.id)}><Play size={14} />{engine.loadedModel === guide.id ? 'Use loaded model' : 'Load model'}</button><button className="models-icon-btn danger" disabled={locked} aria-label={`Remove ${guide.name}`} onClick={() => setDeleting({ id: guide.id, name: guide.name })}><Trash2 size={16} /></button></div>}</article>; })}</div>{filteredGuides.length === 0 && <div className="notice">No model guides match your search.</div>}<p className="models-estimate-note"><CircleHelp size={15} />{MODEL_SIZE_NOTE}</p>
    </section>

    {preview && <Modal title={preview.name} onClose={() => setPreview(null)}><div className="models-modal-body"><p className="muted">{preview.summary}</p><div className="models-preview-stats"><span><HardDrive size={19} /><strong>≈ {preview.downloadGB} GB</strong><small>Estimated download</small></span><span><Cpu size={19} /><strong>≈ {preview.runtimeMemoryGB} GB</strong><small>Estimated working memory</small></span><span><Sparkles size={19} /><strong>{preview.parameters}</strong><small>Model parameters</small></span></div><div className="models-preview-columns"><section><h3>Good for</h3><ul>{preview.useCases.map(item => <li key={item}><Check size={15} />{item}</li>)}</ul></section><section><h3>Know its limits</h3><ul>{preview.limitations.map(item => <li key={item}><CircleHelp size={15} />{item}</li>)}</ul></section></div><section className="models-example"><div><ShieldCheck size={16} /><strong>Illustrative capability preview</strong></div><p className="muted">This written example explains a possible use case. It is not a live response, performance test, or quality guarantee.</p><p className="models-example-prompt">{preview.examplePrompt}</p><p className="models-example-response">{preview.exampleResponse}</p></section><p className="models-estimate-note">Model files download once, then run locally. Internet is needed for the initial download. Memory needs increase with longer conversations.</p></div><footer className="models-modal-footer"><button className="btn btn-secondary" onClick={() => setPreview(null)}>Back to models</button>{mobile ? <button className="btn btn-primary" disabled={locked || !availableMobile} onClick={() => void download(preview)}>{engine.cachedModels.includes(preview.id) ? <Play size={16} /> : <ArrowDownToLine size={16} />}{engine.cachedModels.includes(preview.id) ? 'Load on this device' : 'Download & load'}</button> : engine.nativeEngine === 'ollama' && <button className="btn btn-primary" disabled={locked || !engine.nativeStatus?.connected} onClick={() => { const id = preview.nativeId ?? preview.id; if (installed.has(id)) { setPreview(null); void choose(id); } else void download(preview); }}><ArrowDownToLine size={16} />{installed.has(preview.nativeId ?? preview.id) ? 'Use installed model' : 'Download with Ollama'}</button>}</footer></Modal>}

    {deleting && <Modal title={`Remove ${deleting.name}?`} onClose={() => setDeleting(null)}><div className="models-modal-body"><p>This removes the downloaded model from {mobile ? 'this browser' : 'Ollama on this computer'} and frees its storage. You will need to download it again to use it.</p><p className="muted">Your conversations and saved settings will remain.</p></div><footer className="models-modal-footer"><button autoFocus className="btn btn-secondary" onClick={() => setDeleting(null)}>Keep model</button><button className="btn models-delete-btn" onClick={() => void removeModel()}><Trash2 size={16} />Remove model</button></footer></Modal>}
  </section>;
}
