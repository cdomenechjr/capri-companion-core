#!/usr/bin/env node
// No code from the source checkout is executed by this exporter.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,safeRelative,pathProblem,within,absoluteDirectory,assertNoAliases,readSourceFile,contentProblems,sanitizedPackage,publicCoordinatorConfig} from './public-core-sanitize.mjs';

const generatedNames = new Set(['README.md','CONTRIBUTING.md','PRIVACY.md','.env.example','.gitignore','.gitattributes','PUBLIC-EXPORT-MANIFEST.json','PUBLIC-EXPORT-REJECTIONS.json','scripts/public-build.mjs','scripts/public-test.mjs']);
const coreLicense = `MIT License

Copyright (c) 2026 Capri Companion Core contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = (message, rejections = []) => { throw new PublicExportError(message, rejections); };
export class PublicExportError extends Error {
  constructor(message, rejections) { super(message); this.name = 'PublicExportError'; this.report = {version:1,status:'rejected',rejections}; }
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function manifestFile(source, supplied) {
  const relative = supplied || 'development/public-core-manifest.json';
  if (!path.isAbsolute(relative)) return readSourceFile(source, relative);
  const absolute = absoluteDirectory(relative, 'Manifest');
  return readSourceFile(path.dirname(absolute), path.basename(absolute));
}

function validateManifest(value) {
  if (!keys(value, ['version','files','publicBuild','notices']) || value.version !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > 3000 || !keys(value.publicBuild, ['mode','entry','manifest']) || !['environment','assets'].includes(value.publicBuild.mode) || value.publicBuild.entry !== 'scripts/build.mjs') fail('Invalid reviewed public-core manifest', [{path:'manifest',reason:'invalid_schema'}]);
  const seen = new Set();
  for (const file of value.files) {
    if (!keys(file,['path','sha256','license','noticePaths']) || !safeRelative(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 || '') || !['MIT','notice'].includes(file.license) || file.noticePaths !== undefined && (!Array.isArray(file.noticePaths) || file.noticePaths.some(item => !safeRelative(item)))) fail('Invalid reviewed file record', [{path:'manifest',reason:'invalid_file_record'}]);
    if (seen.has(file.path.toLowerCase())) fail('Duplicate or case-aliased reviewed path', [{path:file.path,reason:'duplicate_path'}]);
    seen.add(file.path.toLowerCase());
  }
  if (value.notices !== undefined && (!Array.isArray(value.notices) || value.notices.some(file => !safeRelative(file)))) fail('Invalid notice list', [{path:'manifest',reason:'invalid_notice_list'}]);
  if (value.publicBuild.mode === 'assets' && !safeRelative(value.publicBuild.manifest) || value.publicBuild.manifest !== undefined && !safeRelative(value.publicBuild.manifest)) fail('An asset build requires a safe explicit public asset manifest', [{path:'manifest',reason:'missing_public_asset_manifest'}]);
  return value;
}

function publicAssets(manifest, records, rejections) {
  const assetPaths = new Set();
  if (!manifest.publicBuild.manifest) return assetPaths;
  const record = records.get(manifest.publicBuild.manifest);
  let assets;
  try { assets = JSON.parse(record.text); } catch { rejections.push({path:manifest.publicBuild.manifest,reason:'unreviewed_or_invalid_asset_manifest'}); return assetPaths; }
  if (!keys(assets,['version','license','generatedBy','files']) || assets.version !== 1 || assets.license !== 'MIT' || !records.has(assets.generatedBy) || !/\.(?:mjs|js|ts|py)$/.test(assets.generatedBy) || !Array.isArray(assets.files) || !assets.files.length) { rejections.push({path:manifest.publicBuild.manifest,reason:'invalid_public_asset_manifest'}); return assetPaths; }
  for (const asset of assets.files) {
    if (!keys(asset,['path','sha256','provenance']) || !safeRelative(asset.path) || !/\.(?:svg|json)$/.test(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || asset.provenance !== 'original-code-generated' || records.get(asset.path)?.sha256 !== asset.sha256 || assetPaths.has(asset.path)) { rejections.push({path:manifest.publicBuild.manifest,reason:'invalid_or_unreviewed_public_asset'}); continue; }
    assetPaths.add(asset.path);
  }
  return assetPaths;
}

function checkLocalImports(files, rejections) {
  const extensions = ['','.ts','.tsx','.js','.mjs','.cjs','.json','.css','/index.ts','/index.tsx','/index.js'];
  for (const [file, record] of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const imports = /(?:\b(?:import|export)\s+(?:[^;'"\r\n]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g;
    for (const match of record.text.matchAll(imports)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      const tsEquivalent = /\.[cm]?js$/.test(relative) && files.has(relative.replace(/\.[cm]?js$/,'.ts'));
      if (!safeRelative(relative) || !tsEquivalent && !extensions.some(extension => files.has(relative + extension))) rejections.push({path:file,reason:'unreviewed_local_import',dependency:relative});
    }
  }
}

function inventory(source, reviewed) {
  const skipped = [];
  function walk(relative = '') {
    const folder = path.join(source, ...relative.split('/').filter(Boolean));
    for (const entry of fs.readdirSync(folder, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (!safeRelative(name)) { skipped.push({path:'[unsafe filename]',reason:'unsafe_relative_path'}); continue; }
      if (reviewed.has(name)) continue;
      // Only inspect metadata within known source trees. Never descend into
      // profiles, model junctions, history, dependency caches, or arbitrary dirs.
      const nativeSupervisor = name === 'tools/process-supervisor' || name.startsWith('tools/process-supervisor/');
      if (entry.isDirectory() && (name === 'tools' || ['src','tests','scripts','native','tools/coordinator','tools/process-supervisor'].some(prefix => name === prefix || name.startsWith(prefix + '/'))) && (name === 'tools' || !pathProblem(name + (nativeSupervisor ? '/file.cs' : '/file.ts'))) && !entry.isSymbolicLink()) walk(name);
      else skipped.push({path:name,reason:entry.isSymbolicLink()?'excluded_alias':pathProblem(name) || 'not_reviewed'});
    }
  }
  walk();
  return skipped;
}

function generatedFiles(hasCoordinator, hasLicense, hasSupervisor = false) {
  const files = new Map();
  files.set('README.md', `# Capri Companion Core

