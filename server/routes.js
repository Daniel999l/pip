// HTTP API. All JSON. Money as ETH strings, gas as numbers.
import express from 'express';
import { formatEther, toUtf8Bytes } from 'ethers';
import { publicConfig } from './config.js';
import { cleanText } from './text.js';
import { makeTeachHandler, makeMessageHandler } from './burns.js';
import { probeText } from './teacher.js';
import { short } from './chain.js';

const FALLBACK_LESSON_GAS = 11_500_000n;
const SPEAK_TEMP = 2048;

// Simple fixed-window rate limiter per IP.
export function rateLimit(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'x';
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; hits.set(ip, h); }
    h.n += 1;
    if (h.n > max) return res.status(429).json({ ok: false, error: 'Too many requests. Wait a minute and try again.' });
    next();
  };
}

// Cache a promise-returning function for ttl ms; on error return the last good value.
function cached(ttlMs, fn, log, label) {
  let value, at = 0, pending = null;
  return async () => {
    if (at && Date.now() - at < ttlMs) return value;
    if (!pending) {
      pending = (async () => {
        try { value = await fn(); at = Date.now(); } catch (e) {
          log.warn(`[api] ${label} failed, using last known value: ${short(e)}`);
          at = Date.now() - ttlMs + 5000; // retry in ~5s
        } finally { pending = null; }
        return value;
      })();
    }
    return pending;
  };
}

function lessonOut(l) {
  return {
    n: l.n, text: l.text, by: l.by, ref: l.ref, source: l.source, txHash: l.txHash,
    gasUsed: l.gasUsed, costEth: l.costEth, rightChance: l.rightChance,
    at: l.at instanceof Date ? l.at.toISOString() : l.at,
  };
}
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

