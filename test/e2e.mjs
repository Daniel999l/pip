// Local end-to-end test for the Wren backend.
// Starts a local chain (Hardhat node, chain id 4663) if none is running, deploys MockToken + Brain,
// starts server/index.js with scripts/local/local.env values in its environment and checks the API,
// the teacher loop, burn-to-teach, low balance pause, restart backfill and RPC outage resilience.
//
// Usage:
//   node test/e2e.mjs            in-memory store (no MONGODB_URI)
//   node test/e2e.mjs --mongo    Mongo store (needs TEST_MONGODB_URI)
//   node test/e2e.mjs --both     both runs, one after the other
// Exit code is non-zero when any check fails.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, parseUnits, parseEther, formatEther, toUtf8Bytes, toUtf8String, zeroPadValue } from 'ethers';
import { startNode } from '../scripts/local/node.mjs';
import { setup, readLocalEnv, waitForBrainJson, DEV_KEYS, DEAD, RPC_URL } from '../scripts/local/setup.mjs';
import { teachMessage, cleanText } from '../server/text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const RUN_DIR = path.join(here, '.run');
const LOG_DIR = path.join(here, '.logs');
fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
// Empty dotenv file: server/config.js imports 'dotenv/config'; point it here so no real .env is ever loaded.
const EMPTY_DOTENV = path.join(RUN_DIR, 'empty.env');
fs.writeFileSync(EMPTY_DOTENV, '');

const PORT = Number(process.env.E2E_PORT || 3999);
const API = `http://127.0.0.1:${PORT}`;
const SENTENCE = 'the little bird sang a happy song in the tree.';
const MIN_BALANCE_ETH = 0.0003; // server default
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s || '').toLowerCase();

