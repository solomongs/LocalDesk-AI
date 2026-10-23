# LocalDesk AI v0.2 rebuild checklist

Legend: [x] implemented/verified; [ ] pending. A checked build is not a physical-device test.

## Scope
- [x] Inspect repository and old release; use clean Tauri v2 replacement (remove Electron/code editor from current project).
- [x] Define shared frontend and native/browser engine contracts.
- [x] Desktop Tauri v2 and embedded SQLite conversations/settings.
- [x] Mobile/browser PWA uses only WebLLM; no native engine controls.
- [x] Device detection, hardware/engine status, local model selection.
- [x] Curated model guides with use cases, sizes, limitations and illustrative preview before download.
- [x] Real WebLLM download progress, loading, streaming and cancellation.
- [x] Ollama install/start guidance, installed models, pull progress, removal.
- [x] llmfit integration and clearly labelled hardware-fit estimates.
- [x] Local authenticated OpenAI-compatible API and MCP server for external coding agents.
- [x] Import/review MCP configs with explicit consent before execution.
- [x] Installable offline PWA with native-feeling mobile UI and installation help.
- [x] About Solomon Gbeta / Powered by Multilancer LTD in app, site and README.
- [x] GitHub source, build/release workflow and persistent updater public key.
- [x] Publish refreshed localdesk.ng.cyou and PWA; GitHub-hosted website source/build.
- [x] Retire the old Electron installer, upload route, manifest and temporary upload files.

## Verification
- [x] TypeScript build and 21 meaningful core unit tests.
- [x] Ten native production-module tests using the GUI-independent Rust harness.
- [x] Rust compile/tests on Windows CI.
- [x] Security audit: loopback binding, authentication, origin checks, subprocess boundaries, imported secrets, updater trust.
- [x] Production npm dependency audit: zero known vulnerabilities at validation time.
- [x] Browser shell/mobile layout and primary interactions.
- [x] PWA manifest/service worker packaging checks.
- [x] Live SmolLM2 360M download, local response, retained cache and conversation reload in Chrome/WebGPU.
- [x] Windows installer artifact and signed updater manifest checks.
- [x] Record actual model/GPU tests and physical Windows/mobile limitations honestly in docs/VERIFICATION.md.
- [ ] Fresh install and native Ollama inference on a physical Windows laptop.
- [ ] Airplane-mode inference and home-screen installation on physical Android and iPhone/iPad devices.

## v0.2.1 mobile catalog expansion
- [x] List all 165 variants in the pinned WebLLM catalog (159 text, 2 vision, 4 embedding).
- [x] Group 68 model families from 16 publishers with per-family variant choices.
- [x] Search model names, IDs, publishers and use cases.
- [x] Add working-memory, model-download and downloaded-only filters.
- [x] Distinguish manifest-backed weight sizes from estimates and from runtime memory.
- [x] Gate unsupported specialist models and known GPU limits before loading.
- [x] Respect per-model context/recurrent settings and verify modern tensor-cache/MPK handling.
- [x] Pass 30 core tests, TypeScript and production PWA build.
- [ ] Publish and visually verify the expanded PWA.
- [ ] Publish and verify the signed v0.2.1 update.
