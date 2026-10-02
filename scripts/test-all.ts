// npm test [-- --only a,b] [--skip c] [--fast] [--rebuild]
// Runs every test tier in dependency order and prints a summary. Tiers whose package does not
// exist yet are skipped. --fast leaves out the tiers that need the dev node or a browser.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib/devnode.ts';

export const TIERS = ['lint', 'typecheck', 'contracts-lint', 'framework', 'circuits', 'contracts', 'desktop', 'web', 'integration', 'ui'] as const;
export type Tier = (typeof TIERS)[number];
const SLOW: Tier[] = ['integration', 'ui'];

const commands: Record<Tier, { cmd: string; args: string[]; needs?: string }> = {
  lint: { cmd: 'npx', args: ['eslint', '.'] },
  typecheck: { cmd: 'npm', args: ['run', 'typecheck', '--silent'] },
  'contracts-lint': { cmd: 'sh', args: ['-c', 'cd contracts && cargo fmt --all --check && cargo clippy --workspace --all-targets -q -- -D warnings'] },
  framework: { cmd: 'npx', args: ['vitest', 'run', '--project', 'framework'] },
  circuits: { cmd: 'npx', args: ['vitest', 'run', '--project', 'circuits'] },
  contracts: { cmd: 'cargo', args: ['test', '--workspace', '-q', '--manifest-path', 'contracts/Cargo.toml'] },
  desktop: { cmd: 'npx', args: ['vitest', 'run', '--project', 'desktop'], needs: 'apps/desktop' },
  web: { cmd: 'npx', args: ['vitest', 'run', '--project', 'web'], needs: 'apps/web' },
  integration: { cmd: 'npx', args: ['vitest', 'run', '--project', 'integration'] },
  ui: { cmd: 'npx', args: ['playwright', 'test', '-c', 'e2e/playwright.config.ts'], needs: 'e2e/playwright.config.ts' },
};

function option(name: string): string[] {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
}

export function runTiers(selected: readonly Tier[], { rebuild = false } = {}): boolean {
  if (rebuild || !existsSync(join(REPO, 'circuits/build/fixtures/pool.json'))) {
    const setup = spawnSync('node', ['scripts/setup.ts'], { cwd: REPO, stdio: 'inherit' });
    if (setup.status !== 0) return false;
  }
  const results: { tier: Tier; status: string; seconds: string }[] = [];
  for (const tier of TIERS.filter((t) => selected.includes(t))) {
    const { cmd, args, needs } = commands[tier];
    if (needs && !existsSync(join(REPO, needs))) {
      results.push({ tier, status: 'skipped (not built yet)', seconds: '-' });
      continue;
    }
    console.log(`\n=== ${tier}`);
    const started = Date.now();
    const run = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
    results.push({ tier, status: run.status === 0 ? 'passed' : 'FAILED', seconds: ((Date.now() - started) / 1000).toFixed(1) });
  }
  console.log('\n tier            result                   time (s)');
  for (const r of results) console.log(` ${r.tier.padEnd(15)} ${r.status.padEnd(24)} ${r.seconds}`);
  return results.every((r) => r.status !== 'FAILED');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = option('only') as Tier[];
  const skip = option('skip') as Tier[];
  const fast = process.argv.includes('--fast');
  const selected = (only.length ? only : [...TIERS]).filter((t) => !skip.includes(t) && !(fast && SLOW.includes(t)));
  process.exit(runTiers(selected, { rebuild: process.argv.includes('--rebuild') }) ? 0 : 1);
}