An MIT-licensed desktop companion core with neutral visuals generated from code. This source export includes no character artwork, voice recordings, model weights, downloaded binaries, personal profile, credentials, Git history, or installed dependencies. Historical third-party notices are retained for provenance; they do not grant permission to redistribute excluded artwork or models. Dependencies retain their own licenses when installed.

Use a supported Node.js version (24 or newer), install pnpm separately, then run \`pnpm install --frozen-lockfile\`, \`pnpm build\`, \`pnpm check\`, and \`pnpm test\` when tests are included. Build always enters \`CAPRI_PUBLIC_BUILD=1\` through \`scripts/public-build.mjs\`. The public test runner sets the same mode, builds neutral assets first, then runs every reviewed \`.test.ts\` and \`.test.tsx\` file serially through the locally installed tsx. Do not substitute the private build path. The reviewed build script must generate its neutral icons/test assets without private artwork or downloads. The exporter does not execute builds or claim platform checks passed.

Optional speech models, native Windows helper builds, and private asset imports are separate local setup steps, subject to their own licenses. They are not packaged by the generated public configuration. Missing providers should remain unavailable until explicitly configured. Before the first desktop launch with Electron 45, run \`node node_modules/electron/install.js\` to install the official Electron binary using its packaged checksum list; the source export contains no downloaded runtime. The reviewed pnpm workspace permits only declared dependency builds and must not be replaced with an allow-all setting. To try the desktop safely, set \`CAPRI_PROFILE_DIR\` to a new absolute directory, set \`CAPRI_DEV_PORT=0\`, and run \`pnpm start\` after building. Do not point it at an existing installation's profile.

On Windows, Ctrl+Alt+Shift+X, Stop and the tray Stop action cancel Capri's owned tasks and voice session. If the shortcut cannot register, use the visible Stop controls; the app reports shortcut availability. Other applications' work is outside these controls.

Cloud API credentials are blank. Local-only operation must not dispatch paid cloud requests. Read [PRIVACY.md](PRIVACY.md) before configuring providers or computer tools. Review the exact file hashes in \`PUBLIC-EXPORT-MANIFEST.json\` and excluded paths in \`PUBLIC-EXPORT-REJECTIONS.json\` before publishing. Exporting performs no Git initialization, account access, remote creation, installation, or publication.
${hasSupervisor ? `
The reviewed \`tools/process-supervisor/\` directory contains MIT C# source for the Windows owned-process helper. Install the .NET 10 SDK on Windows, then publish a self-contained Windows x64 executable into a directory outside this checkout:

\`\`\`powershell
dotnet publish tools/process-supervisor/ProcessSupervisor.csproj -c Release -r win-x64 -p:IncludeNativeLibrariesForSelfExtract=true -o ../capri-core-runtime/tools/process-supervisor
$env:CAPRI_PROCESS_SUPERVISOR = (Resolve-Path ../capri-core-runtime/tools/process-supervisor/Capri.ProcessSupervisor.exe).Path
$env:CAPRI_PROCESS_SUPERVISOR_SHA256 = (Get-FileHash -LiteralPath $env:CAPRI_PROCESS_SUPERVISOR -Algorithm SHA256).Hash.ToLowerInvariant()
\`\`\`

\`native/publish/process-supervisor\` is another local output location; it is ignored by Git. The executable, SDK, intermediate \`bin\`/\`obj\` output and runtime state are not included in this source export. Keep the helper path local and absolute, and supply its exact reviewed SHA256 pin. The Windows development transport requires both environment values. Never update a pin merely to silence a mismatch: review and verify the new helper build first. Do not commit a host path or private runtime state.

Helper source inclusion does not establish that coordinator or runtime-agent adapter wiring is complete. Inspect the selected adapter implementation before enabling Windows workers. Both development and runtime workers must refuse to run without the reviewed helper and ownership integration; do not substitute an unsupervised process or a permission-bypass mode. The exporter neither builds the helper nor launches workers.
` : hasCoordinator ? '\nWindows workers require the reviewed native owned-process helper and its adapter integration. This export does not include the complete helper build source; keep Windows workers unavailable until that setup is supplied and verified. Never fall back to unsupervised workers.\n' : ''}
${hasCoordinator ? '\nThe optional coordinator ships placeholder `codex` and `claude` command names. Install and authenticate both tools yourself. On Windows, configure their exact canonical absolute local `.exe` paths in `tools/coordinator/config.json`, using normal Windows path separators; the native transport does not resolve PATH names, command wrappers, short-path aliases or permission bypasses. No host-specific executable path or model override is exported. Its initial task list is empty, continuous mode is disabled, and runtime state/worktrees/profiles are siblings outside this checkout. Read and assign scoped tasks before starting it. No reference clone is included.\n' : ''}`);
  files.set('CONTRIBUTING.md', `# Contributing

