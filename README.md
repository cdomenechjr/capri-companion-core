# Capri Companion Core

An MIT-licensed desktop companion core with neutral visuals generated from code. This source export includes no character artwork, voice recordings, model weights, downloaded binaries, personal profile, credentials, Git history, or installed dependencies. Historical third-party notices are retained for provenance; they do not grant permission to redistribute excluded artwork or models. Dependencies retain their own licenses when installed.

Version 0.7.0-dev.4 adds 15 built-in companion workflows for planning, coaching, content, reviews, AI design and data privacy, bringing the catalog to 25. They ship in the application build. After updating and rebuilding, enable **Settings → Extensions → Use reviewed skills**, then open **Skills → Load catalog**. Existing skill settings and individual revocations are preserved. See [the skill catalog and update guide](docs/skills.md) for examples and requirements.

Use a supported Node.js version (24 or newer), install pnpm separately, then run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check`, and `pnpm test` when tests are included. Build always enters `CAPRI_PUBLIC_BUILD=1` through `scripts/public-build.mjs`. The public test runner sets the same mode, builds neutral assets first, then runs every reviewed `.test.ts` and `.test.tsx` file serially through the locally installed tsx. Do not substitute the private build path. The reviewed build script must generate its neutral icons/test assets without private artwork or downloads. The exporter does not execute builds or claim platform checks passed.

Optional speech models, native Windows helper builds, and private asset imports are separate local setup steps, subject to their own licenses. They are not packaged by the generated public configuration. Missing providers should remain unavailable until explicitly configured. Before the first desktop launch with Electron 45, run `node node_modules/electron/install.js` to install the official Electron binary using its packaged checksum list; the source export contains no downloaded runtime. The reviewed pnpm workspace permits only declared dependency builds and must not be replaced with an allow-all setting. To try the desktop safely, set `CAPRI_PROFILE_DIR` to a new absolute directory, set `CAPRI_DEV_PORT=0`, and run `pnpm start` after building. Do not point it at an existing installation's profile.

On Windows, Ctrl+Alt+Shift+X, Stop and the tray Stop action cancel Capri's owned tasks and voice session. If the shortcut cannot register, use the visible Stop controls; the app reports shortcut availability. Other applications' work is outside these controls.

Cloud API credentials are blank. Local-only operation must not dispatch paid cloud requests. Read [PRIVACY.md](PRIVACY.md) before configuring providers or computer tools. `PUBLIC-EXPORT-MANIFEST.json` and `PUBLIC-EXPORT-REJECTIONS.json` preserve the original sanitized export receipt; subsequent source changes are recorded in Git and must be reviewed and checked before publishing. Exporting performs no Git initialization, account access, remote creation, installation, or publication.

The reviewed `tools/process-supervisor/` directory contains MIT C# source for the Windows owned-process helper. Install the .NET 10 SDK on Windows, then publish a self-contained Windows x64 executable into a directory outside this checkout:

```powershell
dotnet publish tools/process-supervisor/ProcessSupervisor.csproj -c Release -r win-x64 -p:IncludeNativeLibrariesForSelfExtract=true -o ../capri-core-runtime/tools/process-supervisor
$env:CAPRI_PROCESS_SUPERVISOR = (Resolve-Path ../capri-core-runtime/tools/process-supervisor/Capri.ProcessSupervisor.exe).Path
$env:CAPRI_PROCESS_SUPERVISOR_SHA256 = (Get-FileHash -LiteralPath $env:CAPRI_PROCESS_SUPERVISOR -Algorithm SHA256).Hash.ToLowerInvariant()
```

`native/publish/process-supervisor` is another local output location; it is ignored by Git. The executable, SDK, intermediate `bin`/`obj` output and runtime state are not included in this source export. Keep the helper path local and absolute, and supply its exact reviewed SHA256 pin. The Windows development transport requires both environment values. Never update a pin merely to silence a mismatch: review and verify the new helper build first. Do not commit a host path or private runtime state.

Helper source inclusion does not establish that coordinator or runtime-agent adapter wiring is complete. Inspect the selected adapter implementation before enabling Windows workers. Both development and runtime workers must refuse to run without the reviewed helper and ownership integration; do not substitute an unsupervised process or a permission-bypass mode. The exporter neither builds the helper nor launches workers.


The optional coordinator ships placeholder `codex` and `claude` command names. Install and authenticate both tools yourself. On Windows, configure their exact canonical absolute local `.exe` paths in `tools/coordinator/config.json`, using normal Windows path separators; the native transport does not resolve PATH names, command wrappers, short-path aliases or permission bypasses. No host-specific executable path or model override is exported. Its initial task list is empty, continuous mode is disabled, and runtime state/worktrees/profiles are siblings outside this checkout. Read and assign scoped tasks before starting it. No reference clone is included.
