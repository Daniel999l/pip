// Compiles contracts/Brain.sol with solc (npm) and writes contracts/Brain.json { abi, bytecode }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));

export function compileBrain() {
  const src = fs.readFileSync(path.join(here, 'Brain.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'Brain.sol': { content: src } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  for (const w of out.errors || []) if (w.severity !== 'error') console.warn(w.formattedMessage);
  const C = out.contracts['Brain.sol'].Brain;
  return {
    contractName: 'Brain',
    compiler: solc.version(),
    abi: C.abi,
    bytecode: '0x' + C.evm.bytecode.object,
    deployedBytecode: '0x' + C.evm.deployedBytecode.object,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const art = compileBrain();
  fs.writeFileSync(path.join(here, 'Brain.json'), JSON.stringify(art, null, 2) + '\n');
  console.log(`wrote contracts/Brain.json (solc ${art.compiler}, runtime ${(art.deployedBytecode.length - 2) / 2} bytes)`);
}