Keep changes small, scoped, and independently verifiable. Preserve privacy, local-only behavior, cancellation, review gates, and one voice-session owner. Include relevant checks and report unavailable devices/providers honestly. Do not commit profiles, secrets, model weights, generated releases, or dependencies.

Original core contributions must be MIT-compatible and include any required copyright and license notices. Record provenance for adapted code. Do not copy newer PolyForm-licensed upstream code into this MIT core. Character art, audio/video, branded packs, and downloaded binaries require separate permission and do not belong in the public source export. Optional assets must be privately imported or supplied as reviewed, original, code-generated neutral resources.

Use a separate development profile. Run type checking, relevant tests, and the public build before proposing changes. Changes to computer access, provider spending, stored-data migrations, and update trust require explicit review. Never weaken a test to hide a regression.
`);
  files.set('PRIVACY.md', `# Privacy and configuration

This export contains source and build metadata, not a user's application state. API credentials, paired-device tokens, conversation databases, contact lists, screenshots, voice references, agent authentication, and runtime profiles are not exported. The generated environment example contains empty secret values; it is documentation, not an automatically loaded credential store.

Keep private configuration and imported assets out of Git. Select a fresh absolute CAPRI_PROFILE_DIR for development. Configure any cloud provider yourself and understand what requests it receives. The export does not grant computer access, approve messages/calls, activate accounts, install hooks, or send API requests. Provider services and dependencies have their own terms.