// ---------- results ----------
const results = [];
let mode = 'memory';
function record(name, ok, detail = '') {
  const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  results.push({ mode, name, status, detail });
  console.log(`  ${status}  [${mode}] ${name}${detail ? '  -- ' + detail : ''}`);
  return ok;
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === null) return record(name, null, 'skipped');
    if (typeof r === 'string') return record(name, true, r);
    return record(name, r !== false, r === false ? 'returned false' : '');
  } catch (e) {
    return record(name, false, e && e.message ? e.message : String(e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- http ----------
async function http(method, p, body, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(API + p, {
      method, signal: ac.signal,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p) => http('GET', p);
// POST /api/teach is rate limited (10/min per IP); wait out 429s so every check gets a real answer.
let rateLimitWaits = 0;
async function post(p, b) {
  for (let i = 0; i < 8; i++) {
    const r = await http('POST', p, b);
    if (r.status !== 429) return r;
    rateLimitWaits++;
    await sleep(10000);
  }
  return http('POST', p, b);
}
async function waitFor(desc, fn, timeoutMs, everyMs = 1000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${desc}` + (last instanceof Error ? ` (last error: ${last.message})` : ''));
}

// ---------- processes ----------
function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
  });
}
async function rpcAlive() {
  try {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return (await r.json()).result;
  } catch { return null; }
}

let nodeProc = null;
let nodeOwned = false;
async function ensureNode() {
  const id = await rpcAlive();
  if (id) { nodeOwned = false; console.log(`[e2e] using already running node at ${RPC_URL} (chain ${parseInt(id, 16)})`); return; }
  const out = fs.openSync(path.join(LOG_DIR, `node-${mode}.log`), 'a');
  nodeProc = startNode({ stdio: ['ignore', out, out] });
  nodeOwned = true;
  await waitFor('local node', rpcAlive, 60000, 500);
  console.log(`[e2e] started local node (pid ${nodeProc.pid})`);
}
async function stopNode() {
  if (!nodeProc) return;
  const p = nodeProc;
  nodeProc = null;
  p.kill('SIGKILL');
  await waitFor('node port to close', async () => !(await portOpen(8545)), 20000, 300).catch(() => {});
}

let server = null;
let serverLogPath = null;
let serverRun = 0;
function startServer(extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ['MONGODB_URI', 'MONGODB_DB', 'TOKEN_ADDRESS', 'BRAIN_ADDRESS', 'TEACHER_PRIVATE_KEY', 'RPC_URL', 'CHAIN_ID']) delete env[k];
  Object.assign(env, readLocalEnv(), { PORT: String(PORT), DOTENV_CONFIG_PATH: EMPTY_DOTENV, DOTENV_CONFIG_QUIET: 'true' }, extraEnv);
  serverRun += 1;
  serverLogPath = path.join(LOG_DIR, `server-${mode}-${serverRun}.log`);
  const out = fs.openSync(serverLogPath, 'w');
  const p = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: RUN_DIR, env, stdio: ['ignore', out, out] });
  p.exited = false;
  p.on('exit', (code, sig) => { p.exited = true; p.exitInfo = { code, sig }; });
  server = p;
  return p;
}
async function waitServerUp(timeoutMs = 30000) {
  await waitFor('server /api/config', async () => {
    if (server.exited) throw new Error(`server exited ${JSON.stringify(server.exitInfo)}; log ${serverLogPath}:\n${tail(serverLogPath)}`);
    const r = await get('/api/config');
    return r.status === 200 && r.json;
  }, timeoutMs, 500);
}
async function stopServer() {
  if (!server) return;
  const p = server;
  server = null;
  if (!p.exited) {
    p.kill('SIGTERM');
    const t0 = Date.now();
    while (!p.exited && Date.now() - t0 < 8000) await sleep(100);
    if (!p.exited) p.kill('SIGKILL');
  }
  await waitFor('server port to close', async () => !(await portOpen(PORT)), 10000, 200).catch(() => {});
}
function tail(file, n = 30) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; }
}

// ---------- chain helpers ----------
function provider() {
  return new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 200 });
}
// Sign the server's exact teach message with the burner's key, then POST /api/teach.
async function teach(txHash, text, key = DEV_KEYS[2]) {
  const msg = teachMessage(String(txHash), cleanText(text));
  const signature = await new Wallet(key).signMessage(msg);
  return post('/api/teach', { txHash, text, signature });
}
async function burnFrom(dep, amountTokens, to = DEAD) {
  const p = provider();
  try {
    const w = new Wallet(DEV_KEYS[2], p);
    const token = new Contract(dep.tokenAddress, dep.tokenAbi, w);
    const tx = await token.transfer(to, parseUnits(String(amountTokens), 18));
    const rc = await tx.wait();
    return { hash: tx.hash, receipt: rc };
  } finally { p.destroy(); }
}
async function chainLessons(dep) {
  const p = provider();
  try { return Number(await new Contract(dep.brainAddress, dep.abi, p).lessons()); } finally { p.destroy(); }
}
async function setBalance(addr, wei) {
  const p = provider();
  const hex = '0x' + BigInt(wei).toString(16);
  try { await p.send('anvil_setBalance', [addr, hex]).catch(() => p.send('hardhat_setBalance', [addr, hex])); } finally { p.destroy(); }
}
async function getLessons(limit = 100) {
  const r = await get(`/api/lessons?limit=${limit}`);
  assert(r.status === 200 && r.json && Array.isArray(r.json.items), `/api/lessons bad response ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.items;
}
async function getState() {
  const r = await get('/api/state');
  assert(r.status === 200 && r.json, `/api/state bad response ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

// ---------- the suite ----------
async function runSuite(runMode) {
  mode = runMode;
  serverRun = 0;
  console.log(`\n========== e2e run: ${mode} store ==========`);
  let mongo = null;
  let mongoUri = null;
  if (mode === 'mongo') {
    mongoUri = process.env.TEST_MONGODB_URI;
    if (!mongoUri) throw new Error('set TEST_MONGODB_URI to a test Mongo to run the --mongo suite');
    console.log('[e2e] using TEST_MONGODB_URI');
  }
  const dbName = `pip_e2e_${Date.now()}`;
  const storeEnv = mongoUri ? { MONGODB_URI: mongoUri, MONGODB_DB: dbName } : {};

  try {
    await ensureNode();
    const dep = await setup({ mongoUri, log: (m) => console.log(m) });
    const holderL = lc(dep.holder);

    // ---- node + setup sanity ----
    await check('local node chain id is 4663', async () => {
      const p = provider();
      try { const n = await p.getNetwork(); assert(Number(n.chainId) === 4663, `chain id ${n.chainId}`); const b = await p.getBlock('latest'); assert(b.gasLimit === 32_000_000n, `gasLimit ${b.gasLimit}`); return `gasLimit ${b.gasLimit}`; } finally { p.destroy(); }
    });
    await check('Brain deployed with teacher = dev account #1', async () => {
      const p = provider();
      try {
        const b = new Contract(dep.brainAddress, dep.abi, p);
        const t = await b.teacher();
        assert(lc(t) === lc(dep.teacher), `teacher() = ${t}`);
        assert(Number(await b.lessons()) === 0, 'lessons not 0');
        const s = await b.speak(toUtf8Bytes('the'), 40, 7, 2048);
        return `speak: "${String(s).slice(0, 40)}"`;
      } finally { p.destroy(); }
    });

    // ---- server boot ----
    startServer(storeEnv);
    await waitServerUp();
    record('server starts', true, `log ${path.relative(root, serverLogPath)}`);

    await check('GET /api/config has deployed addresses', async () => {
      const c = (await get('/api/config')).json;
      assert(lc(c.tokenAddress) === lc(dep.tokenAddress), `tokenAddress ${c.tokenAddress}`);
      assert(lc(c.brainAddress) === lc(dep.brainAddress), `brainAddress ${c.brainAddress}`);
      assert(Number(c.chainId) === 4663, `chainId ${c.chainId}`);
      assert(Number(c.burnPerLesson) === 100000, `burnPerLesson ${c.burnPerLesson}`);
      assert(lc(c.deadAddress) === lc(DEAD), `deadAddress ${c.deadAddress}`);
      assert(c.explorer === 'http://localhost', `explorer ${c.explorer}`);
      assert(typeof c.buyUrl === 'string' && c.buyUrl.includes(dep.tokenAddress), `buyUrl ${c.buyUrl}`);
      for (const k of ['name', 'ticker', 'xUrl', 'lessonChars', 'maxSentence']) assert(k in c, `missing ${k}`);
      return true;
    });
    await check('GET /api/state deployed:true with all fields', async () => {
      const s = await getState();
      assert(s.deployed === true, `deployed ${s.deployed}`);
      for (const k of ['lessons', 'examplesSeen', 'level', 'brainBalanceEth', 'avgLessonCostEth', 'lessonsLeft', 'queueLength', 'nextLessonInSec', 'teaching']) assert(k in s, `missing ${k}`);
      assert(typeof s.level === 'number' && s.level >= 0 && s.level <= 1, `level ${s.level}`);
      assert(typeof s.brainBalanceEth === 'string', `brainBalanceEth should be a string, got ${typeof s.brainBalanceEth}`);
      assert(typeof s.teaching === 'boolean', `teaching ${s.teaching}`);
      return `level ${s.level}, balance ${s.brainBalanceEth}`;
    });
    await check('GET /api/speak returns text', async () => {
      const r = await get('/api/speak?seed=3&prompt=the&n=60');
      assert(r.status === 200 && r.json, `status ${r.status} ${r.text.slice(0, 200)}`);
      assert(typeof r.json.text === 'string' && r.json.text.length > 0, `text ${JSON.stringify(r.json.text)}`);
      assert('lesson' in r.json, 'missing lesson');
      return `"${r.json.text.slice(0, 40)}" (lesson ${r.json.lesson})`;
    });
    await check('GET /api/speak rejects or clamps n > 160', async () => {
      const r = await get('/api/speak?seed=4&n=500');
      if (r.status !== 200) return `status ${r.status}`;
      assert(typeof r.json.text === 'string' && r.json.text.length <= 160 + 10, `returned ${r.json.text.length} chars`);
      return `clamped to ${r.json.text.length} chars`;
    });
    await check('timeline has lesson-0 snapshot', async () => {
      const items = await waitFor('lesson 0 snapshot', async () => {
        const r = await get('/api/timeline');
        const it = r.json && r.json.items;
        return Array.isArray(it) && it.some((x) => Number(x.lesson) === 0) ? it : null;
      }, 30000);
      const s0 = items.find((x) => Number(x.lesson) === 0);
      assert(typeof s0.text === 'string' && s0.text.length > 0, 'empty text');
      assert(typeof s0.level === 'number', 'level not a number');
      assert(s0.at, 'missing at');
      return `"${s0.text.slice(0, 30)}"`;
    });

    // ---- teacher loop: book lessons ----
    await check('teacher sends book lessons on its own', async () => {
      const items = await waitFor('2 lessons', async () => { const l = await getLessons(); return l.length >= 2 ? l : null; }, 60000);
      const s = await getState();
      assert(s.lessons >= 2, `state.lessons ${s.lessons}`);
      const onChain = await chainLessons(dep);
      assert(onChain >= 2, `chain lessons ${onChain}`);
      for (const it of items) {
        assert(it.source === 'book', `lesson ${it.n} source ${it.source}`);
        assert(/^0x[0-9a-f]{64}$/i.test(it.txHash), `lesson ${it.n} txHash ${it.txHash}`);
        assert(typeof it.gasUsed === 'number' && it.gasUsed > 21000, `lesson ${it.n} gasUsed ${it.gasUsed}`);
        assert(typeof it.rightChance === 'number' && it.rightChance >= 0 && it.rightChance <= 1, `lesson ${it.n} rightChance ${it.rightChance}`);
        assert(typeof it.costEth === 'string', `lesson ${it.n} costEth type ${typeof it.costEth}`);
        assert(typeof it.text === 'string' && it.text.length >= 4, `lesson ${it.n} text`);
        assert(it.at, `lesson ${it.n} missing at`);
      }
      const ns = items.map((i) => i.n);
      assert(ns.every((n, i) => i === 0 || ns[i - 1] > n), `not sorted desc: ${ns}`);
      return `${items.length} lessons, gas ${items[0].gasUsed}, right ${items[0].rightChance.toFixed(3)}`;
    });
    await check('book lessons continue the book (chunks overlap by 3 chars)', async () => {
      const items = (await getLessons()).filter((i) => i.source === 'book').sort((a, b) => a.n - b.n);
      assert(items.length >= 2, 'need 2 book lessons');
      const [a, b] = items;
      assert(b.text.startsWith(a.text.slice(-3)), `"${a.text}" then "${b.text}"`);
      return true;
    });
    await check('/api/lessons?before= pages', async () => {
      const items = await getLessons();
      const top = items[0].n;
      const r = await get(`/api/lessons?limit=1&before=${top}`);
      assert(r.json.items.length === 1 && r.json.items[0].n < top, JSON.stringify(r.json.items.map((x) => x.n)));
      return true;
    });
    await check('state reports cost and lessons left once lessons exist', async () => {
      const s = await getState();
      assert(Number(s.avgLessonCostEth) > 0, `avgLessonCostEth ${s.avgLessonCostEth}`);
      assert(Number(s.lessonsLeft) > 0, `lessonsLeft ${s.lessonsLeft}`);
      return `avg ${s.avgLessonCostEth} ETH, left ${s.lessonsLeft}`;
    });

    // ---- burn to teach ----
    const goodBurn = await burnFrom(dep, 100000);
    await check('burn transfer emits Transfer(holder -> dead, 100000e18)', async () => {
      const lg = goodBurn.receipt.logs.find((l) => lc(l.address) === lc(dep.tokenAddress));
      assert(lg, 'no token log');
      assert(lc(lg.topics[2]) === lc(zeroPadValue(DEAD, 32)), 'to is not dead');
      assert(lc(lg.topics[1]) === lc(zeroPadValue(dep.holder, 32)), 'from is not holder');
      assert(BigInt(lg.data) === parseUnits('100000', 18), `value ${lg.data}`);
      return true;
    });
    let lessonsAtPost = 0;
    let teachRes = null;
    await check('POST /api/teach with valid burn is accepted with position', async () => {
      lessonsAtPost = await chainLessons(dep);
      const r = await teach(goodBurn.hash, SENTENCE);
      teachRes = r;
      assert(r.json && r.json.ok === true, `response ${r.status} ${r.text.slice(0, 300)}`);
      assert(Number.isInteger(r.json.position) && r.json.position >= 1, `position ${r.json.position}`);
      return `position ${r.json.position}`;
    });
    await check('GET /api/queue lists the sentence (or it was already taught)', async () => {
      const r = await get('/api/queue');
      assert(r.status === 200 && Array.isArray(r.json.items), `status ${r.status}`);
      if (r.json.items.length === 0) {
        const done = (await getLessons()).some((x) => x.source === 'holder');
        assert(done, 'queue empty and no holder lesson yet');
        return 'already taught';
      }
      const it = r.json.items[0];
      assert(lc(it.by) === holderL, `by ${it.by}`);
      assert(typeof it.text === 'string' && it.text.includes('little bird'), `text ${it.text}`);
      assert(it.position === 1, `position ${it.position}`);
      return `"${it.text}"`;
    });
    await check('holder sentence is taught before more book lessons', async () => {
      const h = await waitFor('holder lesson', async () => (await getLessons()).find((x) => x.source === 'holder'), 60000);
      assert(lc(h.by) === holderL, `by ${h.by}, expected ${holderL}`);
      assert(lc(h.ref) === lc(goodBurn.hash), `ref ${h.ref}, expected burn tx ${goodBurn.hash}`);
      assert(h.text.includes('little bird sang a happy song'), `text "${h.text}"`);
      // at most one book lesson can already have been in flight when we posted
      assert(h.n <= lessonsAtPost + 2, `holder lesson n=${h.n} but chain had ${lessonsAtPost} lessons at POST time`);
      const between = (await getLessons()).filter((x) => x.n > lessonsAtPost && x.n < h.n && x.source === 'book');
      assert(between.length <= 1, `${between.length} book lessons taught before the holder sentence`);
      // on-chain event matches
      const p = provider();
      try {
        const b = new Contract(dep.brainAddress, dep.abi, p);
        const evs = await b.queryFilter(b.filters.Lesson(h.n));
        assert(evs.length === 1, `events for n ${evs.length}`);
        assert(lc(evs[0].args.by) === holderL, `event by ${evs[0].args.by}`);
        assert(lc(evs[0].args.ref) === lc(goodBurn.hash), `event ref ${evs[0].args.ref}`);
        assert(lc(evs[0].transactionHash) === lc(h.txHash), 'txHash mismatch with chain event');
      } finally { p.destroy(); }
      return `lesson ${h.n} "${h.text}"`;
    });
    await check('queue empties after the holder sentence', async () => {
      await waitFor('queue empty', async () => { const s = await getState(); return s.queueLength === 0; }, 20000);
      const r = await get('/api/queue');
      assert(r.json.items.length === 0, `queue ${r.json.items.length}`);
      return true;
    });
    await check('book lessons resume after the holder sentence', async () => {
      const h = (await getLessons()).find((x) => x.source === 'holder');
      await waitFor('book lesson after holder', async () => (await getLessons()).some((x) => x.n > h.n && x.source === 'book'), 30000);
      return true;
    });
    await check('reusing the same burn tx is rejected', async () => {
      const r = await teach(goodBurn.hash, 'the cat sat on the warm mat today.');
      assert(r.json && r.json.ok === false && typeof r.json.error === 'string' && r.json.error.length > 3, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('a too small burn (1 token) is rejected with a clear message', async () => {
      const b = await burnFrom(dep, 1);
      const r = await teach(b.hash, 'the dog ran to the park in the sun.');
      assert(r.json && r.json.ok === false, `response ${r.status} ${r.text.slice(0, 300)}`);
      assert(/100[,. ]?000|at least|not enough|too small|minimum/i.test(r.json.error), `message not clear about the amount: "${r.json.error}"`);
      return `"${r.json.error}"`;
    });
    await check('a non-burn token transfer is rejected', async () => {
      const b = await burnFrom(dep, 100000, new Wallet(DEV_KEYS[3]).address);
      const r = await teach(b.hash, 'the dog ran to the park in the sun.');
      assert(r.json && r.json.ok === false && r.json.error, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('a plain ETH transfer is rejected', async () => {
      const p = provider();
      let hash;
      try { const tx = await new Wallet(DEV_KEYS[2], p).sendTransaction({ to: DEAD, value: 1n }); await tx.wait(); hash = tx.hash; } finally { p.destroy(); }
      const r = await teach(hash, 'the dog ran to the park in the sun.');
      assert(r.json && r.json.ok === false && r.json.error, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('an unknown / malformed tx hash is rejected', async () => {
      const r1 = await teach('0x' + '12'.repeat(32), 'the dog ran to the park in the sun.');
      assert(r1.json && r1.json.ok === false && r1.json.error, `unknown: ${r1.status} ${r1.text.slice(0, 200)}`);
      const r2 = await teach('hello', 'the dog ran to the park in the sun.');
      assert(r2.json && r2.json.ok === false && r2.json.error, `malformed: ${r2.status} ${r2.text.slice(0, 200)}`);
      return `"${r1.json.error}" / "${r2.json.error}"`;
    });
    // A fresh valid burn for each text check, so the text rule is what rejects it.
    let spareBurn = await burnFrom(dep, 100000);
    await check('a blocked word is rejected', async () => {
      const r = await teach(spareBurn.hash, 'the bird said shit in the tree today.');
      assert(r.json && r.json.ok === false && r.json.error, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('text too short is rejected', async () => {
      const r = await teach(spareBurn.hash, 'hi');
      assert(r.json && r.json.ok === false && r.json.error, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('text too long (> MAX_SENTENCE) is rejected', async () => {
      const r = await teach(spareBurn.hash, 'the bird sang. '.repeat(20));
      assert(r.json && r.json.ok === false && r.json.error, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('someone else signing a real burn is rejected', async () => {
      const r = await teach(spareBurn.hash, 'the fox ran fast over the green hill.', DEV_KEYS[3]);
      assert(r.json && r.json.ok === false && /only the wallet that made this burn/i.test(r.json.error), `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('a burn without a signature is rejected', async () => {
      const r = await post('/api/teach', { txHash: spareBurn.hash, text: 'the fox ran fast over the green hill.' });
      assert(r.json && r.json.ok === false && /sign/i.test(r.json.error), `response ${r.status} ${r.text.slice(0, 300)}`);
      return `"${r.json.error}"`;
    });
    await check('a burn rejected for bad text can still be used with good text', async () => {
      const r = await teach(spareBurn.hash, 'the fox ran fast over the green hill.');
      assert(r.json && r.json.ok === true, `response ${r.status} ${r.text.slice(0, 300)}`);
      return `position ${r.json.position}`;
    });
    await check('missing body fields are rejected without a crash', async () => {
      const r = await post('/api/teach', {});
      assert(r.status < 500 && r.json && r.json.ok === false, `response ${r.status} ${r.text.slice(0, 200)}`);
      return `"${r.json.error}"`;
    });

    // ---- low teacher balance ----
    await check('low teacher balance pauses teaching and state shows it', async () => {
      await waitFor('queue empty', async () => (await getState()).queueLength === 0, 30000);
      await setBalance(dep.teacher, parseEther('0.0001'));
      // let any in-flight lesson finish and the server's 15s balance cache expire
      await sleep(18000);
      const s1 = await getState();
      assert(Number(s1.brainBalanceEth) < MIN_BALANCE_ETH, `state.brainBalanceEth still ${s1.brainBalanceEth} 18s after draining`);
      const before = await chainLessons(dep);
      await sleep(12000);
      const after = await chainLessons(dep);
      assert(after === before, `lessons went ${before} -> ${after} while balance low`);
      const s2 = await getState();
      assert(s2.teaching === false, `state.teaching ${s2.teaching} while paused`);
      return `balance ${s2.brainBalanceEth}, teaching ${s2.teaching}, lessonsLeft ${s2.lessonsLeft}, chain lessons flat at ${after}`;
    });
    await check('teaching resumes after refill', async () => {
      const before = await chainLessons(dep);
      await setBalance(dep.teacher, parseEther('10'));
      await waitFor('lessons to rise after refill', async () => (await chainLessons(dep)) > before, 60000);
      const s = await getState();
      assert(Number(s.brainBalanceEth) > 1, `balance ${s.brainBalanceEth}`);
      assert(Number(s.lessonsLeft) > 0, `lessonsLeft ${s.lessonsLeft}`);
      return `lessons ${before} -> ${await chainLessons(dep)}`;
    });

    // ---- restart with empty store: backfill from chain ----
    await check('restart with empty store backfills lessons from chain events', async () => {
      const beforeItems = await getLessons(200);
      await stopServer();
      const onChain = await chainLessons(dep);
      startServer(mongoUri ? { MONGODB_URI: mongoUri, MONGODB_DB: dbName + '_fresh' } : {});
      await waitServerUp();
      const items = await waitFor(`${onChain} lessons backfilled`, async () => {
        const l = await getLessons(200);
        return l.length >= onChain ? l : null;
      }, 60000);
      const byN = new Map(items.map((x) => [x.n, x]));
      assert(byN.size >= onChain, `only ${byN.size} distinct lessons for ${onChain} on chain`);
      for (const old of beforeItems) {
        const nw = byN.get(old.n);
        assert(nw, `lesson ${old.n} missing`);
        assert(lc(nw.txHash) === lc(old.txHash), `lesson ${old.n} txHash differs`);
        assert(nw.source === old.source, `lesson ${old.n} source ${nw.source} vs ${old.source}`);
        assert(nw.text === old.text, `lesson ${old.n} text "${nw.text}" vs "${old.text}"`);
        assert(lc(nw.by) === lc(old.by), `lesson ${old.n} by ${nw.by} vs ${old.by}`);
        assert(nw.gasUsed === old.gasUsed, `lesson ${old.n} gasUsed ${nw.gasUsed} vs ${old.gasUsed}`);
        assert(Math.abs(nw.rightChance - old.rightChance) < 1e-9, `lesson ${old.n} rightChance differs`);
      }
      assert(items.some((x) => x.source === 'holder' && lc(x.ref) === lc(goodBurn.hash) && lc(x.by) === holderL), 'holder lesson for the first burn lost');
      return `${items.length} lessons restored`;
    });
    await check('after restart the burn tx cannot be reused (checked on chain)', async () => {
      const r = await teach(goodBurn.hash, 'the cat sat on the warm mat today.');
      assert(r.json && r.json.ok === false, `accepted again after restart: ${r.text.slice(0, 200)}`);
      return `"${r.json.error}"`;
    });
    await check('after restart book teaching continues where it left off', async () => {
      const items = await getLessons(200);
      const lastBook = items.filter((x) => x.source === 'book').sort((a, b) => b.n - a.n)[0];
      const top = items[0].n;
      const next = await waitFor('new lesson after restart', async () => (await getLessons(5)).find((x) => x.n > top), 60000);
      if (next.source !== 'book') return `next was ${next.source}`;
      assert(next.text.startsWith(lastBook.text.slice(-3)) && next.text !== lastBook.text, `last book "${lastBook.text}", next "${next.text}"`);
      return true;
    });

    // ---- RPC outage resilience ----
    if (!nodeOwned) {
      record('server survives the chain node going down', null, 'node was started outside the test');
    } else {
      await check('server survives the chain node going down', async () => {
        await stopNode();
        await sleep(12000);
        assert(!server.exited, `server exited ${JSON.stringify(server.exitInfo)}\n${tail(serverLogPath)}`);
        const results = {};
        for (const p of ['/api/config', '/api/state', '/api/lessons', '/api/timeline', '/api/queue', '/api/speak?seed=99']) {
          const r = await http('GET', p, null, 30000).catch((e) => ({ status: 'ERR ' + e.message }));
          results[p] = r.status;
        }
        const t = await teach('0x' + 'ab'.repeat(32), 'the dog ran to the park in the sun.').catch((e) => ({ status: 'ERR ' + e.message }));
        results['POST /api/teach'] = t.status;
        assert(!server.exited, `server exited during requests\n${tail(serverLogPath)}`);
        const bad = Object.entries(results).filter(([, s]) => typeof s !== 'number');
        assert(bad.length === 0, `no HTTP answer: ${JSON.stringify(bad)}`);
        assert(results['/api/config'] === 200, `/api/config ${results['/api/config']}`);
        return JSON.stringify(results);
      });
      await check('server keeps working after the node comes back', async () => {
        await ensureNode();
        await sleep(3000);
        assert(!server.exited, `server exited\n${tail(serverLogPath)}`);
        const s = await getState();
        assert(typeof s.deployed === 'boolean', 'state broken');
        const c = await get('/api/config');
        assert(c.status === 200, `/api/config ${c.status}`);
        return `state deployed=${s.deployed} lessons=${s.lessons}`;
      });
      await check('teacher resumes after the chain is reset and Brain redeployed at the same address', async () => {
        const dep2 = await setup({ mongoUri, log: () => {} });
        assert(lc(dep2.brainAddress) === lc(dep.brainAddress), `address changed ${dep2.brainAddress}`);
        await waitFor('a lesson on the new chain', async () => (await chainLessons(dep2)) > 0, 200000, 2000);
        assert(!server.exited, 'server exited');
        return `chain lessons ${await chainLessons(dep2)}`;
      });
    }
    await check('server process never crashed', async () => {
      assert(server && !server.exited, `server exited ${JSON.stringify(server && server.exitInfo)}`);
      const log = fs.readFileSync(serverLogPath, 'utf8');
      assert(!/Unhandled|uncaughtException|UnhandledPromiseRejection/i.test(log), 'unhandled error in log');
      return true;
    });
  } catch (e) {
    record('suite aborted', false, (e && e.stack) || String(e));
    if (serverLogPath) console.log(`--- last server log lines (${serverLogPath}) ---\n${tail(serverLogPath, 40)}`);
  } finally {
    await stopServer();
    if (nodeOwned) await stopNode();
    if (mongo) await mongo.stop().catch(() => {});
  }
}

// ---------- main ----------
const args = process.argv.slice(2);
const modes = args.includes('--both') ? ['memory', 'mongo'] : args.includes('--mongo') ? ['mongo'] : ['memory'];

for (const f of [path.join(root, 'server', 'index.js')]) {
  if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(2); }
}
await waitForBrainJson({ timeoutMs: 10_000 }).catch((e) => { console.error(e.message); process.exit(2); });

const cleanup = async () => { await stopServer(); if (nodeOwned) await stopNode(); process.exit(130); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

for (const m of modes) await runSuite(m);

console.log('\n================ RESULTS ================');
for (const r of results) console.log(`${r.status.padEnd(4)}  [${r.mode}] ${r.name}${r.status === 'FAIL' ? '\n        ' + r.detail.split('\n').join('\n        ') : ''}`);
const fails = results.filter((r) => r.status === 'FAIL').length;
const passes = results.filter((r) => r.status === 'PASS').length;
const skips = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n${passes} passed, ${fails} failed, ${skips} skipped`);
process.exit(fails ? 1 : 0);
