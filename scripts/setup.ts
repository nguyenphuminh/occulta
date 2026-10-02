// npm run setup: builds everything generated from the circuits, then installs the git hooks.
//   circuits -> Groth16 setup -> proving artifacts + Rust verifying keys -> contract test fixtures
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './lib/devnode.ts';

const tools: [string, string][] = [
  ['circom', 'circom'],
  ['cargo', 'Rust (cargo)'],
  ['wasm-tools', 'wasm-tools'],
];
const missing = tools.filter(([bin]) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
});
const files: [string, string][] = [
  [join(homedir(), '.local/share/occulta-tools/nitro-rootfs/usr/local/bin/nitro'), 'Nitro dev-node binary'],
  [join(homedir(), '.local/share/occulta-tools/ptau/ppot_0080_17.ptau'), 'powers of tau'],
];
const absent = [...missing.map(([, name]) => name), ...files.filter(([path]) => !existsSync(path)).map(([, name]) => name)];
if (absent.length) {
  console.error(`missing: ${absent.join(', ')}\nrun: bash scripts/setup-tools.sh && source scripts/env.sh`);
  process.exit(1);
}

const run = (label: string, args: string[]) => {
  console.log(`\n== ${label}`);
  execFileSync('node', args, { cwd: REPO, stdio: 'inherit' });
};
run('circuits and Groth16 setup', ['circuits/scripts/build.ts', ...process.argv.slice(2)]);
run('contract test fixtures (real proofs)', ['contracts/scripts/fixtures.ts']);
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: REPO });
console.log('\ngit hooks installed (.githooks): pre-commit runs affected fast tests, pre-push runs all affected tests');
