// npm run build:contracts [-- --e2e]: builds the four Stylus contracts and checks the size limit.
import { buildContracts, MAX_CODE_SIZE } from './lib/stylus.ts';

for (const { name, code } of buildContracts({ e2e: process.argv.includes('--e2e') })) {
  console.log(`${name.padEnd(9)} ${String(code.length).padStart(6)} bytes (limit ${MAX_CODE_SIZE})`);
}
