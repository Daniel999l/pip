// Entry point: one service that runs the API, the teaching loop and the optional fee forwarder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { formatEther } from 'ethers';
import { config } from './config.js';
import { createStore } from './store.js';
import { createChain, short } from './chain.js';
import * as teacherModule from './teacher.js';
import { createApi, ENDPOINTS } from './routes.js';

const log = console;
process.on('unhandledRejection', (e) => log.error('[process] unhandledRejection:', short(e)));
process.on('uncaughtException', (e) => log.error('[process] uncaughtException:', e && e.stack ? e.stack : e));

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

async function loadFeeForwarder() {
  const file = path.join(here, 'feeForwarder.js');
  if (!fs.existsSync(file)) return null;
  try { return await import('./feeForwarder.js'); } catch (e) {
    log.warn(`[fees] could not load feeForwarder.js: ${short(e)}`);
    return null;
  }
}

async function main() {
  log.log(`[boot] ${config.name} ($${config.ticker}) starting`);
  log.log(`[boot] token ${config.tokenAddress || 'not set'}, brain ${config.brainAddress || 'not set'}`);

  let store;
  try {
    store = await createStore(config, log);
  } catch (e) {
    log.error(`[store] Mongo connection failed: ${short(e)}`);
    process.exit(1);
  }
  const chain = createChain(config, log);
  const ctx = { config, store, chain, log };

  const feeForwarder = await loadFeeForwarder();
  if (feeForwarder && typeof feeForwarder.start === 'function') {
    try { await feeForwarder.start({ config, store, chain, log }); } catch (e) { log.warn(`[fees] start failed: ${short(e)}`); }
  }
  ctx.feeForwarder = feeForwarder;
  ctx.teacher = await teacherModule.start(ctx);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use('/api', createApi(ctx));

  const hasIndex = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  app.get('/', (req, res) => {
    if (fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    res.json({ name: config.name, ticker: config.ticker, endpoints: ENDPOINTS });
  });
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(config.port, () => log.log(`[boot] listening on :${config.port}${hasIndex ? '' : ' (API only, no public/index.html)'}`));

  // health line every 10 minutes
  setInterval(async () => {
    try {
      const parts = [`store ${store.kind}`, `lessons stored ${await store.countLessons()}`, `queue ${await store.queueLength()}`];
      if (chain.wallet) {
        try { parts.push(`teacher ${formatEther(await chain.provider.getBalance(chain.wallet.address))} ETH`); } catch { parts.push('teacher balance unknown'); }
      }
      const st = ctx.teacher.status();
      if (st.waitingFor) parts.push(`waiting: ${st.waitingFor}`);
      if (st.lastError) parts.push(`last error: ${st.lastError}`);
      log.log(`[health] ${parts.join(', ')}`);
    } catch (e) {
      log.warn(`[health] ${short(e)}`);
    }
  }, 10 * 60 * 1000).unref();
}

main().catch((e) => {
  log.error('[boot] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
