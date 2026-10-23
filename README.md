# LocalDesk AI by Solomon

Your local AI workspace for a Windows laptop and a mobile Progressive Web App.

**Developed by Solomon Gbeta · Powered by Multilancer LTD**

[Website](https://localdesk.ng.cyou) · [How it works](https://localdesk.ng.cyou/how-it-works) · [Open mobile PWA](https://localdesk.ng.cyou/app/) · [GitHub website](https://solomongs.github.io/LocalDesk-AI/) · [Windows releases](https://github.com/solomongs/LocalDesk-AI/releases) · [Implementation checklist](CHECKLIST.md)

## What changed in 0.2.1

This is a clean Tauri v2 + SQLite rebuild. The old Electron application and built-in code editor are not part of this source tree. Use your preferred editor or coding agent through LocalDesk's local OpenAI-compatible API or MCP endpoint instead.

| Platform | Inference | Storage |
| --- | --- | --- |
| Desktop Tauri container | Native Ollama on 127.0.0.1:11434, or llama.cpp on 127.0.0.1:8080 | SQLite in the app data folder |
| Mobile/browser PWA | Compatible WebLLM MLC models on WebGPU | IndexedDB conversations and browser model cache |

**LocalLLM** is our friendly name for on-device AI. The browser implementation uses the open-source [WebLLM](https://github.com/mlc-ai/web-llm) runtime; it is not a renamed upstream library or a claim of ownership. The first model download and optional remote tools need internet. A successfully loaded local model can then answer offline.

## Features

- Familiar responsive chat interface, saved conversations, Markdown rendering, streaming and stop.
- Complete bundled WebLLM catalog on mobile, grouped by model family with company, use-case, memory and download filters. All variants remain searchable; incompatible/specialist entries are clearly marked.
- Model previews before downloading: use cases, weight-download sizes, working-memory estimates, limitations and labelled illustrative examples.
- Ollama manager with installed models, real download progress, removal, startup help and official installation links.
- Real [llmfit](https://github.com/AlexsJones/llmfit) recommendations on desktop; the Windows release bundles a checksum-verified binary. Fit/speed values are estimates.
- Local authenticated OpenAI-compatible API and Streamable HTTP MCP server for external coding agents; disabled by default and bound only to 127.0.0.1.
- Import common Claude/Cursor, VS Code and OpenCode MCP JSON layouts. Imported commands never execute automatically; every connection/tool call requires review.
- Installable mobile PWA, offline shell, device support diagnostics, persistent-storage request, safe update prompt and installation guide.
- Signed desktop updater using a stable public key and releases from this repository.

## Run locally

Node.js 24 and Rust stable (1.90+) are used by CI. Native Linux builds also require the normal Tauri WebKit/GTK prerequisites. Windows uses WebView2.

```bash
npm ci
npm run dev
```

The browser always uses WebLLM. To run the native desktop container:

```bash
npm run desktop:dev
```

To validate and build:

```bash
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

For the GUI-independent native test harness:

```bash
cargo test --manifest-path src-tauri/checks/Cargo.toml
```

## Source layout

```text
src/
  App.tsx                  responsive shared application shell and chat
  core/
    environment.ts         isPWA, native detection, WebGPU/storage checks
    engine.ts              shared completion and lifecycle controller
    useEngine.ts           React subscription hook
    catalog.ts             curated, explained model choices
    storage.ts             SQLite IPC or IndexedDB adapter
    native.ts              typed Tauri command adapter
    mcp.ts                 safe config import and consent-gated tool client
  components/
    ModelManager.tsx       model previews and Ollama manager
    SystemPanel.tsx        real device/engine diagnostics
    Connections.tsx        external agents and imported MCP tools
    Help.tsx               installation and about screens
  sw.ts                    public offline app shell only
src-tauri/
  src/                     Rust SQLite, engines, system, MCP and API bridge
  checks/                  production-module tests without GUI libraries
  tauri.conf.json          desktop identity and updater public key
.github/workflows/
  release.yml              Windows build, isolated signing, GitHub release
  pages.yml                GitHub-hosted website/PWA build and deployment
scripts/
  release-publish.mjs       authenticated signing and immutable release upload
  release-pages.mjs         static landing/about/install/how-it-works pages plus shared PWA
  release-licenses.mjs      bundled dependency notices
```

## External coding agents

Open **Connections** on desktop, enable local agent access and copy the displayed base URL, API key and installed model ID. Choose an OpenAI-compatible custom provider in your editor. Generic endpoint: `http://127.0.0.1:11435/v1`. MCP: `http://127.0.0.1:11435/mcp` with the same Bearer token.

VS Code providers/extensions, Continue, OpenCode and TRAE have different configuration formats and model features. Connecting an API does not guarantee every agent feature, tool call or cloud-dependent editor feature will work offline. Model quality and tool-call support vary. There is no built-in code editor or arbitrary shell execution tool in LocalDesk's exported MCP server.

## Mobile model catalog

The mobile library lists all 165 prebuilt variants shipped by WebLLM 0.2.86, organized into 68 model families from 16 publishers. Search model names, variant IDs, companies and tasks; filter by company, use case, maximum working memory, maximum model download and already downloaded models. Group by company, use case, memory tier or family.

159 text variants can be selected for chat when the device supports their GPU features. Two vision and four embedding variants remain visible with a browse-only explanation because this chat does not implement those specialized inputs/outputs. Model weights are separate from tokenizer/runtime storage. RAM values are WebLLM estimates, not a measurement of free phone memory.

To refresh catalog metadata from the pinned runtime and upstream weight manifests:

```bash
npm run catalog:refresh
```

## Mobile compatibility

Use the System screen before downloading. WebGPU support, device memory and browser limits determine whether a model can load. Installing a PWA does not give it native GPU access. Start with SmolLM2 360M; larger models need more memory. Browser storage may be evicted, and clearing website data removes models/chats. Export important conversations.

## Security and updates

Local API access is opt-in and loopback-only. Tokens are not forwarded to Ollama. Browser Origin requests are rejected. Imported MCP servers can run with your account's privileges and must be trusted. Remote MCP servers require HTTPS; explicit local loopback HTTP is supported. OAuth-based MCP sign-in is not currently implemented.

Release signing uses GitHub Actions OIDC with an exact-repository/workflow policy and a private key held outside this repository. Only the public updater key is committed. See [release operations](docs/RELEASING.md), [architecture](docs/ARCHITECTURE.md), and [the validation record](docs/VERIFICATION.md).

## About the developer

Solomon Gbeta (Solotron) is a full-stack developer, UI/UX designer, cloud and IT consultant, and founder of Multilancer LTD. LocalDesk AI is built to make local AI more understandable and practical for everyday users.

[Multilancer LTD](https://multilancer.ltd) — Local Roots, Global Wings.
