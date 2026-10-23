import { useEffect, useState } from 'react';
import { Check, CircleAlert, Cpu, Database, Gauge, HardDrive, Laptop, LoaderCircle, RefreshCw, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { checkBrowserSupport, formatBytes, getSystemStatus, type BrowserSupport, type SystemStatus } from '../core';
import { useEngine } from '../core/useEngine';
import './models.css';

type Props = { onNotify: (message: string) => void };
const messageFor = (error: unknown) => error instanceof Error ? error.message : String(error);
function UsageBar({ used, total, label }: { used: number; total: number; label: string }) {
  const percent = total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
  return <div className="models-usage"><div><span>{label}</span><span>{total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : 'Not reported'}</span></div><progress value={percent} max={100} aria-label={label} /></div>;
}

export default function SystemPanel({ onNotify }: Props) {
  const engine = useEngine();
  const mobile = engine.currentEngine === 'webllm';
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [browser, setBrowser] = useState<BrowserSupport | null>(engine.browserSupport);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      if (mobile) setBrowser(await checkBrowserSupport());
      else setSystem(await getSystemStatus());
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (failure) { const message = messageFor(failure); setError(message); onNotify(message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [mobile]);
  useEffect(() => { if (engine.browserSupport) setBrowser(engine.browserSupport); }, [engine.browserSupport]);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);

  const support = browser ?? engine.browserSupport;
  return <section className="panel models-panel system-panel">
    <header className="panel-header"><div><p className="eyebrow">DEVICE & ENGINE</p><h1>System status</h1><p className="muted">Understand what this device can run, with real information where available.</p></div><button className="btn btn-secondary" disabled={loading} onClick={() => void refresh()}>{loading ? <LoaderCircle className="models-spin" size={16} /> : <RefreshCw size={16} />}Refresh</button></header>
    {error && <div className="notice danger" role="alert">{error}</div>}
    <div className="system-status-banner card"><span className="models-engine-symbol">{mobile ? <Laptop size={23} /> : <Cpu size={23} />}</span><div><strong>{mobile ? 'LocalLLM in your browser' : 'Native desktop engine'}</strong><p className="muted">{mobile ? 'This device runs its own downloaded model with WebGPU.' : 'LocalDesk connects to Ollama or llama.cpp on this computer.'}</p></div><span className="badge">{mobile ? 'WebLLM' : engine.nativeEngine === 'ollama' ? 'Ollama' : 'llama.cpp'}</span></div>
    <div className="system-grid">
      <article className="card system-card"><header><Gauge size={19} /><h2>Engine</h2></header><dl><div><dt>Connection</dt><dd>{mobile ? support ? support.supported ? 'WebGPU available' : 'WebGPU unavailable' : 'Checking…' : engine.nativeStatus?.connected ? 'Connected' : 'Not connected'}</dd></div><div><dt>Model state</dt><dd>{engine.phase}</dd></div><div><dt>Selected model</dt><dd className="system-wrap-text">{engine.selectedModel || 'None selected'}</dd></div><div><dt>Loaded model</dt><dd className="system-wrap-text">{engine.loadedModel || 'None loaded'}</dd></div>{!mobile && <div><dt>Endpoint</dt><dd>{engine.nativeStatus?.endpoint || (engine.nativeEngine === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8080')}</dd></div>}</dl><p className="system-footnote">{engine.statusText}</p></article>
      <article className="card system-card"><header>{online ? <Wifi size={19} /> : <WifiOff size={19} />}<h2>Connection & privacy</h2></header><dl><div><dt>Internet</dt><dd>{online ? 'Browser reports online' : 'Browser reports offline'}</dd></div><div><dt>AI processing</dt><dd>On this device</dd></div><div><dt>Conversation storage</dt><dd>{mobile ? 'Browser database' : 'Local SQLite database'}</dd></div>{mobile && <div><dt>Secure page</dt><dd>{support?.secureContext ? 'HTTPS / secure context' : 'Not secure'}</dd></div>}</dl><p className="system-footnote">Internet is needed for first-time model downloads and remote MCP services. Your local model does not need a cloud API key.</p></article>
      {!mobile && <article className="card system-card"><header><Cpu size={19} /><h2>Processor & memory</h2></header>{system ? <><dl><div><dt>Processor</dt><dd className="system-wrap-text">{system.cpuName || 'Not reported'}</dd></div><div><dt>CPU threads</dt><dd>{system.cpuCores || 'Not reported'}</dd></div><div><dt>System</dt><dd>{system.os} · {system.arch}</dd></div><div><dt>Available memory</dt><dd>{formatBytes(system.availableMemoryBytes)}</dd></div></dl><UsageBar label="Memory in use" used={Math.max(0, system.totalMemoryBytes - system.availableMemoryBytes)} total={system.totalMemoryBytes} /><p className="system-footnote">This includes the operating system and other apps. Longer contexts and multiple models use more memory.</p></> : <p className="muted">{loading ? 'Reading system information…' : 'Refresh to read this computer’s processor and memory.'}</p>}</article>}
      {!mobile && <article className="card system-card"><header><HardDrive size={19} /><h2>Storage</h2></header>{system ? <><dl><div><dt>Available space</dt><dd>{system.totalDiskBytes > 0 ? formatBytes(system.freeDiskBytes) : 'Not reported'}</dd></div><div><dt>Drive capacity</dt><dd>{system.totalDiskBytes > 0 ? formatBytes(system.totalDiskBytes) : 'Not reported'}</dd></div></dl><UsageBar label="Drive in use" used={Math.max(0, system.totalDiskBytes - system.freeDiskBytes)} total={system.totalDiskBytes} /><p className="system-footnote">For the drive containing LocalDesk’s data. Ollama model files can be on a different drive if you changed its model location.</p></> : <p className="muted">No storage information has been read yet.</p>}</article>}
      {!mobile && <article className="card system-card system-wide"><header><Laptop size={19} /><h2>Graphics</h2></header>{system?.gpus.length ? <div className="system-gpus">{system.gpus.map((gpu, index) => <div className="system-gpu" key={`${gpu.name}-${index}`}><strong>{gpu.name}</strong><dl><div><dt>Reported graphics memory</dt><dd>{gpu.totalMemoryBytes !== null ? formatBytes(gpu.totalMemoryBytes) : 'Not reported'}</dd></div><div><dt>Free graphics memory</dt><dd>{gpu.freeMemoryBytes !== null ? formatBytes(gpu.freeMemoryBytes) : 'Not reported'}</dd></div><div><dt>Detection source</dt><dd>{gpu.source === 'nvidia-smi' ? 'NVIDIA driver' : gpu.source === 'windows-driver-estimate' ? 'Windows driver estimate' : gpu.source}</dd></div></dl>{gpu.source !== 'nvidia-smi' && <p className="system-footnote">Driver-reported graphics memory can be incomplete or include shared memory. Check your hardware specifications before choosing a large model.</p>}</div>)}</div> : <div className="notice"><CircleAlert size={17} /><span>{loading ? 'Checking graphics adapters…' : 'No graphics adapter was reported by the available detection methods. This does not necessarily mean your computer has no GPU.'}</span></div>}</article>}
      {mobile && <article className="card system-card"><header><Cpu size={19} /><h2>Browser graphics</h2></header><dl><div><dt>WebGPU API</dt><dd>{support?.webgpu ? 'Available' : 'Unavailable'}</dd></div><div><dt>Adapter</dt><dd className="system-wrap-text">{support?.gpuName || 'Not reported'}</dd></div><div><dt>GPU buffer limit</dt><dd>{formatBytes(support?.maxStorageBufferBindingSize)}</dd></div><div><dt>Device memory hint</dt><dd>{support?.deviceMemoryGB ? `About ${support.deviceMemoryGB} GB` : 'Browser does not disclose this'}</dd></div></dl>{support?.reason && <p className="notice danger">{support.reason}</p>}<p className="system-footnote">Browsers do not reveal exact free RAM or VRAM. A memory hint is not the memory available to this app. Try the smallest model first.</p></article>}
      {mobile && <article className="card system-card"><header><Database size={19} /><h2>Browser storage</h2></header><dl><div><dt>Used by this site</dt><dd>{formatBytes(support?.storageUsage)}</dd></div><div><dt>Estimated quota</dt><dd>{formatBytes(support?.storageQuota)}</dd></div><div><dt>Persistent storage</dt><dd>{support?.persistentStorage ? 'Granted' : 'Not granted or unavailable'}</dd></div></dl><UsageBar label="Site storage use" used={support?.storageUsage ?? 0} total={support?.storageQuota ?? 0} /><p className="system-footnote">Storage is managed by the browser. Clearing website data removes downloaded models and conversations. The browser may also clear unprotected storage when space is low.</p></article>}
    </div>
    {!mobile && system && <div className="models-tools-line"><span className="badge">{system.ollamaInstalled ? <Check size={13} /> : <CircleAlert size={13} />}Ollama {system.ollamaInstalled ? 'installed' : 'not found'}</span><span className="badge">{system.llmfitInstalled ? <Check size={13} /> : <CircleAlert size={13} />}llmfit {system.llmfitInstalled ? 'available' : 'not found'}</span></div>}
    <p className="models-estimate-note"><ShieldCheck size={15} />Device information stays in this app. Hardware readings and fit estimates do not guarantee a model will load successfully.{checkedAt ? ` Last checked at ${checkedAt}.` : ''}</p>
  </section>;
}
