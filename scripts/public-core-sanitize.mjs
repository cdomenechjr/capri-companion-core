// Export policy helpers. Importing this module never reads a profile or starts an app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const forbiddenSegments = /^(?:\.git|\.hg|\.svn|node_modules|models|profiles?|runtime|releases?[^/]*|dist|data|vault|credentials|\.ssh|\.aws|\.azure|\.config|\.cache|bin|obj|publish|\.gradle|\.idea|\.vscode)$/i;
const forbiddenFiles = /^(?:\.env(?:\..*)?|private\.config(?:\..*)?|credentials(?:\..*)?|vault\.(?:json|db)|capri\.sqlite.*|local\.properties|.*\.(?:pem|key|pfx|p12|jks|sqlite\d*|db|log))$/i;
const textExtensions = new Set(['.ts','.tsx','.js','.mjs','.cjs','.json','.css','.html','.md','.txt','.cs','.csproj','.ps1','.cmd','.py','.yaml','.yml','.svg']);
const rootFiles = new Set(['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','Dockerfile','.dockerignore','.gitattributes','development/public-assets.json']);

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.includes(':') || value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every(segment => segment && !['.','..'].includes(segment) && !/[. ]$/.test(segment) && !/[<>"|?*]/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment));
}

export function pathProblem(value, {asset = false, notice = false} = {}) {
  if (!safeRelative(value)) return 'unsafe_relative_path';
  const segments = value.split('/');
  if (segments.some(segment => forbiddenSegments.test(segment) || forbiddenFiles.test(segment))) return 'private_or_generated_path';
  if (segments[0] === 'assets' && !(asset && segments[1] === 'public')) return 'private_artwork_path';
  const base = segments.at(-1);
  const noticeName = /^(?:LICENSE|COPYING|NOTICE|THIRD-PARTY-NOTICES|UPSTREAM-LICENSE)(?:[-.][\w.-]+)?$/i.test(base);
  if (notice) return noticeName && /\.(?:txt|md)$/i.test(base) || noticeName && !path.posix.extname(base) ? undefined : 'notice_requires_notice_filename';
  if (rootFiles.has(value)) return undefined;
  // This owned native helper is a source-only exception, not an allowlist for
  // arbitrary tools, built executables, project output or configuration files.
  if (value.startsWith('tools/process-supervisor/')) return /\.(?:cs|csproj)$/i.test(base) ? undefined : 'supervisor_requires_csharp_source';
  if (!['src','tests','scripts','native'].includes(segments[0]) && !value.startsWith('tools/coordinator/') && !(asset && ['assets','public'].includes(segments[0]))) return 'outside_source_allowlist';
  const extension = path.posix.extname(value).toLowerCase();
  if (!textExtensions.has(extension)) return 'non_source_or_binary_file';
  if (extension === '.svg' && !asset) return 'asset_requires_public_manifest';
  return undefined;
}

export function within(root, target) {
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const relative = path.relative(compare(root), compare(target));
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).some(part => part === '..' || part === '.')) throw Error(label + ' must be an absolute local path without traversal');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw Error(label + ' cannot be a filesystem root');
  if (!safeRelative(resolved.slice(path.parse(resolved).root.length).split(path.sep).join('/'))) throw Error(label + ' contains an unsafe path component');
  assertNoAliases(resolved);
  // Windows TEMP can use an 8.3 spelling. Canonicalize existing ancestors after
  // rejecting links/junctions so containment compares the same actual path.
  const missing = [];
  let current = resolved;
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...missing.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(path.basename(current)); current = path.dirname(current); }
  }
}