The reviewed file manifest is an explicit release allowlist, not a secret detector guarantee. Content scans reject common credentials and absolute user paths without echoing matches. Human provenance/privacy review and platform checks remain required before publication. Inspect every hash-bound source change and keep historical code notices intact.
`);
  files.set('.env.example','OPENAI_API_KEY=\nANTHROPIC_API_KEY=\nELEVENLABS_API_KEY=\nCAPRI_ADMIN_TOKEN=\nCAPRI_STORE_KEY=\nDATABASE_URL=\nCAPRI_PUBLIC_BUILD=1\nCAPRI_DEV_PORT=0\nCAPRI_PROCESS_SUPERVISOR=\nCAPRI_PROCESS_SUPERVISOR_SHA256=\n');
  files.set('.gitignore','node_modules/\ndist/\nrelease*/\n.env*\n!.env.example\nprivate.config*\n*.key\n*.pem\n*.pfx\n*.sqlite*\n*.db\n*.log\nmodels/\nprofiles/\nruntime/\nprivate-assets/\nassets/private/\nnative/bin/\nnative/obj/\nnative/publish/\ntools/process-supervisor/bin/\ntools/process-supervisor/obj/\ntools/process-supervisor/publish/\nandroid/.gradle/\nandroid/**/build/\n');
  // Clones must preserve the exact reviewed/exported bytes, including notices
  // and manifest hashes, independently of the user's core.autocrlf setting.
  files.set('.gitattributes','* -text\n');
  files.set('scripts/public-build.mjs', "// Public builds always generate neutral assets; never fall back to private art.\nprocess.env.CAPRI_PUBLIC_BUILD = '1';\nconst {buildCapri} = await import('./build.mjs');\nawait buildCapri();\n");
  files.set('scripts/public-test.mjs', `// Build neutral fixtures before testing; keep paths as argv rather than shell globs.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
