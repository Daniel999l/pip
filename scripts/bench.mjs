// Local-EVM gas + learning test for contracts/Brain.sol.
// Usage: node scripts/bench.mjs   (env STEPS=400, L=32)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes } from '@ethereumjs/util';
import { AbiCoder, Interface } from 'ethers';
import { compileBrain } from '../contracts/build.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = compileBrain();
const iface = new Interface(C.abi);

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });
const me = Address.fromString('0x1000000000000000000000000000000000000001');
const other = Address.fromString('0x2000000000000000000000000000000000000002');
for (const a of [me, other]) await vm.stateManager.putAccount(a, new Account(0n, 10n ** 24n));

const calldataGas = (hex) => { let g = 0; for (const x of hexToBytes(hex)) g += x ? 16 : 4; return g; };

const deployData = C.bytecode + AbiCoder.defaultAbiCoder().encode(['uint256', 'address'], [42, me.toString()]).slice(2);
const dep = await vm.evm.runCall({ caller: me, data: hexToBytes(deployData), gasLimit: 100_000_000n });
if (dep.execResult.exceptionError) throw dep.execResult.exceptionError;
const brain = dep.createdAddress;
console.log('runtime size:', (C.deployedBytecode.length - 2) / 2, 'bytes');
console.log('deploy gas (approx):', (Number(dep.execResult.executionGasUsed) + 53000 + calldataGas(deployData)).toLocaleString());

async function call(fn, args, from = me, gasLimit = 200_000_000n) {
  const data = iface.encodeFunctionData(fn, args);
  const r = await vm.evm.runCall({ caller: from, to: brain, data: hexToBytes(data), gasLimit });
  const gas = Number(r.execResult.executionGasUsed) + 21000 + calldataGas(data);
  if (r.execResult.exceptionError) {
    let err = r.execResult.exceptionError.error;
    try { err = iface.parseError(r.execResult.returnValue)?.name || err; } catch {}
    return { ok: false, err, gas };
  }
  return { ok: true, gas, ret: r.execResult.returnValue, logs: r.execResult.logs };
}
async function send(fn, args, from) {
  const r = await call(fn, args, from);
  if (!r.ok) throw new Error(`${fn} reverted: ${r.err}`);
  return r;
}
async function view(fn, args) {
  const r = await send(fn, args);
  return { gas: r.gas, val: iface.decodeFunctionResult(fn, r.ret)[0] };
}
const B = (s) => Buffer.from(s);
const Z = '0x' + '00'.repeat(32);
const ZA = '0x0000000000000000000000000000000000000000';

// ---------- access / bounds checks ----------
let fails = 0;
const expect = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
{
  const r1 = await call('teach', [B('hello world'), ZA, Z], other);
  expect(!r1.ok && r1.err === 'NotTeacher', 'non-teacher teach reverts (' + r1.err + ')');
  const r2 = await call('teach', [B('abc'), ZA, Z]);
  expect(!r2.ok && r2.err === 'BadLength', '3-byte lesson reverts');
  const r3 = await call('teach', [B('a'.repeat(65)), ZA, Z]);
  expect(!r3.ok && r3.err === 'BadLength', '65-byte lesson reverts');
  const r4 = await call('speak', [B('the'), 201, 1, 2048]);
  expect(!r4.ok && r4.err === 'TooLong', 'speak n=201 reverts');
  const r5 = await call('setLr', [204]);
  expect(!r5.ok && r5.err === 'BadRate', 'setLr(204) reverts');
  const r6 = await call('setLr', [4097]);
  expect(!r6.ok && r6.err === 'BadRate', 'setLr(4097) reverts');
  const r7 = await call('setLr', [1229], other);
  expect(!r7.ok && r7.err === 'NotOwner', 'non-owner setLr reverts');
  await send('setLr', [2048]);
  expect((await view('lr', [])).val === 2048n, 'owner setLr(2048) works');
  await send('setLr', [1229]);
  await send('setTeacher', [other.toString()]);
  expect((await view('teacher', [])).val.toLowerCase() === other.toString(), 'owner setTeacher works');
  const r8 = await call('teach', [B('hello world'), ZA, Z], me);
  expect(!r8.ok && r8.err === 'NotTeacher', 'old teacher can no longer teach');
  await send('setTeacher', [me.toString()]);
  const r9 = await call('transferOwnership', [ZA]);
  expect(!r9.ok && r9.err === 'ZeroAddress', 'transferOwnership(0) reverts');
  await send('transferOwnership', [other.toString()]);
  expect((await view('owner', [])).val.toLowerCase() === other.toString(), 'transferOwnership works');
  const r10 = await call('setLr', [1229], me);
  expect(!r10.ok && r10.err === 'NotOwner', 'old owner locked out');
  await send('transferOwnership', [me.toString()], other);
  const w = (await view('weights', [])).val;
  const s5 = (await view('slots', [5])).val;
  expect(w.length === 132 && w[5] === s5, 'weights() returns the 132 packed slots');
}

