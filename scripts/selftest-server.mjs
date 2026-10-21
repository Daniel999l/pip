// Self-test for the server's pure functions: text cleaning, chunking with overlap,
// burn checks on a mocked receipt, blocklist and sentence checks. Run: node scripts/selftest-server.mjs
import assert from 'node:assert/strict';
import { parseUnits, zeroPadValue, Wallet } from 'ethers';
import { cleanText, chunkWithOverlap, bookChunk, bookChunkCount, findBurn, TRANSFER_TOPIC } from '../server/text.js';
import { isBlocked } from '../server/blocklist.js';
import { checkSentence, burnError, makeTeachHandler, makeMessageHandler } from '../server/burns.js';
import { teachMessage } from '../server/text.js';
import { isSnapshotLesson } from '../server/teacher.js';
import { MemoryStore } from '../server/store.js';

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log('ok  ', name); },
    (e) => { console.error('FAIL', name, '\n', e); process.exitCode = 1; },
  );
}

// every (3 chars -> next char) window of the original must appear in some chunk
function windows(s) { const out = []; for (let i = 0; i + 4 <= s.length; i++) out.push(s.slice(i, i + 4)); return out; }

await test('cleanText lowercases, maps unknowns to space, collapses spaces', () => {
  assert.equal(cleanText('Hello,   WORLD!!'), 'hello, world!!');
  assert.equal(cleanText('It’s 42 cafés; ok?'), "it's cafes ok?");
  assert.equal(cleanText('  tabs\tand\nlines  '), 'tabs and lines');
  assert.equal(cleanText('$$$###'), '');
  assert.equal(cleanText(null), '');
  for (const ch of cleanText('Zebra-crossing: "quick" brown fox? Yes! a.b,c\'d')) {
    assert.ok(" abcdefghijklmnopqrstuvwxyz.,'?!".includes(ch), `bad char ${ch}`);
  }
});

await test('chunkWithOverlap keeps every transition and respects 64 bytes', () => {
  const s = cleanText('the quick brown fox jumps over the lazy dog. '.repeat(3)).slice(0, 120);
  const chunks = chunkWithOverlap(s, 64);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 64 && c.length >= 4);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].slice(0, 3), chunks[i - 1].slice(-3));
  const have = new Set(chunks.flatMap(windows));
  for (const w of windows(s)) assert.ok(have.has(w), `missing window "${w}"`);
  assert.equal(chunks.join('').length - 3 * (chunks.length - 1), s.length);
  assert.deepEqual(chunkWithOverlap('short one', 64), ['short one']);
  assert.deepEqual(chunkWithOverlap('abc', 64), []);
  for (let len = 4; len <= 200; len++) {
    const t = 'abcdefghij'.repeat(20).slice(0, len);
    const cs = chunkWithOverlap(t, 64);
    const h = new Set(cs.flatMap(windows));
    for (const w of windows(t)) assert.ok(h.has(w), `len ${len} missing ${w}`);
    for (const c of cs) assert.ok(c.length <= 64 && c.length >= 4);
  }
});

await test('bookChunk steps by size-3 and covers the whole book', () => {
  const book = cleanText('there was a small bird in a big green tree. the bird was brown and small. '.repeat(5));
  const n = bookChunkCount(book, 48);
  const chunks = Array.from({ length: n }, (_, i) => bookChunk(book, i, 48));
  assert.equal(bookChunk(book, n, 48), null);
  for (const c of chunks) assert.ok(c.length <= 48 && c.length >= 4);
  for (let i = 1; i < n; i++) assert.equal(chunks[i].slice(0, 3), chunks[i - 1].slice(-3));
  const have = new Set(chunks.flatMap(windows));
  for (const w of windows(book)) assert.ok(have.has(w));
});

const TOKEN = '0x1111111111111111111111111111111111111111';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const BURNER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const topicAddr = (a) => zeroPadValue(a, 32).toLowerCase();
const transferLog = (token, from, to, value) => ({
  address: token,
  topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)],
  data: zeroPadValue('0x' + BigInt(value).toString(16), 32),
});
const minRaw = parseUnits('100000', 18);
const opts = { token: TOKEN, dead: DEAD, minRaw };

