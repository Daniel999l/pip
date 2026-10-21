// Proves server/model.js is bit-exact with the Brain contract.
// Deploys contracts/Brain.json in a local EVM, teaches chunks of server/book/book.txt and at several
// points compares JS speak()/score() with the contract's own speak()/score() eth_calls.
// Run: node test/model.test.mjs   (exit code non-zero on any mismatch)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes } from '@ethereumjs/util';
import { AbiCoder, Interface, toUtf8Bytes } from 'ethers';
import { unpack, speak, score } from '../server/model.js';
import { cleanText, bookChunk } from '../server/text.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = JSON.parse(fs.readFileSync(path.join(root, 'contracts/Brain.json'), 'utf8'));
const iface = new Interface(C.abi);

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });
const me = Address.fromString('0x1000000000000000000000000000000000000001');
await vm.stateManager.putAccount(me, new Account(0n, 10n ** 24n));

const deployData = C.bytecode + AbiCoder.defaultAbiCoder().encode(['uint256', 'address'], [42, me.toString()]).slice(2);
const dep = await vm.evm.runCall({ caller: me, data: hexToBytes(deployData), gasLimit: 100_000_000n });
if (dep.execResult.exceptionError) throw dep.execResult.exceptionError;
const brain = dep.createdAddress;

async function call(fn, args, gasLimit = 1_000_000_000n) {
  const data = iface.encodeFunctionData(fn, args);
  const r = await vm.evm.runCall({ caller: me, to: brain, data: hexToBytes(data), gasLimit });
  if (r.execResult.exceptionError) {
    let err = r.execResult.exceptionError.error;
    try { err = iface.parseError(r.execResult.returnValue)?.name || err; } catch { /* raw */ }
    throw new Error(`${fn} reverted: ${err}`);
  }
  return r.execResult.returnValue;
}
const view = async (fn, args) => iface.decodeFunctionResult(fn, await call(fn, args))[0];

const book = cleanText(fs.readFileSync(path.join(root, 'server/book/book.txt'), 'utf8'));
let bookIdx = 0;
let taught = 0;
async function teachTo(target) {
  while (taught < target) {
    let t = bookChunk(book, bookIdx++, 48);
    if (t === null) { bookIdx = 0; t = bookChunk(book, bookIdx++, 48); }
    await call('teach', [toUtf8Bytes(t), '0x0000000000000000000000000000000000000000', '0x' + '00'.repeat(32)]);
    taught++;
  }
}

// deterministic pseudo random for picking cases
let rs = 12345;
const rnd = (n) => { rs = (rs * 1103515245 + 12345) % 2147483648; return rs % n; };

const PROMPTS = ['', 't', 'th', 'the', 'The little BIRD', 'pip said, ', "it's ok?", 'hello!', 'xyz.', '  ', 'café 42 ~#', 'Zebra-crossing'];
const TEMPS = [2048, 4096, 1365, 1024, 0, 3000, 8192, 819, 500];
const SEEDS = [0, 1, 7, 42, 123456789, 999999999, 2n ** 64n + 3n, 2n ** 255n + 17n];
const SCORE_TEXTS = [
  book.slice(0, 300),
  book.slice(1000, 1080),
  'the little bird sat in the tree and sang a song.',
  'abcd',
  'HELLO, World! What?',
  "pip's mother could sing. her father could sing too.",
  'zzzz qqqq xxxx ....',
];

let compared = 0, mismatches = 0;
function check(label, js, chain) {
  compared++;
  if (js !== chain) {
    mismatches++;
    if (mismatches <= 10) console.log(`MISMATCH ${label}\n  js:    ${JSON.stringify(js)}\n  chain: ${JSON.stringify(chain)}`);
  }
}

for (const stage of [0, 10, 50, 200]) {
  await teachTo(stage);
  const lessons = Number(await view('lessons', []));
  const params = unpack(await view('weights', []));
  const before = compared;
  const t0 = Date.now();

  // speak: full grid over prompts x temps on a few seeds/n, plus random combos
  const cases = [];
  for (const prompt of PROMPTS) for (const temp of TEMPS) cases.push([prompt, 1 + rnd(200), SEEDS[rnd(SEEDS.length)], temp]);
  for (const seed of SEEDS) cases.push(['the', 200, seed, 2048]);
  cases.push(['the', 0, 5, 2048], ['the', 1, 5, 2048], ['the', 120, 7, 2048]);
  for (let i = 0; i < 20; i++) cases.push([book.slice(rnd(1000), rnd(1000) + rnd(40)), 1 + rnd(200), rnd(1_000_000_000), [32, 64, 4095, 4097, 2048, 100][rnd(6)]]);
  for (const [prompt, n, seed, temp] of cases) {
    const chain = await view('speak', [toUtf8Bytes(prompt), n, seed, temp]);
    const js = speak(params, prompt, n, seed, temp);
    check(`lessons=${lessons} speak(${JSON.stringify(prompt)}, ${n}, ${seed}, ${temp})`, js, chain);
  }
  for (const text of SCORE_TEXTS) {
    const chain = Number(await view('score', [toUtf8Bytes(text)]));
    const js = score(params, text);
    check(`lessons=${lessons} score(${JSON.stringify(text.slice(0, 30))})`, js, chain);
  }
  console.log(`lessons ${lessons}: ${compared - before} comparisons (${((Date.now() - t0) / 1000).toFixed(1)}s), level ${(score(params, SCORE_TEXTS[0]) / 4096 * 100).toFixed(1)}%, says "${speak(params, 'the', 60, 7, 2048)}"`);
}

// n > 200 must be rejected like the contract
let threw = false;
try { speak(unpack(await view('weights', [])), 'the', 201, 1, 2048); } catch { threw = true; }
compared++; if (!threw) { mismatches++; console.log('MISMATCH: n=201 did not throw'); }

console.log(`\n${compared} comparisons, ${mismatches} mismatches -> ${mismatches ? 'FAILED' : 'ALL IDENTICAL'}`);
process.exit(mismatches ? 1 : 0);