// lstat each existing ancestor, including junctions. Never follow an excluded tree.
export function assertNoAliases(target) {
  const ancestors = [];
  for (let current = path.resolve(target);; current = path.dirname(current)) {
    ancestors.push(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of ancestors.reverse()) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw Error('Path aliases are not allowed');
      if (current !== path.resolve(target) && !stat.isDirectory()) throw Error('Path ancestor is not a directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function readSourceFile(root, relative) {
  if (!safeRelative(relative)) throw Error('Unsafe source path');
  const file = path.join(root, ...relative.split('/'));
  assertNoAliases(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > 8 * 1024 * 1024) throw Error('Source must be a regular, unaliased text file under 8 MiB');
  if (!within(root, fs.realpathSync.native(file))) throw Error('Source escaped its checkout');
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('Source changed while reading');
  const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
  if (text.includes('\0')) throw Error('Binary source content is not allowed');
  return {bytes, text, sha256:sha256(bytes)};
}

// Reject instead of silently rewriting code, fixtures, or attribution. Reports contain
// rule names only, never the matching credential or private path.
export function contentProblems(text, {notice = false, svg = false} = {}) {
  const problems = [];
  const unescaped = text.replace(/\\\\/g, '\\').replace(/\\u005c/gi, '\\').replace(/\\u002f/gi, '/');
  if (/(?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/][^\s\\/"'<>]+|\/(?:Users|home)\/[^\s/"'<>]+|\\\\[^\s\\]+\\(?:Users|home)\\)/i.test(unescaped)) problems.push('absolute_user_path');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{20,})\b/i.test(text)) problems.push('credential_material');
  if (/\b(?:https?|postgres(?:ql)?|mysql|amqps?):\/\/[^/\s"'@]+:[^/\s"'@]+@/i.test(text)) problems.push('credentialed_connection_url');
  if (/data:(?:image|audio|video|font)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{80,}/i.test(text)) problems.push('embedded_media_or_font');
  // Configuration JSON must not contain a configured key/token/password, even
  // when it does not resemble a particular provider's key format.
  if (/^[\s\uFEFF]*[\[{]/.test(text)) {
    try {
      const configured = value => objectValues(value).some(([key,item]) => /^(?:(?:openai|anthropic|elevenlabs)?api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|admin[_-]?token|store[_-]?key|password|CAPRI_ADMIN_TOKEN|CAPRI_STORE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ELEVENLABS_API_KEY)$/i.test(key) && typeof item === 'string' && item.trim() || item && typeof item === 'object' && configured(item));
      if (configured(JSON.parse(text))) problems.push('configured_credential_json');
    } catch { /* A source fragment is not necessarily a JSON document. */ }
  }
  if (!notice && (/^[ \t]*(?:(?:\/\/|\/\*|\*)[ \t]*)?PolyForm[^\r\n]*License[ \t]*$/im.test(text) || [...text.matchAll(/^[ \t]*(?:(?:\/\/|\/\*|\*)[ \t]*)?SPDX-License-Identifier:[ \t]*([^\r\n*]+)/gim)].some(match => !/\bMIT\b/.test(match[1])))) problems.push('non_mit_source_notice');
  if (svg && (/<\s*(?:script|foreignObject|image|use)\b|\son[a-z]+\s*=|(?:href|src)\s*=|url\s*\(|<!ENTITY|<!DOCTYPE/i.test(text))) problems.push('non_neutral_svg_reference');
  return problems;
}

export function sanitizedPackage(source, paths) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.version !== 'string' || !source.dependencies || !source.devDependencies) throw Error('Reviewed package.json must retain version and dependency maps');
  for (const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) if (source[field] !== undefined) {
    if (typeof source[field] !== 'object' || Array.isArray(source[field]) || !source[field] || Object.values(source[field]).some(spec => typeof spec !== 'string' || /^(?:file:|link:|portal:|workspace:|git\+ssh:|ssh:|\.{1,2}[\\/]|[\\/]|[a-z]:)/i.test(spec) || /https?:\/\/[^/\s@]+@/i.test(spec))) throw Error('Public dependencies require portable, uncredentialed references');
  }
  const result = {...source, name:'capri-companion-core', private:false, license:'MIT', description:'An extensible desktop companion core with neutral generated visuals', author:'Capri Companion Core contributors'};
  for (const key of ['repository','homepage','bugs','funding','publishConfig','workspaces','config','files','bin']) delete result[key];
  result.scripts = {build:'node scripts/public-build.mjs', check:'node node_modules/typescript/bin/tsc --noEmit'};
  if ([...paths].some(file => file.startsWith('tests/'))) result.scripts.test = 'node scripts/public-test.mjs';
  if (source.devDependencies.electron || source.dependencies.electron) { result.scripts.start = 'electron .'; result.scripts.dev = 'node scripts/public-build.mjs && electron .'; }
  if (paths.has('src/server/cloud.ts')) result.scripts.server = 'node dist/cloud.cjs';
  if (paths.has('tools/coordinator/cli.ts')) result.scripts.coordinator = 'node --import tsx tools/coordinator/cli.ts';
  if (source.build) result.build = {appId:'org.capri.companion.core',productName:'Capri Companion Core',directories:{output:'release'},files:['dist/**/*','package.json'],asarUnpack:['node_modules/sql.js/dist/*.wasm'],win:{target:'nsis',signExecutable:false},nsis:{oneClick:false,allowToChangeInstallationDirectory:true}};
  return result;
}

function objectValues(value) { return value && typeof value === 'object' ? Object.entries(value) : []; }

export function publicCoordinatorConfig() {
  return {version:1,repo:'.',developmentRoot:'..',stateDir:'../capri-core-runtime/coordinator',worktreeRoot:'../capri-core-worktrees',profileRoot:'../capri-core-profiles',referenceRoot:'../references/mit-reference-not-included',candidateBranch:'codex/candidate',tasksFile:'development/tasks.json',prompts:{master:'development/prompts/master.md',codex:'development/prompts/codex.md',claude:'development/prompts/claude.md',review:'development/prompts/review.md'},checks:[{id:'typecheck',command:'node',args:['node_modules/typescript/bin/tsc','--noEmit']},{id:'test',command:'node',args:['scripts/public-test.mjs'],timeoutMs:1200000},{id:'build',command:'node',args:['scripts/public-build.mjs']}],agents:{codex:{command:'codex'},claude:{command:'claude'}},continuous:false,timeoutMs:3600000,maxRepairAttempts:1,pollMs:30000,maxProposalsPerCycle:2,maxQueuedTasks:12,proposalAllowedPaths:['src/','tests/'],operatorAllowedPaths:['src/','tests/'],roadmapFile:'development/ROADMAP.md'};
}