await test('findBurn accepts a big enough burn and returns the burner', () => {
  const r = findBurn({ status: 1, logs: [transferLog(TOKEN, BURNER, DEAD, minRaw)] }, opts);
  assert.equal(r.from, BURNER);
  assert.equal(r.value, minRaw);
  const r2 = findBurn({ status: 1, logs: [transferLog(TOKEN.toUpperCase().replace('0X', '0x'), BURNER, DEAD.toLowerCase(), minRaw * 3n)] }, opts);
  assert.equal(r2.from, BURNER);
});

await test('findBurn rejects small, wrong token, wrong recipient, failed, missing', () => {
  assert.equal(findBurn({ status: 1, logs: [transferLog(TOKEN, BURNER, DEAD, minRaw - 1n)] }, opts).error, 'small');
  assert.equal(findBurn({ status: 1, logs: [transferLog('0x2222222222222222222222222222222222222222', BURNER, DEAD, minRaw)] }, opts).error, 'noburn');
  assert.equal(findBurn({ status: 1, logs: [transferLog(TOKEN, BURNER, '0x0000000000000000000000000000000000000001', minRaw)] }, opts).error, 'noburn');
  assert.equal(findBurn({ status: 0, logs: [transferLog(TOKEN, BURNER, DEAD, minRaw)] }, opts).error, 'failed');
  assert.equal(findBurn(null, opts).error, 'notfound');
  const approval = { ...transferLog(TOKEN, BURNER, DEAD, minRaw), topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', topicAddr(BURNER), topicAddr(DEAD)] };
  assert.equal(findBurn({ status: 1, logs: [approval] }, opts).error, 'noburn');
});

await test('burn error messages are plain English', () => {
  const cfg = { ticker: 'PIP', burnPerLesson: 100000 };
  assert.equal(burnError('small', cfg), 'That burn is too small. Burn at least 100,000 PIP.');
  for (const c of ['notfound', 'failed', 'noburn', 'other']) assert.ok(!burnError(c, cfg).includes('—'));
});

await test('blocklist catches bad words but not normal words', () => {
  for (const bad of ['you are a bitch', 'what the fuck', 'F U C K this', 'fucking bird', 's.h.i.t happens', 'shits']) assert.ok(isBlocked(cleanText(bad)), bad);
  for (const ok of ['the cat sat on the mat', 'scunthorpe is a town', 'the cocktail party', 'class assignment', 'dickens wrote books', 'a shiitake mushroom', 'i like to grape']) assert.ok(!isBlocked(cleanText(ok)), ok);
});

await test('checkSentence enforces length, letters and blocklist', () => {
  assert.equal(checkSentence('Hello there friend!', 120).text, 'hello there friend!');
  assert.ok(checkSentence('hi', 120).error);
  assert.ok(checkSentence('...!!!???,,,', 120).error);
  assert.ok(checkSentence('a'.repeat(121), 120).error);
  assert.ok(checkSentence('shit happens all day', 120).error);
  assert.ok(checkSentence('', 120).error);
});

await test('snapshot lessons', () => {
  const want = [10, 25, 50, 100, 150, 200, 300, 400, 500, 1000];
  for (const n of want) assert.ok(isSnapshotLesson(n), n);
  for (const n of [0, 1, 11, 75, 250, 350, 401]) assert.ok(!isSnapshotLesson(n), n);
});

await test('memory store queue order, dedupe and positions', async () => {
  const s = new MemoryStore();
  const a = await s.enqueue({ burnTx: '0xAA', text: 'first one', by: BURNER, at: new Date(1000) });
  const b = await s.enqueue({ burnTx: '0xbb', text: 'second one', by: BURNER, at: new Date(2000) });
  assert.equal(a.position, 1); assert.equal(b.position, 2);
  assert.ok((await s.enqueue({ burnTx: '0xaa', text: 'again', by: BURNER, at: new Date() })).duplicate);
  assert.ok(await s.isBurnUsed('0xAa'));
  const next = await s.nextQueued();
  assert.equal(next.text, 'first one');
  await s.updateQueue(next._id, { status: 'done' });
  assert.equal((await s.nextQueued()).text, 'second one');
  assert.equal(await s.queueLength(), 1);
  assert.ok(await s.isBurnUsed('0xaa'), 'done burns stay used');
  assert.equal(await s.getMeta('x'), null);
  await s.setMeta('x', '5'); assert.equal(await s.getMeta('x'), '5');
  assert.ok(await s.insertLesson({ n: 1 })); assert.ok(!(await s.insertLesson({ n: 1 })));
});

// ---------- signed teach flow against the real handler with a fake chain ----------
function fakeRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
function teachCtx(burner) {
  const hash = '0x' + 'ab'.repeat(32);
  const receipt = { status: 1, blockNumber: 7, logs: [transferLog(TOKEN, burner, DEAD, minRaw)] };
  const ctx = {
    config: { tokenAddress: TOKEN, brainAddress: '0x3333333333333333333333333333333333333333', deadAddress: DEAD, burnPerLesson: 100000, ticker: 'PIP', maxSentence: 120, burnMaxAgeSec: 3 * 24 * 3600 },
    store: new MemoryStore(),
    chain: {
      token: {},
      tokenDecimals: async () => 18,
      provider: {
        getTransactionReceipt: async (h) => (h === hash ? receipt : null),
        getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) - 60 }),
      },
    },
    log: { log() {}, warn() {} },
  };
  return { ctx, hash };
}
async function post(ctx, body) { const res = fakeRes(); await makeTeachHandler(ctx)({ body }, res); return res; }

