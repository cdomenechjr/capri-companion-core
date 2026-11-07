// Build neutral fixtures before testing; keep paths as argv rather than shell globs.
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
      else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) tests.push(path.relative(root, file));
    }
  }
  collect(path.join(root, 'tests'));
  if (!tests.length) throw Error('No public .test.ts or .test.tsx files were found');
  const child = spawnSync(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--test', '--test-concurrency=1', ...tests], {cwd:root, env:{...process.env,CAPRI_PUBLIC_BUILD:'1'}, stdio:'inherit', windowsHide:true, shell:false});
  if (child.error) throw child.error;
  if (child.signal) console.error('Public tests terminated by ' + child.signal);
  process.exitCode = child.status ?? 1;
}
