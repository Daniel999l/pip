// Compiles test/contracts/MockToken.sol with solc (npm) -> scripts/local/MockToken.json {abi, bytecode}.
// Test-only. Usage: node scripts/local/compileMock.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const srcPath = path.join(root, 'test', 'contracts', 'MockToken.sol');
export const MOCK_JSON = path.join(here, 'MockToken.json');

export function compileMock() {
  const input = {
    language: 'Solidity',
    sources: { 'MockToken.sol': { content: fs.readFileSync(srcPath, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error('MockToken compile failed:\n' + errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['MockToken.sol'].MockToken;
  const json = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  fs.writeFileSync(MOCK_JSON, JSON.stringify(json, null, 2));
  return json;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const j = compileMock();
  console.log(`MockToken compiled: ${(j.bytecode.length - 2) / 2} bytes -> ${MOCK_JSON}`);
}
