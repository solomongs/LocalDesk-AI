# Releasing LocalDesk AI

LocalDesk AI uses one stable Tauri updater trust key. The public key is committed in `src-tauri/tauri.conf.json`; the private key belongs only in the protected signing broker. Never commit the private key or regenerate it for each build. Losing it prevents existing installations from trusting future updates.

## Normal release

1. Change the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` together.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run release:check`.
3. Commit to `main`. The release workflow tests and builds Windows x64 with current stable Rust. It bundles the pinned llmfit executable only after checking the published SHA-256.
4. The unsigned installer is passed to a separate signing job. Dependencies are installed before that job requests its short-lived GitHub Actions OIDC identity.
5. The signing broker verifies the fixed GitHub issuer and audience, immutable repository and owner IDs, `main` branch, release workflow path, permitted event, GitHub-hosted runner, token time, and replay policy. It then returns the existing updater key for this trusted job.
6. The job supplies the key to the Tauri signer through its child-process environment. It never writes the private key to source, arguments, artifacts, or logs.
7. The job publishes the installer, detached `.sig`, `latest.json`, checksums, and build metadata as a GitHub Release. The app checks the stable `releases/latest/download/latest.json` endpoint.

The Tauri v2 updater uses the normal NSIS `.exe` directly. The `.sig` authenticates the exact installer bytes. This updater signature is separate from Windows Authenticode signing: an updater-signed installer may still show an unknown-publisher warning until an Authenticode certificate is configured.

## Version immutability and retries

An already-published version is never overwritten by this workflow. Increment the version for a different installer. A failed upload leaves a draft; rerunning the exact same commit can replace only that draft’s known assets and finish publication. A draft tied to a different commit is rejected rather than silently replaced.

If signing authorization fails, the build artifact remains available in the workflow run, but no unsigned update is published as trusted. Fix the broker/configuration and rerun the same workflow run.

## Signing broker configuration

The endpoint is `https://localdesk.ng.cyou/api/signing-key`, audience `localdesk-release`. It is not a general-purpose secret API. The broker must require these exact claims:

- Repository: `solomongs/LocalDesk-AI`, repository ID `1430688919`.
- Repository owner ID: `35314219`.
- Ref: `refs/heads/main`, ref type `branch`.
- Workflow ref: `solomongs/LocalDesk-AI/.github/workflows/release.yml@refs/heads/main`.
- Event: `push` or `workflow_dispatch`.
- Runner environment: `github-hosted`.

The broker returns `{ "key": "...", "password": "...", "publicKey": "..." }` only after verification. Configure secret rotation or emergency revocation at the broker, not by exposing a replacement key in Git. Changes to `main` and release workflow permissions are part of the updater’s trust boundary and should be reviewed carefully.

## GitHub website and mobile PWA

`pages.yml` builds the shared application and generates a small website, About page, and installation guide in `web-dist/`; the PWA is under `web-dist/app/`. This is also uploaded as a workflow artifact.

To publish at `https://solomongs.github.io/LocalDesk-AI/`, the repository owner must set **Settings → Pages → Source → GitHub Actions** once. The workflow checks this setting and explains when it is missing; an unconfigured Pages site does not block the independent desktop-release workflow. Rerun the Pages workflow after enabling it.

The custom domain `localdesk.ng.cyou` stays with the existing Sites deployment. Do not attach the same hostname to GitHub Pages. The Windows download CTA uses the main website’s stable download endpoint.

## Validation boundaries

CI proves compilation, automated tests, packaging, and signature generation. It does not prove actual GPU inference on every Windows laptop or mobile phone. Record real hardware tests separately, including the device, OS/browser, GPU, selected model, download/reload behavior, and offline conversation result.

## Pinned external component

- llmfit `v1.1.17`, Windows x64 (`x86_64-pc-windows-msvc`).
- SHA-256 `661b6ea57d835f681fbabcf3366649ff681d0081267fd3a05db254e67af6073f`.
- Source and license: <https://github.com/AlexsJones/llmfit> (MIT).
- Updater behavior: <https://v2.tauri.app/plugin/updater/>.
- GitHub OIDC: <https://docs.github.com/en/actions/reference/security/oidc>.
