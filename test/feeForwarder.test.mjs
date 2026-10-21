import assert from 'node:assert/strict';
import { parseEther, formatEther } from 'ethers';
import { createForwarder } from '../server/feeForwarder.js';

const quiet = { info() {}, warn() {}, error() {} };
const GAS = parseEther('0.00001');
function setup(over = {}) {
  const w = { bal: parseEther('0.5'), sent: [] };
  const meta = new Map();
  const store = { getMeta: async (k) => meta.get(k) ?? null, setMeta: async (k, v) => { meta.set(k, v); } };
  const io = {
    getBalance: async () => w.bal,
    estimateGasCost: async () => GAS,
    send: async (amt) => { w.bal -= amt + GAS; w.sent.push(amt); return { hash: '0x' + String(w.sent.length).padStart(64, '0'), balanceAfter: w.bal }; },
  };
  const settings = { percent: 10, everySec: 300, minWei: parseEther('0.001'), reserveWei: parseEther('0.0005'), ...over };
  return { w, meta, f: createForwarder({ io, settings, store, log: quiet }) };
}
const tests = [];
const t = (n, fn) => tests.push([n, fn]);

t('first run sets baseline, forwards nothing', async () => {
  const { w, f } = setup();
  assert.equal((await f.tick()).action, 'baseline-set');
  assert.equal(w.sent.length, 0);
});
t('1 ETH inflow at 10% forwards 0.1', async () => {
  const { w, f } = setup();
  await f.tick(); w.bal += parseEther('1');
  const r = await f.tick();
  assert.equal(r.action, 'forwarded');
  assert.equal(formatEther(w.sent[0]), '0.1');
  const s = f.getStats();
  assert.equal(s.totalForwardedEth, '0.1'); assert.equal(s.history.length, 1); assert.ok(s.lastForwardAt);
  assert.equal((await f.tick()).action, 'below-min'); // baseline moved, no repeat
});
t('withdrawal resets baseline', async () => {
  const { w, f } = setup();
  await f.tick(); w.bal = parseEther('0.1');
  assert.equal((await f.tick()).action, 'baseline-reset');
  w.bal += parseEther('1');
  await f.tick();
  assert.equal(formatEther(w.sent[0]), '0.1');
});
t('dust below min is not forwarded, and accumulates', async () => {
  const { w, f } = setup();
  await f.tick(); w.bal += parseEther('0.004'); // 10% = 0.0004 < 0.001
  assert.equal((await f.tick()).action, 'below-min'); assert.equal(w.sent.length, 0);
  w.bal += parseEther('0.008'); // total 0.012 -> 0.0012
  assert.equal((await f.tick()).action, 'forwarded');
});
t('gas reserve respected', async () => {
  const { w, f } = setup({ reserveWei: parseEther('0.4') });
  w.bal = parseEther('0.5'); await f.tick(); w.bal += parseEther('0.5'); // bal 1.0, slice 0.1 fine
  w.bal = parseEther('0.5'); // reset below baseline first
  await f.tick(); w.bal += parseEther('0.0100'); // slice 0.002, leaves 0.508 ok
  assert.equal((await f.tick()).action, 'forwarded');
  const g = setup({ reserveWei: parseEther('0.6') });
  await g.f.tick(); g.w.bal += parseEther('0.1'); // 0.6 total, slice 0.02 -> 0.58 < 0.6
  assert.equal((await g.f.tick()).action, 'reserve'); assert.equal(g.w.sent.length, 0);
});
t('percent 0 does nothing', async () => {
  const { w, f } = setup({ percent: 0 });
  await f.tick(); w.bal += parseEther('5');
  assert.equal((await f.tick()).action, 'percent-zero'); assert.equal(w.sent.length, 0);
});
t('send failure keeps baseline and does not throw', async () => {
  const { w, f } = setup();
  const meta = new Map();
  const f2 = createForwarder({ io: { getBalance: async () => w.bal, estimateGasCost: async () => GAS, send: async () => { throw new Error('rpc down'); } },
    settings: { percent: 10, minWei: parseEther('0.001'), reserveWei: 0n }, store: { getMeta: async (k) => meta.get(k) ?? null, setMeta: async (k, v) => meta.set(k, v) }, log: quiet });
  await f2.tick(); w.bal += parseEther('1');
  assert.equal((await f2.tick()).action, 'error');
  assert.equal(meta.get('feeForwarder.baseline'), parseEther('0.5').toString());
});

let fail = 0;
for (const [n, fn] of tests) { try { await fn(); console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n  ' + e.message); } }
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
