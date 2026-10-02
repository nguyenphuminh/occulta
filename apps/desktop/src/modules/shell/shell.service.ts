import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { AppError, isAppError } from '@occulta/framework';
import { COMMANDS, findCommand, runCommand, type Command, type NodeService } from '../node/index.ts';

/** Splits a shell line into words, keeping "quoted text" together. */
export function tokenize(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** Names a command's positional words after its arguments. */
export function inputOf(command: Command, words: readonly string[]): Record<string, string> {
  if (words.length > command.args.length) throw new AppError(400, 'TOO_MANY_ARGUMENTS', `${command.name} takes ${usageOf(command)}`);
  return Object.fromEntries(words.map((w, i) => [command.args[i] as string, w]));
}

function usageOf(command: Command): string {
  const shape = command.schema instanceof z.ZodObject ? (command.schema.shape as Record<string, z.ZodType>) : {};
  const args = command.args.map((a) => (shape[a]?.safeParse(undefined).success ? `[${a}]` : `<${a}>`));
  return args.length > 0 ? args.join(' ') : 'no arguments';
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => `  ${`${c.name} ${c.args.length > 0 ? usageOf(c) : ''}`.padEnd(58)}${c.summary}`);
  return ['Commands (amounts in ETH or USDG units, e.g. 0.01):', ...rows, '  help', '  exit'].join('\n');
}

export function formatError(err: unknown): string {
  if (isAppError(err)) return `error ${err.code}: ${err.message}`;
  if (err instanceof z.ZodError) return `error INVALID_INPUT: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}

/** The interactive command line of a running node (BRD 2.2.15: the user drives the node through the CLI). */
export class ShellService {
  private readonly node: NodeService;

  constructor(node: NodeService) {
    this.node = node;
  }

  /** Runs one line and returns what to print. */
  async execute(line: string): Promise<string> {
    const [name, ...words] = tokenize(line);
    if (!name) return '';
    if (name === 'help') return helpText();
    try {
      const result = await runCommand(this.node, name, inputOf(findCommand(name), words));
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return formatError(err);
    }
  }

  /** Reads commands until "exit" or the end of the input; lines run one after another. */
  run(input: Readable, output: Writable): Promise<void> {
    const rl = createInterface({ input, output, prompt: 'occulta> ' });
    let queue = Promise.resolve();
    return new Promise((resolve) => {
      rl.on('line', (line) => {
        queue = queue.then(async () => {
          if (line.trim() === 'exit') {
            rl.close();
            return;
          }
          const text = await this.execute(line);
          if (text) output.write(`${text}\n`);
          rl.prompt();
        });
      });
      rl.on('close', () => void queue.then(resolve));
      output.write('Type "help" for the list of commands.\n');
      rl.prompt();
    });
  }
}
