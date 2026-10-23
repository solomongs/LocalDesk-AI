# LocalDesk AI v0.2 rebuild checklist

Legend: [x] implemented/verified; [ ] pending. A checked build is not a physical-device test.

## Scope
- [x] Inspect repository and old release; use clean Tauri v2 replacement (remove Electron/code editor from current project).
- [x] Define shared frontend and native/browser engine contracts.
- [ ] Desktop Tauri v2 and embedded SQLite conversations/settings.
- [ ] Mobile/browser PWA uses only WebLLM; no native engine controls.
- [ ] Device detection, hardware/engine status, local model selection.
- [ ] Curated model guides with use cases, sizes, limitations and illustrative preview before download.
- [ ] Real WebLLM download progress, loading, streaming and cancellation.
- [ ] Ollama install/start guidance, installed models, pull progress, removal.
- [ ] llmfit integration and clearly labelled hardware-fit estimates.
- [ ] Local authenticated OpenAI-compatible API and MCP server for external coding agents.
- [ ] Import/review MCP configs with explicit consent before execution.
- [ ] Installable offline PWA with native-feeling mobile UI and installation help.
- [ ] About Solomon Gbeta / Powered by Multilancer LTD in app, site and README.
- [ ] GitHub source, build/release workflow, persistent updater public key and signed updates.
- [ ] Publish refreshed localdesk.ng.cyou and PWA; GitHub-hosted website source/build.

## Verification
- [ ] TypeScript build and meaningful unit tests.
- [ ] Rust compile/tests on Windows CI.
- [ ] Security audit: loopback binding, authentication, origin checks, subprocess boundaries, imported secrets, updater trust.
- [ ] Browser shell/mobile layout and primary interactions.
- [ ] PWA manifest/service worker/offline-shell checks.
- [ ] Windows installer artifact and signed updater manifest checks.
- [ ] Record actual model/GPU tests and physical Windows/mobile limitations honestly.