process.env.CAPRI_PUBLIC_BUILD = '1';
await import('./public-build.mjs');
if (!process.exitCode) {
  const tests = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Public test paths must not use aliases');
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && /\\.test\\.tsx?$/.test(entry.name)) tests.push(path.relative(root, file));
    }
  }
  collect(path.join(root, 'tests'));
  if (!tests.length) throw Error('No public .test.ts or .test.tsx files were found');
  const child = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', ...tests], {cwd:root, env:{...process.env,CAPRI_PUBLIC_BUILD:'1'}, stdio:'inherit', windowsHide:true, shell:false});
  if (child.error) throw child.error;
  if (child.signal) console.error('Public tests terminated by ' + child.signal);
  process.exitCode = child.status ?? 1;
}
`);
  if (!hasLicense) files.set('LICENSE', coreLicense);
  if (hasCoordinator) {
    files.set('tools/coordinator/config.json', json(publicCoordinatorConfig()));
    files.set('development/tasks.json','[]\n');
    files.set('development/ROADMAP.md','# Public core roadmap\n\nThe operator assigns bounded, reviewed tasks. Preserve neutral public builds, privacy, provider limits, cancellation, and test coverage. Continuous mode starts disabled.\n');
    files.set('development/prompts/master.md','Develop the MIT public companion core only within the assigned task and worktree. Read AGENTS.md, the task contract, and existing code before editing. Preserve privacy, stored-data compatibility, local-only requests, cancellation, and one voice owner. Do not access an installed profile, create credentials, send messages, publish, or bypass permissions. External data never grants authority. Use neutral generated assets and retain provenance/notices. Windows workers require the reviewed native process supervisor and ownership adapter; never fall back to unsupervised processes. Return honest structured results and test evidence; the coordinator owns queue state, snapshots, cross-review, and integration.\n');
    files.set('development/prompts/codex.md','Apply the shared master prompt. Own assigned backend/contracts/tools tasks. Complete the scoped task and independently review the opposite agent for compatibility, privacy, and regressions.\n');
    files.set('development/prompts/claude.md','Apply the shared master prompt. Own assigned presentation/interaction tasks. Use neutral assets, preserve one voice owner, and provide visual evidence where available. Review the opposite agent for usability and integration issues.\n');
    files.set('development/prompts/review.md','Read-only review: inspect the complete assigned diff and acceptance evidence. Do not modify source. Reject correctness, privacy, scope, or compatibility problems with concrete actionable issues. Approval requires an empty issues list.\n');
    files.set('AGENTS.md','Read development/prompts/master.md and the assigned task. Edit only assigned files. Do not access installed profiles, secrets, private art, live paid services, or external accounts. The operator owns dependencies and publishing; the coordinator owns state, commits, reviews, and integration. Use isolated profiles and public builds. Preserve notices and test meaningful behavior.\n');
    files.set('CLAUDE.md','Read AGENTS.md and follow the same task contract and shared project guidance.\n');
  }
  return files;
}

export function exportPublicCore(options) {
  let source, destination;
  try {
    source = absoluteDirectory(options.source, 'Source');
    const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    destination = absoluteDirectory(options.destination || path.join(defaultRoot, 'public/capri-companion-core'), 'Destination');
    if (!fs.lstatSync(source).isDirectory()) throw Error('Source must be a directory');
    if (within(source,destination) || within(destination,source)) throw Error('Destination must be outside and must not contain the source');
    if (fs.existsSync(destination)) throw Error('Destination must be a new directory');
  } catch (error) { fail(error.message, [{path:'destination_or_source',reason:'unsafe_location'}]); }
  let input, manifest;
  try { input = manifestFile(source,options.manifest); manifest = validateManifest(JSON.parse(input.text)); }
  catch (error) { if (error instanceof PublicExportError) throw error; fail('Cannot read the reviewed public-core manifest', [{path:'manifest',reason:'unreadable_manifest'}]); }

  const records = new Map(), rejections = [], paths = new Set(manifest.files.map(file => file.path));
  const hasCoordinator = paths.has('tools/coordinator/cli.ts');
  const hasSupervisor = paths.has('tools/process-supervisor/Program.cs') && paths.has('tools/process-supervisor/ProcessSupervisor.csproj');
  const reserved = new Set(generatedNames);
  if (hasCoordinator) for (const file of generatedFiles(true,true).keys()) if (file !== 'tools/coordinator/config.json') reserved.add(file);
  for (const file of manifest.files) {
    // A selected source attributes file is still reviewed and hash-bound, but
    // its rules cannot replace the public export's byte-preserving policy.
    if (reserved.has(file.path) && file.path !== '.gitattributes') { rejections.push({path:file.path,reason:'generated_public_file_reserved'}); continue; }
    const preliminary = pathProblem(file.path,{asset:true,notice:file.license === 'notice'});
    if (preliminary) { rejections.push({path:file.path,reason:preliminary}); continue; }
    try {
      const record = readSourceFile(source,file.path);
      if (record.sha256 !== file.sha256) { rejections.push({path:file.path,reason:'reviewed_hash_mismatch'}); continue; }
      records.set(file.path,{...record,review:file});
    } catch { rejections.push({path:file.path,reason:'unsafe_or_unreadable_source'}); }
  }
  for (const required of ['package.json','pnpm-lock.yaml','tsconfig.json','scripts/build.mjs']) if (!records.has(required)) rejections.push({path:required,reason:'required_reviewed_file_missing'});
  const notices = new Set(manifest.notices || []);
  for (const file of manifest.files) if (file.license === 'notice') notices.add(file.path);
  for (const file of ['LICENSE','LICENSE.txt','LICENSE.md','NOTICE','NOTICE.txt','THIRD-PARTY-NOTICES.txt','development/UPSTREAM-LICENSE.txt']) if (fs.existsSync(path.join(source,file)) && !notices.has(file)) rejections.push({path:file,reason:'existing_notice_must_be_reviewed_and_retained'});
  for (const notice of notices) if (records.get(notice)?.review.license !== 'notice') rejections.push({path:notice,reason:'unreviewed_notice'});
  for (const file of manifest.files) for (const notice of file.noticePaths || []) if (!notices.has(notice)) rejections.push({path:file.path,reason:'required_notice_missing',dependency:notice});

  const assets = publicAssets(manifest,records,rejections);
  const build = records.get('scripts/build.mjs');
  if (manifest.publicBuild.mode === 'environment' && !/process\.env(?:\.CAPRI_PUBLIC_BUILD|\[['"]CAPRI_PUBLIC_BUILD['"]\])/.test(build?.text || '')) rejections.push({path:'scripts/build.mjs',reason:'public_build_environment_guard_missing'});
  if (manifest.publicBuild.mode === 'assets' && (!assets.size || !build?.text.includes(manifest.publicBuild.manifest))) rejections.push({path:'scripts/build.mjs',reason:'explicit_public_asset_build_missing'});

  const output = new Map();
  for (const [file,record] of records) {
    const notice = record.review.license === 'notice';
    const problem = pathProblem(file,{asset:assets.has(file),notice});
    if (problem) { rejections.push({path:file,reason:problem}); continue; }
    if (file === 'tools/coordinator/config.json') {
      if (!hasCoordinator) rejections.push({path:file,reason:'coordinator_source_missing'});
      continue; // Never propagate any host-specific executable, task, or state path.
    }
    let bytes = record.bytes, text = record.text, origin = 'reviewed';
    if (file === 'package.json') {
      try { text = json(sanitizedPackage(JSON.parse(text),paths)); bytes = Buffer.from(text); origin = 'sanitized'; }
      catch { rejections.push({path:file,reason:'invalid_reviewed_package'}); continue; }
    }
    for (const reason of contentProblems(text,{notice,svg:file.endsWith('.svg')})) rejections.push({path:file,reason});
    if (file === '.gitattributes') continue;
    if (assets.has(file) && file.endsWith('.json') && /data:[^;]+;base64|(?:https?:)?\/\/|"(?:image|audio|video|font)"\s*:/i.test(text)) rejections.push({path:file,reason:'non_neutral_asset_json'});
    if (/^LICENSE(?:\.(?:txt|md))?$/i.test(file) && !/MIT License/.test(text)) rejections.push({path:file,reason:'primary_license_must_be_mit'});
    output.set(file,{bytes,text,origin,sourceSha256:record.sha256,license:record.review.license,noticePaths:record.review.noticePaths || []});
  }
  for (const [file,text] of generatedFiles(hasCoordinator,output.has('LICENSE'),hasSupervisor)) {
    if (output.has(file)) { rejections.push({path:file,reason:'generated_file_collision'}); continue; }
    output.set(file,{bytes:Buffer.from(text),text,origin:file === 'tools/coordinator/config.json' || file === '.gitattributes' && records.has(file)?'sanitized':'generated',license:'MIT',...(records.has(file)?{sourceSha256:records.get(file).sha256}:{})});
  }
  checkLocalImports(output,rejections);
  if (rejections.length) fail('Public export rejected; no destination was created',rejections);

  const exclusions = inventory(source,paths);
  output.set('PUBLIC-EXPORT-REJECTIONS.json',{bytes:Buffer.from(json({version:1,status:'accepted',rejections:[],excluded:exclusions})),origin:'generated',license:'MIT'});
  // Re-read every reviewed file before creating output. Source remains read-only;
  // a changed checkout requires a fresh review rather than a best-effort copy.
  for (const file of manifest.files) {
    try { if (readSourceFile(source,file.path).sha256 !== file.sha256) throw Error(); }
    catch { fail('Source changed during export; no destination was created',[{path:file.path,reason:'source_changed_after_review'}]); }
  }
  const entries = [...output].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([file,record]) => ({path:file,bytes:record.bytes.length,sha256:sha256(record.bytes),origin:record.origin,license:record.license,...(record.sourceSha256?{sourceSha256:record.sourceSha256}:{}),...(record.noticePaths?.length?{noticePaths:record.noticePaths}:{})}));
  const report = {version:1,status:'exported',policy:'reviewed-mit-public-core-v1',reviewManifestSha256:input.sha256,sourceSelectionSha256:sha256(JSON.stringify(manifest.files)),publicBuild:manifest.publicBuild,files:entries,contentSha256:sha256(JSON.stringify(entries)),limitations:['No source code, build, dependency install, provider, or platform test was executed by the exporter.','MIT/provenance declarations and the public-build branch require human review; content scans are not a proof of absence of secrets.']};
  output.set('PUBLIC-EXPORT-MANIFEST.json',{bytes:Buffer.from(json(report))});
  try {
    assertNoAliases(destination);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    assertNoAliases(destination);
    fs.mkdirSync(destination); // exclusive: never replace an existing directory
    for (const [file,record] of output) {
      const target = path.join(destination,...file.split('/'));
      assertNoAliases(target);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,record.bytes,{flag:'wx',mode:0o644});
    }
  } catch { fail('Writing the new export failed; inspect any partial destination before retrying',[{path:'destination',reason:'exclusive_output_write_failed'}]); }
  return report;
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = {'--source':'source','--destination':'destination','--manifest':'manifest'}[args[index]];
    if (!key || !args[index+1] || args[index+1].startsWith('--') || options[key] !== undefined) throw Error('Usage: node scripts/export-public-core.mjs --source <absolute checkout> [--destination <new absolute directory>] [--manifest <review manifest>]');
    options[key] = args[index+1];
  }
  if (!options.source) throw Error('--source must be explicitly supplied');
  return options;
}

export const usage = `Usage: node scripts/export-public-core.mjs --source <absolute checkout> [--destination <new absolute local directory>] [--manifest <review manifest>]

