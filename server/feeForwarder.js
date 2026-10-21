// Optional fee forwarder. Off unless FEE_WALLET_PRIVATE_KEY is set.
// Sends a slice of NEW inflow in the creator fee wallet to the teacher wallet.
// Never logs, stores or writes any private key.
import { JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';

const META_BASELINE = 'feeForwarder.baseline';
const META_HISTORY = 'feeForwarder.history';
const HISTORY_MAX = 200;
const SEND_GAS_LIMIT = 21000n;

function readSettings(config = {}, env = process.env) {
  const pick = (name, cfgKey, def) => {
    const e = env[name];
    if (e !== undefined && String(e).trim() !== '') return String(e).trim();
    if (config[cfgKey] !== undefined && config[cfgKey] !== null && String(config[cfgKey]) !== '') return String(config[cfgKey]);
    return def;
  };
  // No default: the slice is private and must be set in .env (FEED_PERCENT). Unset means off.
  let percent = Number(pick('FEED_PERCENT', 'feedPercent', '0'));
  if (!Number.isFinite(percent)) percent = 0;
  percent = Math.max(0, Math.min(100, percent));
  let everySec = Number(pick('FEED_EVERY_SEC', 'feedEverySec', '300'));
  if (!Number.isFinite(everySec) || everySec < 5) everySec = 300;
  return {
    percent,
    everySec,
    minWei: parseEther(pick('FEED_MIN_ETH', 'feedMinEth', '0.001')),
    reserveWei: parseEther(pick('FEE_GAS_RESERVE_ETH', 'feeGasReserveEth', '0.0005')),
  };
}

// Core logic, no network. io = { getBalance(): bigint, estimateGasCost(): bigint, send(amountWei): {hash, balanceAfter} }
export function createForwarder({ io, settings, store, log = console, enabled = true, now = () => Date.now() }) {
  const mem = new Map();
  const hasMeta = () => store && typeof store.getMeta === 'function' && typeof store.setMeta === 'function';
  async function getMeta(k) {
    try { if (hasMeta()) { const v = await store.getMeta(k); return v === undefined ? null : v; } } catch (e) { log.warn?.(`[fees] store read failed: ${e.message}`); }
    return mem.has(k) ? mem.get(k) : null;
  }
  async function setMeta(k, v) {
    mem.set(k, v);
    try { if (hasMeta()) await store.setMeta(k, v); } catch (e) { log.warn?.(`[fees] store write failed: ${e.message}`); }
  }
  const parseJson = (v, def) => { if (v == null) return def; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return def; } };

  let history = null, running = false;
  async function loadHistory() {
    if (history) return history;
    const h = parseJson(await getMeta(META_HISTORY), []);
    history = Array.isArray(h) ? h : [];
    return history;
  }

  async function tick() {
    if (!enabled || running) return { action: 'off' };
    running = true;
    try {
      await loadHistory();
      const bal = await io.getBalance();
      const raw = await getMeta(META_BASELINE);
      if (raw === null || raw === undefined || raw === '') {
        await setMeta(META_BASELINE, bal.toString());
        return { action: 'baseline-set' };
      }
      const baseline = BigInt(String(raw));
      if (bal < baseline) {
        await setMeta(META_BASELINE, bal.toString());
        return { action: 'baseline-reset' };
      }
      if (settings.percent <= 0) {
        // keep the baseline moving so a later non-zero percent does not forward old fees
        await setMeta(META_BASELINE, bal.toString());
        return { action: 'percent-zero' };
      }
      const inflow = bal - baseline;
      const amount = (inflow * BigInt(Math.round(settings.percent * 1000))) / 100000n;
      if (inflow === 0n || amount < settings.minWei || amount === 0n) return { action: 'below-min', inflow, amount };
      const gas = await io.estimateGasCost();
      if (bal - amount - gas < settings.reserveWei) return { action: 'reserve', inflow, amount };
      const res = await io.send(amount);
      await setMeta(META_BASELINE, res.balanceAfter.toString());
      const entry = { at: now(), amountEth: formatEther(amount), txHash: res.hash };
      history.push(entry);
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      await setMeta(META_HISTORY, JSON.stringify(history));
      log.info?.(`[fees] forwarded ${entry.amountEth} ETH to the teacher wallet (${res.hash})`);
      return { action: 'forwarded', amount, hash: res.hash };
    } catch (e) {
      log.error?.(`[fees] tick failed: ${e.message}`);
      return { action: 'error', error: e.message };
    } finally { running = false; }
  }

  function getStats() {
    const h = history || [];
    let total = 0n;
    for (const x of h) { try { total += parseEther(x.amountEth); } catch {} }
    return {
      enabled,
      percent: settings.percent,
      totalForwardedEth: formatEther(total),
      lastForwardAt: h.length ? h[h.length - 1].at : null,
      history: h.slice(-HISTORY_MAX),
    };
  }

  return { tick, getStats, loadHistory };
}

let instance = null;
export function getStats() {
  return instance ? instance.getStats() : { enabled: false, percent: 0, totalForwardedEth: '0.0', lastForwardAt: null, history: [] };
}

export async function start(ctx = {}) {
  const { config = {}, store, chain } = ctx;
  const log = ctx.log && typeof ctx.log.info === 'function' ? ctx.log : {
    info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a),
  };
  try {
    const rawKey = (process.env.FEE_WALLET_PRIVATE_KEY || config.feeWalletPrivateKey || '').trim();
    const settings = readSettings(config);
    if (!rawKey) {
      instance = createForwarder({ io: null, settings, store, log, enabled: false });
      return { enabled: false, getStats };
    }
    const teacherKey = config.teacherPrivateKey || process.env.TEACHER_PRIVATE_KEY || '';
    const teacherAddr = chain?.teacherAddress || (teacherKey ? new Wallet(teacherKey.startsWith('0x') ? teacherKey : '0x' + teacherKey).address : null);
    if (!teacherAddr) { log.warn('[fees] fee forwarder needs the teacher wallet; staying off'); return { enabled: false, getStats }; }
    const provider = chain?.provider || new JsonRpcProvider(config.rpcUrl || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com', Number(config.chainId || 4663), { staticNetwork: true });
    const wallet = new Wallet(rawKey.startsWith('0x') ? rawKey : '0x' + rawKey, provider);
    const io = {
      getBalance: () => provider.getBalance(wallet.address),
      async estimateGasCost() {
        const fd = await provider.getFeeData();
        const per = (fd.maxFeePerGas ?? fd.gasPrice ?? 1_000_000_000n);
        return per * SEND_GAS_LIMIT * 2n;
      },
      async send(amountWei) {
        const tx = await wallet.sendTransaction({ to: teacherAddr, value: amountWei, gasLimit: SEND_GAS_LIMIT });
        await tx.wait();
        return { hash: tx.hash, balanceAfter: await provider.getBalance(wallet.address) };
      },
    };
    instance = createForwarder({ io, settings, store, log, enabled: true });
    await instance.loadHistory();
    const run = () => instance.tick().catch((e) => log.error(`[fees] ${e.message}`));
    run();
    const timer = setInterval(run, settings.everySec * 1000);
    timer.unref?.();
    log.info(`[fees] forwarder on: ${settings.percent}% of new inflow every ${settings.everySec}s`);
    return { enabled: true, getStats, stop: () => clearInterval(timer) };
  } catch (e) {
    log.error(`[fees] could not start: ${e.message}`);
    return { enabled: false, getStats };
  }
}

export default { start, getStats, createForwarder };