await test('teach message endpoint returns the cleaned text and exact message', async () => {
  const { ctx, hash } = teachCtx(BURNER);
  const res = fakeRes();
  makeMessageHandler(ctx)({ query: { txHash: hash.toUpperCase().replace('0X', '0x'), text: 'Hello   THERE friend!' } }, res);
  assert.equal(res.body.text, 'hello there friend!');
  assert.equal(res.body.message, `Teach Pip\n\nSentence: hello there friend!\nBurn: ${hash}`);
  const bad = fakeRes();
  makeMessageHandler(ctx)({ query: { txHash: '0x12', text: 'hello there' } }, bad);
  assert.equal(bad.code, 400);
});

await test('teach accepts a valid signature from the burner', async () => {
  const w = Wallet.createRandom();
  const { ctx, hash } = teachCtx(w.address);
  const sig = await w.signMessage(teachMessage(hash, 'hello there friend!'));
  const res = await post(ctx, { txHash: hash, text: 'Hello there friend!', signature: sig });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.position, 1);
  const again = await post(ctx, { txHash: hash, text: 'Hello there friend!', signature: sig });
  assert.equal(again.code, 409);
});

await test('teach rejects a signature from a different wallet', async () => {
  const burner = Wallet.createRandom(), thief = Wallet.createRandom();
  const { ctx, hash } = teachCtx(burner.address);
  const sig = await thief.signMessage(teachMessage(hash, 'stolen words here'));
  const res = await post(ctx, { txHash: hash, text: 'stolen words here', signature: sig });
  assert.equal(res.code, 403);
  assert.equal(res.body.error, 'Only the wallet that made this burn can use it.');
  assert.equal(await ctx.store.queueLength(), 0);
});

await test('teach rejects a missing or junk signature', async () => {
  const w = Wallet.createRandom();
  const { ctx, hash } = teachCtx(w.address);
  const res = await post(ctx, { txHash: hash, text: 'hello there friend' });
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'Connect your wallet and sign to teach Pip.');
  const junk = await post(ctx, { txHash: hash, text: 'hello there friend', signature: '0x1234' });
  assert.equal(junk.code, 403);
});

await test('teach rejects text changed after signing', async () => {
  const w = Wallet.createRandom();
  const { ctx, hash } = teachCtx(w.address);
  const sig = await w.signMessage(teachMessage(hash, 'the bird sang a song'));
  const res = await post(ctx, { txHash: hash, text: 'the bird sang a different song', signature: sig });
  assert.equal(res.code, 403);
  assert.equal(await ctx.store.queueLength(), 0);
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