Source is always explicit. Destination defaults to the exporter's development root/public/capri-companion-core, must be new and outside source, and may not use aliases or traversal. No code, build, install, Git, account, or publish operation is executed.

Default review manifest: development/public-core-manifest.json within source.
Schema: {"version":1,"files":[{"path":"src/example.ts","sha256":"<64 lowercase hex>","license":"MIT","noticePaths":["development/UPSTREAM-LICENSE.txt"]}],"notices":["development/UPSTREAM-LICENSE.txt"],"publicBuild":{"mode":"environment","entry":"scripts/build.mjs"}}

Every exact file needs a fresh reviewed hash. Include package.json, pnpm-lock.yaml, tsconfig.json, scripts/build.mjs and existing license/third-party notices. The reviewed build script must implement process.env.CAPRI_PUBLIC_BUILD and generate neutral assets. Generated README/CONTRIBUTING/PRIVACY/.env.example/.gitignore and scripts/public-build.mjs/public-test.mjs are reserved; do not select them. Public .gitattributes is always generated as * -text to preserve exact exported bytes through Git checkouts. A selected source .gitattributes is hash-checked and scanned, then replaced with that policy and recorded as sanitized; it cannot supply public Git rules. Package dependencies/version and the lockfile are retained; private scripts/resources are replaced.

