// The teaching loop: every LESSON_EVERY_SEC send one lesson to the Brain contract.
// Holder sentences (paid by a burn) go first, otherwise the next chunk of the starter book.
// Usage: const teacher = await start({ config, store, chain, log })
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEther, formatEther, parseUnits, formatUnits, toUtf8Bytes, toUtf8String, zeroPadValue, toBeHex, ZeroAddress } from 'ethers';
import { cleanText, chunkWithOverlap, bookChunk } from './text.js';
import { short } from './chain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BOOK_PATH = path.join(here, 'book', 'book.txt');
const FALLBACK_PROBE = 'the little bird sat in the tree and sang a song. the sun was warm and the sky was blue. she looked down at the green grass and saw a cat. the cat said hello, and the bird said hello back.';

const MAX_GAS = 30_000_000n;
const SPEAK_PROMPT = 'the';
const SPEAK_N = 120;
const SPEAK_SEED = 7;
const SPEAK_TEMP = 2048;
const MAX_ITEM_FAILURES = 3;

export function isSnapshotLesson(n) {
  if ([10, 25, 50, 100, 150, 200, 300].includes(n)) return true;
  return n > 300 && n % 100 === 0;
}

// Book text, cleaned. Re-read when the file changes so a new book is picked up without restart.
let bookCache = { mtime: 0, text: null };
export function readBook() {
  try {
    const st = fs.statSync(BOOK_PATH);
    if (st.mtimeMs !== bookCache.mtime) {
      bookCache = { mtime: st.mtimeMs, text: cleanText(fs.readFileSync(BOOK_PATH, 'utf8')) };
    }
    return bookCache.text || null;
  } catch {
    return null;
  }
}

export function probeText() {
  const b = readBook();
  return b && b.length >= 40 ? b.slice(0, 300) : FALLBACK_PROBE;
}