// ---------- corpus ----------
const bookPath = path.join(root, 'server/book/book.txt');
const corpusPath = process.env.CORPUS || (process.env.USE_BOOK && fs.existsSync(bookPath) ? bookPath : path.join(root, 'research/corpus.txt'));
const corpus = fs.readFileSync(corpusPath, 'utf8').toLowerCase().replace(/\s+/g, ' ');
const holdout = corpus.slice(0, 80);
console.log('\ncorpus:', path.relative(root, corpusPath), corpus.length, 'chars');

const sp = await view('speak', [B('the'), 40, 7, 2048]);
console.log('DAY 1 (random brain) says: "' + sp.val + '"');
console.log('score day1:', Number((await view('score', [B(holdout)])).val) / 4096);

// ---------- view gas ----------
const probe = (n) => { let s = ''; while (s.length < n) s += corpus; return s.slice(0, n); };
for (const n of [40, 80, 120, 160, 200]) {
  const r = await view('speak', [B('the'), n, 7, 2048]);
  console.log(`speak n=${n}: ${r.gas.toLocaleString()} gas (${Math.round(r.gas / n).toLocaleString()}/char)`);
}
for (const n of [80, 150, 300]) {
  const r = await view('score', [B(probe(n))]);
  console.log(`score ${n} chars: ${r.gas.toLocaleString()} gas`);
}

// ---------- lesson gas ----------
for (const L of [8, 16, 32, 48, 64]) {
  const r = await send('teach', [B(corpus.slice(100, 100 + L)), ZA, Z]);
  console.log(`lesson of ${L} chars (${L - 3} examples): ${r.gas.toLocaleString()} gas`);
}
{
  const r = await send('teach', [B(corpus.slice(0, 32)), other.toString(), '0x' + 'ab'.repeat(32)]);
  const log = r.logs[0];
  const ev = iface.parseLog({ topics: log[1].map((t) => '0x' + Buffer.from(t).toString('hex')), data: '0x' + Buffer.from(log[2]).toString('hex') });
  expect(ev.name === 'Lesson' && ev.args.by.toLowerCase() === other.toString() && ev.args.ref === '0x' + 'ab'.repeat(32)
    && Buffer.from(ev.args.text.slice(2), 'hex').toString() === corpus.slice(0, 32) && ev.args.examples === 29n,
  `Lesson event ok (n=${ev.args.n}, avgProb=${ev.args.avgTargetProbQ12})`);
}

// ---------- train ----------
const L = +(process.env.L || 32), STEPS = +(process.env.STEPS || 400);
let pos = 0, gasTot = 0;
const t0 = Date.now();
for (let s = 1; s <= STEPS; s++) {
  if (pos + L > corpus.length) pos = Math.floor(Math.random() * 20);
  const r = await send('teach', [B(corpus.slice(pos, pos + L)), ZA, Z]);
  gasTot += r.gas; pos += L - 3;
  if (s % 100 === 0 || s === 25) {
    const sc = Number((await view('score', [B(holdout)])).val) / 4096;
    const txt = (await view('speak', [B('the'), 60, s, 2048])).val;
    console.log(`\n--- after ${s} lessons (${((Date.now() - t0) / 1000).toFixed(0)}s) avg gas ${Math.round(gasTot / s).toLocaleString()} | right-letter chance ${(sc * 100).toFixed(1)}%`);
    console.log('  "' + txt + '"');
  }
}
if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