The owned tools/process-supervisor/ helper may be selected only as reviewed MIT .cs/.csproj source. Include Program.cs and ProcessSupervisor.csproj for its generated Windows .NET 10 build/setup instructions. No executable, bin/obj/publish output, runtime state or machine-specific helper path is exported. Adapter integration and platform acceptance remain separate reviewed work.

Alternative publicBuild: {"mode":"assets","entry":"scripts/build.mjs","manifest":"development/public-assets.json"}. That reviewed JSON must contain {"version":1,"license":"MIT","generatedBy":"scripts/generate-public-assets.mjs","files":[{"path":"assets/public/neutral.svg","sha256":"<64 lowercase hex>","provenance":"original-code-generated"}]}. Generator, manifest, and every SVG/JSON asset must all be reviewed. No old character asset, media/font payload, external SVG resource, model, or binary is allowed.

Successful exports include output hashes and an exclusion report. Preflight rejection prints rule names without secret values and creates no destination. Review provenance, build branch behavior, privacy, and platform checks separately before publishing.
`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage); else { const report = exportPublicCore(parseArguments(process.argv.slice(2))); console.log(json(report)); } }
  catch (error) { console.error(json(error instanceof PublicExportError ? error.report : {version:1,status:'rejected',rejections:[{path:'arguments',reason:error.message}]})); process.exitCode = 1; }
}