export async function start(ctx) {
  const { config, store, chain } = ctx;
  const log = ctx.log || console;
  const { provider, wallet, brain, brainSigner } = chain;
  const minBalance = parseEther(String(config.minBalanceEth));
  const everyMs = Math.max(5, config.lessonEverySec) * 1000;

  const state = {
    teaching: false,
    nextTickAt: Date.now() + 5000,
    backoffUntil: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastLessonAt: null,
    lastSkip: null,
    stopped: false,
    inflight: null, // { hash, job } of a sent lesson whose receipt we have not seen yet
  };
  let timer = null;
  let bookMissingLogged = false;

  function skip(reason) {
    if (state.lastSkip !== reason) log.log(`[teacher] waiting: ${reason}`);
    state.lastSkip = reason;
  }

  async function takeSnapshot(lesson) {
    if (!brain) return;
    if (await store.hasSnapshot(lesson)) return;
    try {
      const [text, raw] = await Promise.all([
        brain.speak(toUtf8Bytes(SPEAK_PROMPT), SPEAK_N, SPEAK_SEED, SPEAK_TEMP),
        brain.score(toUtf8Bytes(probeText())),
      ]);
      const level = Math.max(0, Math.min(1, Number(raw) / 4096));
      const added = await store.addSnapshot({ lesson, text: String(text), level, at: new Date() });
      if (added) log.log(`[teacher] timeline snapshot at lesson ${lesson} (level ${(level * 100).toFixed(1)}%)`);
    } catch (e) {
      log.warn(`[teacher] snapshot ${lesson} failed: ${short(e)}`);
    }
  }

  // Pick what to teach next. Returns null if nothing to teach.
  async function pickNext() {
    const item = await store.nextQueued();
    if (item) {
      const chunks = chunkWithOverlap(item.text, 64);
      const i = item.chunkIndex || 0;
      if (i >= chunks.length) {
        await store.updateQueue(item._id, { status: 'done', doneAt: new Date() });
        return pickNext();
      }
      return {
        source: 'holder', item, chunkIndex: i, chunkCount: chunks.length,
        text: chunks[i], by: item.by, ref: zeroPadValue(item.burnTx, 32),
      };
    }
    const book = readBook();
    if (!book) {
      if (!bookMissingLogged) log.log('[teacher] server/book/book.txt not found yet, skipping book lessons');
      bookMissingLogged = true;
      return null;
    }
    bookMissingLogged = false;
    let idx = Number(await store.getMeta('bookCursor', 0)) || 0;
    let text = bookChunk(book, idx, config.lessonChars);
    if (text === null) { idx = 0; text = bookChunk(book, 0, config.lessonChars); }
    if (text === null) return null;
    return { source: 'book', bookIndex: idx, text, by: ZeroAddress, ref: zeroPadValue(toBeHex(idx), 32) };
  }

  // Fee caps: never pay above MAX_GAS_GWEI, no tip (Arbitrum ignores tips anyway). Capping
  // maxFeePerGas also keeps the up-front balance check (gasLimit * maxFee) small.
  function feeOverrides(gasPrice, ceiling) {
    let maxFee = (gasPrice * 3n) / 2n;
    if (maxFee > ceiling) maxFee = ceiling;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: 0n };
  }

  async function sendLesson(job, fees) {
    const bytes = toUtf8Bytes(job.text);
    const est = await brainSigner.teach.estimateGas(bytes, job.by, job.ref);
    let gasLimit = (est * 12n) / 10n;
    if (gasLimit > MAX_GAS) gasLimit = MAX_GAS;
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const tx = await brainSigner.teach(bytes, job.by, job.ref, { gasLimit, nonce, ...fees });
    state.inflight = { hash: tx.hash, job };
    log.log(`[teacher] sent ${job.source} lesson "${job.text.slice(0, 40)}${job.text.length > 40 ? '...' : ''}" tx ${tx.hash}`);
    const receipt = await tx.wait(1, 180_000);
    state.inflight = null;
    if (!receipt || Number(receipt.status) !== 1) throw Object.assign(new Error(`lesson tx reverted ${tx.hash}`), { code: 'CALL_EXCEPTION' });
    return receipt;
  }

  function parseLesson(receipt) {
    for (const lg of receipt.logs) {
      if (String(lg.address).toLowerCase() !== config.brainAddress.toLowerCase()) continue;
      try {
        const p = brain.interface.parseLog(lg);
        if (p && p.name === 'Lesson') return p.args;
      } catch { /* other event */ }
    }
    return null;
  }

  async function finish(job, receipt) {
    const ev = parseLesson(receipt);
    const n = ev ? Number(ev.n) : Number(await brain.lessons());
    const avg = ev ? Number(ev.avgTargetProbQ12) : 0;
    const gasUsed = Number(receipt.gasUsed);
    const price = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
    const doc = {
      n,
      text: job.text,
      by: job.source === 'holder' ? job.by.toLowerCase() : ZeroAddress,
      ref: job.ref,
      source: job.source,
      txHash: receipt.hash,
      gasUsed,
      costEth: formatEther(receipt.gasUsed * BigInt(price)),
      rightChance: avg / 4096,
      at: new Date(),
    };
    await store.insertLesson(doc);

    if (job.source === 'holder') {
      const next = job.chunkIndex + 1;
      const set = { chunkIndex: next, failures: 0 };
      if (next >= job.chunkCount) Object.assign(set, { status: 'done', doneAt: new Date() });
      await store.updateQueue(job.item._id, set);
    } else {
      await store.setMeta('bookCursor', job.bookIndex + 1);
    }

    state.lastLessonAt = Date.now();
    state.consecutiveFailures = 0;
    state.lastError = null;
    log.log(`[teacher] lesson ${n} done, right-letter chance ${(doc.rightChance * 100).toFixed(1)}%, gas ${gasUsed}, cost ${doc.costEth} ETH`);
    if (isSnapshotLesson(n)) await takeSnapshot(n);
  }

  // A lesson tx whose wait timed out may still land. Settle it before sending anything new,
  // so the same chunk is never sent twice and the nonce never stacks up.
  // Returns true when the caller should stop this tick.
  async function settleInflight() {
    if (!state.inflight) return false;
    const { hash, job } = state.inflight;
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) {
      const tx = await provider.getTransaction(hash);
      if (tx) { skip(`previous lesson tx ${hash} still pending`); return true; }
      log.warn(`[teacher] lesson tx ${hash} disappeared, will resend`);
      state.inflight = null;
      return false;
    }
    state.inflight = null;
    if (Number(receipt.status) !== 1) { log.warn(`[teacher] earlier lesson tx ${hash} reverted`); return false; }
    await finish(job, receipt);
    return true;
  }

  async function tick() {
    if (state.teaching) return;
    if (!brain) return skip('brain contract not deployed yet');
    if (!wallet) return skip('no teacher key set');
    if (Date.now() < state.backoffUntil) return;

    state.teaching = true;
    let job = null;
    try {
      if (await settleInflight()) return;
      const bal = await provider.getBalance(wallet.address);
      if (bal < minBalance) return skip(`teacher balance ${formatEther(bal)} ETH is below ${config.minBalanceEth}`);
      const fee = await provider.getFeeData();
      const ceiling = parseUnits(String(config.maxGasGwei), 'gwei');
      if (fee.gasPrice != null && fee.gasPrice > ceiling) return skip(`gas price ${formatUnits(fee.gasPrice, 'gwei')} gwei is above the ${config.maxGasGwei} gwei ceiling, waiting`);
      job = await pickNext();
      if (!job) return skip('nothing to teach');
      state.lastSkip = null;

      const receipt = await sendLesson(job, feeOverrides(fee.gasPrice ?? ceiling, ceiling));
      await finish(job, receipt);
    } catch (e) {
      state.consecutiveFailures += 1;
      state.lastError = short(e);
      const waitSec = Math.min(900, 30 * 2 ** Math.min(5, state.consecutiveFailures - 1));
      state.backoffUntil = Date.now() + waitSec * 1000;
      log.warn(`[teacher] lesson failed (${state.consecutiveFailures} in a row), retry in ${waitSec}s: ${state.lastError}`);
      // Only count it against the holder's sentence when the contract itself rejected it
      // (estimate or on-chain revert). RPC outages, low balance, timeouts and gas spikes must
      // never mark a paid sentence as failed.
      if (job && job.source === 'holder' && e && e.code === 'CALL_EXCEPTION') {
        try {
          const failures = (job.item.failures || 0) + 1;
          const set = { failures, lastError: state.lastError };
          if (failures >= MAX_ITEM_FAILURES) Object.assign(set, { status: 'failed', failedReason: state.lastError, failedAt: new Date() });
          await store.updateQueue(job.item._id, set);
          if (failures >= MAX_ITEM_FAILURES) log.warn(`[teacher] holder sentence from burn ${job.item.burnTx} marked failed`);
        } catch (e2) {
          log.warn(`[teacher] could not update queue item: ${short(e2)}`);
        }
      }
    } finally {
      state.teaching = false;
    }
  }

  function schedule() {
    if (state.stopped) return;
    const delay = Math.max(1000, state.nextTickAt - Date.now());
    timer = setTimeout(async () => {
      state.nextTickAt = Date.now() + everyMs;
      try { await tick(); } catch (e) { log.warn(`[teacher] tick error: ${short(e)}`); }
      schedule();
    }, delay);
  }

  // Boot work: lesson 0 snapshot and history backfill. Runs in the background.
  (async () => {
    if (!brain) return;
    try {
      const onChain = Number(await brain.lessons());
      if (onChain === 0) await takeSnapshot(0);
      if (onChain > 0 && (await store.countLessons()) === 0) await backfill(ctx, onChain);
    } catch (e) {
      log.warn(`[teacher] boot check failed: ${short(e)}`);
    }
  })();

  schedule();
  log.log(`[teacher] loop started, one lesson every ${config.lessonEverySec}s`);

  return {
    tick,
    takeSnapshot,
    status() {
      return {
        teaching: state.teaching,
        nextLessonInSec: Math.max(0, Math.round((Math.max(state.nextTickAt, state.backoffUntil) - Date.now()) / 1000)),
        lastError: state.lastError,
        lastLessonAt: state.lastLessonAt,
        waitingFor: state.lastSkip,
      };
    },
    stop() { state.stopped = true; if (timer) clearTimeout(timer); },
  };
}

