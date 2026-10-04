// Compiles and deploys e2e/contracts/TestUSDG.sol, the dev node's stand-in for USDG.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';
import { REPO } from './devnode.ts';

interface SolcOutput {
  errors?: { severity: string; formattedMessage: string }[];
  contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
}

export function compileTestToken(): { abi: Abi; bytecode: Hex } {
  const source = readFileSync(join(REPO, 'e2e/contracts/TestUSDG.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'TestUSDG.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const contract = output.contracts['TestUSDG.sol']!['TestUSDG']!;
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

export async function deployTestToken(wallet: WalletClient, client: PublicClient): Promise<Address> {
  const { abi, bytecode } = compileTestToken();
  const hash = await wallet.deployContract({ account: wallet.account!, chain: wallet.chain, abi, bytecode });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error('test token deployment failed');
  return receipt.contractAddress;
}
