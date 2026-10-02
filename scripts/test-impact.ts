// npm run test:impact [-- --staged] [--base <ref>] [--fast] [--dry-run]
// Impact testing: finds the files changed since <ref> (default: where this branch left main, plus
// uncommitted and untracked work; --staged: only what is staged) and runs every test tier those
// files can affect, following the dependencies between packages.
import { execFileSync } from 'node:child_process';
import { REPO } from './lib/devnode.ts';
import { TIERS, runTiers, type Tier } from './test-all.ts';

const ALL = [...TIERS];
const DOWNSTREAM_OF_FRAMEWORK: Tier[] = ['framework', 'desktop', 'web', 'integration', 'ui'];

// Ordered: the first matching rule decides. Every changed TypeScript file also triggers lint and typecheck.
const RULES: [RegExp, Tier[]][] = [
  [/^circuits\/src\//, ['circuits', 'contracts', 'integration', 'ui']],
  [/^circuits\//, ['circuits']],
  [/^contracts\//, ['contracts-lint', 'contracts', 'integration', 'ui']],
  [/^packages\/framework\/src\/shared\/protocol\//, ['circuits', 'contracts', ...DOWNSTREAM_OF_FRAMEWORK]],
  [/^packages\/framework\//, DOWNSTREAM_OF_FRAMEWORK],
  [/^apps\/desktop\//, ['desktop', 'integration', 'ui']],
  [/^apps\/web\//, ['web', 'ui']],
  [/^e2e\/integration\//, ['integration']],
  [/^e2e\/contracts\//, ['integration', 'ui']],
  [/^e2e\/lib\//, ['integration', 'ui']],
  [/^e2e\//, ['ui']],
  [/^scripts\//, ['integration', 'ui']],
  [/^(package(-lock)?\.json|tsconfig\.base\.json|eslint\.config\.js|vitest\.config\.ts)$/, ALL],
];

const git = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function changedFiles(): string[] {
  if (process.argv.includes('--staged')) return git('diff', '--name-only', '--cached');
  const base = option('base') ?? git('merge-base', 'HEAD', 'main')[0] ?? 'HEAD';
  return [...new Set([...git('diff', '--name-only', base), ...git('ls-files', '--others', '--exclude-standard')])];
}

export function affectedTiers(files: readonly string[]): Tier[] {
  const tiers = new Set<Tier>();
  for (const file of files) {
    if (/\.(ts|tsx|js|mjs)$/.test(file)) {
      tiers.add('lint');
      tiers.add('typecheck');
    }
    const rule = RULES.find(([pattern]) => pattern.test(file));
    for (const tier of rule?.[1] ?? []) tiers.add(tier);
  }
  return TIERS.filter((t) => tiers.has(t));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = changedFiles();
  let tiers = affectedTiers(files);
  if (process.argv.includes('--fast')) tiers = tiers.filter((t) => t !== 'integration' && t !== 'ui');
  console.log(`${files.length} changed file(s) -> tiers: ${tiers.join(', ') || 'none'}`);
  if (process.argv.includes('--dry-run') || tiers.length === 0) process.exit(0);
  const circuitsChanged = files.some((f) => f.startsWith('circuits/src/'));
  process.exit(runTiers(tiers, { rebuild: circuitsChanged }) ? 0 : 1);
}