// Find the block the Brain was deployed in (binary search on code). Falls back to 0.
async function findDeployBlock(provider, address, latest) {
  try {
    if ((await provider.getCode(address, 1)) !== '0x') return 0;
    let lo = 0, hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await provider.getCode(address, mid);
      if (code && code !== '0x') hi = mid; else lo = mid + 1;
    }
    return lo;
  } catch {
    return 0;
  }
}

// Rebuild lesson history from chain events when the DB is empty (e.g. after a DB swap).
export async function backfill(ctx, expected) {
  const { config, store, chain } = ctx;
  const log = ctx.log || console;
  const { provider, brain } = chain;
  const STEP = 50_000;
  log.log(`[backfill] database has no lessons but chain has ${expected}, reading past events`);
  const latest = await provider.getBlockNumber();
  let from = Number(await store.getMeta('brainDeployBlock', NaN));
  if (!Number.isFinite(from)) {
    from = await findDeployBlock(provider, config.brainAddress, latest);
    await store.setMeta('brainDeployBlock', from);
  }
  const filter = brain.filters.Lesson();
  let found = 0;
  let maxBookIdx = -1;
  for (let start = from; start <= latest && found < expected; start += STEP) {
    const end = Math.min(latest, start + STEP - 1);
    let events = null;
    for (let attempt = 0; attempt < 4 && !events; attempt++) {
      try { events = await brain.queryFilter(filter, start, end); } catch (e) {
        log.warn(`[backfill] blocks ${start}-${end} failed (try ${attempt + 1}): ${short(e)}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (!events) { log.warn('[backfill] giving up early, history will be partial'); break; }
    for (const ev of events) {
      try {
        const a = ev.args;
        const by = String(a.by).toLowerCase();
        const isBook = by === ZeroAddress;
        let gasUsed = 0, costEth = '0';
        try {
          const r = await provider.getTransactionReceipt(ev.transactionHash);
          if (r) { gasUsed = Number(r.gasUsed); costEth = formatEther(r.gasUsed * BigInt(r.gasPrice ?? 0n)); }
        } catch { /* keep zeros */ }
        let at = new Date();
        try { const b = await provider.getBlock(ev.blockNumber); if (b) at = new Date(b.timestamp * 1000); } catch { /* now */ }
        let text = '';
        try { text = toUtf8String(a.text); } catch { text = ''; }
        await store.insertLesson({
          n: Number(a.n), text, by, ref: a.ref, source: isBook ? 'book' : 'holder',
          txHash: ev.transactionHash, gasUsed, costEth, rightChance: Number(a.avgTargetProbQ12) / 4096, at,
        });
        if (isBook) maxBookIdx = Math.max(maxBookIdx, Number(BigInt(a.ref)));
        found++;
      } catch (e) {
        log.warn(`[backfill] skipped one event: ${short(e)}`);
      }
    }
  }
  if (maxBookIdx >= 0 && (await store.getMeta('bookCursor', null)) == null) await store.setMeta('bookCursor', maxBookIdx + 1);
  log.log(`[backfill] restored ${found} of ${expected} lessons`);
}