export function createApi(ctx) {
  const { config, store, chain, teacher, feeForwarder } = ctx;
  const log = ctx.log || console;
  const { provider, brain, wallet } = chain;
  const router = express.Router();
  router.use(express.json({ limit: '8kb' }));

  const getCounts = cached(10_000, async () => {
    const [lessons, examplesSeen] = await Promise.all([brain.lessons(), brain.examplesSeen()]);
    return { lessons: Number(lessons), examplesSeen: Number(examplesSeen) };
  }, log, 'lesson count');
  const getLevel = cached(30_000, async () => {
    const raw = await brain.score(toUtf8Bytes(probeText()));
    return Math.max(0, Math.min(1, Number(raw) / 4096));
  }, log, 'score');
  const getBalance = cached(15_000, async () => provider.getBalance(wallet.address), log, 'balance');
  const getGasPrice = cached(60_000, async () => {
    const f = await provider.getFeeData();
    return f.gasPrice ?? 20_000_000n; // 0.02 gwei floor
  }, log, 'gas price');

  router.get('/config', (req, res) => res.json(publicConfig()));

  router.get('/state', async (req, res) => {
    try {
      const deployed = Boolean(brain);
      const tStatus = teacher ? teacher.status() : { teaching: false, nextLessonInSec: null };
      const queueLength = await store.queueLength();
      const out = {
        deployed, lessons: 0, examplesSeen: 0, level: null,
        brainBalanceEth: null, avgLessonCostEth: null, lessonsLeft: null,
        queueLength, nextLessonInSec: deployed ? tStatus.nextLessonInSec : null, teaching: Boolean(tStatus.teaching),
      };
      if (deployed) {
        const [counts, level] = await Promise.all([getCounts(), getLevel()]);
        if (counts) Object.assign(out, counts);
        out.level = level ?? null;
      }
      // average cost from the last 20 recorded lessons, else an estimate from the gas price
      const recent = await store.listLessons({ limit: 20 });
      const costs = recent.map((l) => Number(l.costEth)).filter((c) => Number.isFinite(c) && c > 0);
      let avgWei = null;
      if (costs.length) {
        avgWei = BigInt(Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1e18));
      } else {
        const gp = await getGasPrice();
        if (gp) avgWei = FALLBACK_LESSON_GAS * BigInt(gp);
      }
      if (avgWei) out.avgLessonCostEth = formatEther(avgWei);
      if (wallet) {
        const bal = await getBalance();
        if (bal != null) {
          out.brainBalanceEth = formatEther(bal);
          if (avgWei && avgWei > 0n) out.lessonsLeft = Number(BigInt(bal) / avgWei);
        }
      }
      res.json(out);
    } catch (e) {
      log.warn(`[api] state error: ${short(e)}`);
      res.status(500).json({ error: 'Could not load the state right now.' });
    }
  });

  const speakCache = new Map();
  // speak() is a heavy view call on a rate-limited public RPC that the teacher also needs.
  // Cap how many run at once across all visitors so random seeds cannot starve the teacher.
  let speakInFlight = 0;
  const SPEAK_MAX_INFLIGHT = 4;
  router.get('/speak', rateLimit(60, 60_000), async (req, res) => {
    try {
      if (!brain) return res.json({ text: null, lesson: 0 });
      let n = parseInt(req.query.n, 10);
      if (!Number.isFinite(n) || n < 1) n = 120;
      n = Math.min(160, n);
      const prompt = cleanText(req.query.prompt || '').slice(0, 40);
      let seed = parseInt(req.query.seed, 10);
      if (!Number.isFinite(seed) || seed < 0) seed = Math.floor(Date.now() / 15000);
      seed = seed % 1_000_000_000;
      const key = `${seed}|${prompt}|${n}`;
      const hit = speakCache.get(key);
      if (hit && Date.now() - hit.at < 15_000) return res.json(hit.body);

      if (speakInFlight >= SPEAK_MAX_INFLIGHT) return res.status(503).json({ text: null, lesson: 0, error: 'The brain is busy talking. Try again in a moment.' });
      speakInFlight += 1;
      let text, counts;
      try {
        counts = await getCounts();
        text = await brain.speak(toUtf8Bytes(prompt), n, seed, SPEAK_TEMP);
      } finally { speakInFlight -= 1; }
      const body = { text: String(text), lesson: counts ? counts.lessons : 0 };
      speakCache.set(key, { at: Date.now(), body });
      if (speakCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of speakCache) if (now - v.at >= 15_000) speakCache.delete(k);
        if (speakCache.size > 2000) speakCache.clear();
      }
      res.json(body);
    } catch (e) {
      log.warn(`[api] speak error: ${short(e)}`);
      res.status(502).json({ text: null, lesson: 0, error: 'The brain could not talk right now. Try again in a moment.' });
    }
  });

  router.get('/lessons', async (req, res) => {
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 30;
      limit = Math.min(100, limit);
      const b = parseInt(req.query.before, 10);
      const items = await store.listLessons({ limit, before: Number.isFinite(b) ? b : null });
      res.json({ items: items.map(lessonOut) });
    } catch (e) {
      log.warn(`[api] lessons error: ${short(e)}`);
      res.status(500).json({ items: [], error: 'Could not load lessons right now.' });
    }
  });

  router.get('/timeline', async (req, res) => {
    try {
      const items = await store.listTimeline();
      res.json({ items: items.map((t) => ({ lesson: t.lesson, text: t.text, level: t.level, at: iso(t.at) })) });
    } catch (e) {
      log.warn(`[api] timeline error: ${short(e)}`);
      res.status(500).json({ items: [], error: 'Could not load the timeline right now.' });
    }
  });

  router.get('/queue', async (req, res) => {
    try {
      const rows = await store.listQueue(100);
      res.json({ items: rows.map((q, i) => ({ text: q.text, by: q.by, at: iso(q.at), position: i + 1 })) });
    } catch (e) {
      log.warn(`[api] queue error: ${short(e)}`);
      res.status(500).json({ items: [], error: 'Could not load the queue right now.' });
    }
  });

  router.get('/teach/message', rateLimit(60, 60_000), makeMessageHandler(ctx));
  router.post('/teach', rateLimit(10, 60_000), makeTeachHandler(ctx));


  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'The request was not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'That request is too large.' });
    log.warn(`[api] error: ${short(err)}`);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again in a minute.' });
  });

  return router;
}

export const ENDPOINTS = [
  'GET /api/config',
  'GET /api/state',
  'GET /api/speak?seed=<int>&prompt=<str>&n=<int<=160>',
  'GET /api/lessons?limit=30&before=<n>',
  'GET /api/timeline',
  'GET /api/queue',
  'GET /api/teach/message?txHash=<0x..>&text=<str>',
  'POST /api/teach {txHash, text, signature}',
];
