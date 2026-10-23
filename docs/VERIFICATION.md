# Validation record — 23 October 2026

## Completed checks

- Shared frontend: TypeScript and production Vite/PWA build pass; 21 core tests pass.
- Native production-module harness: 10 Rust tests pass without GUI dependencies. Full Windows Tauri compilation and native tests also pass in the release workflow.
- Production npm audit: zero known vulnerabilities returned at validation time. This is not a guarantee that every dependency is vulnerability-free.
- Focused code review: loopback API binding, bearer authentication, Host/Origin checks, fixed native upstream URLs, parameterized SQLite, explicit MCP execution consent, imported secret handling and updater trust.
- Public site: landing page, About, Windows download routing and Android/iOS installation instructions.
- Chrome live browser: mobile layout at 390 × 844, model preview dialog, download progress and complete SmolLM2 360M model loading. Device diagnostics reported an Intel Gen12LP adapter, WebGPU and a 2 GB per-buffer limit.
- The downloaded model produced a local completion. The first response was slow and factually weak; the smallest model is an engine trial, not a benchmark or a reliable expert assistant.
- The model remained marked downloaded after a full reload, and the saved prompt and answer were restored from IndexedDB. A cached model still needs loading into GPU memory after restarting the app.
- The PWA displayed its update notification and completed a user-triggered safe reload after a new website deployment.
- GitHub Pages deployment succeeded at https://solomongs.github.io/LocalDesk-AI/.
- Windows build, NSIS packaging and signed release publication succeeded in GitHub Actions run `39917011463`, source commit `ea1995ccaa2ce6705727bca73950209d0ddf6ac1`.
- Independent Ed25519/Blake2b verification checked the installer signature and signed version comment against the application's public key. A changed installer byte was correctly rejected. The manifest, detached signature and all published asset hashes agree.
- Released installer: `LocalDesk-AI-Setup-0.2.0-x64.exe`, 12,191,487 bytes, SHA-256 `f28c57aaf76c9e0741dbcd043edefae79e6c7046ef95a553eb607fbe3770923f`.
- The exact old 0.1.0 installer was removed from website object storage after the replacement was verified; old uploader/source manifests and local upload chunks were retired.

## Boundaries

Browser viewport testing is not a physical phone test. Physical Android/iOS home-screen installation, airplane-mode generation, thermal behavior and memory pressure still need device testing. The browser cache is not a guaranteed permanent model store.

Windows CI checks the actual Tauri target. It does not establish driver compatibility or inference speed on a particular user's laptop. Native Ollama/llama.cpp inference, installer upgrade/relaunch behavior and editor-specific integrations need a physical Windows test before advertising them as hardware-certified.

Imported MCP servers currently use a fresh session/process for each operation; servers requiring persistent per-session state or OAuth authentication may need additional integration. Hardware-fit rows are advisory; curated model guides supply the installation controls.

Updater signatures authenticate release bytes. They are separate from Windows Authenticode publisher certificates; the installer is not claimed to have an Authenticode certificate.
