// POST /api/teach: verify a holder's burn on-chain and queue their sentence.
import { parseUnits, verifyMessage } from 'ethers';
import { cleanText, hasLetters, findBurn, formatAmount, teachMessage } from './text.js';
import { isBlocked } from './blocklist.js';
import { short } from './chain.js';

// Pure sentence check. Returns { text } or { error }.
export function checkSentence(raw, maxSentence) {
  const text = cleanText(raw);
  if (!text) return { error: 'Write a sentence to teach.' };
  if (text.length < 8) return { error: 'That sentence is too short. Use at least 8 letters and spaces.' };
  if (text.length > maxSentence) return { error: `That sentence is too long. Keep it under ${maxSentence} characters.` };
  if (!hasLetters(text)) return { error: 'Your sentence needs some letters in it.' };
  if (isBlocked(text)) return { error: 'That sentence has words we do not teach. Try a different one.' };
  return { text };
}

// String(1e21) is "1e+21", which parseUnits rejects. Write big/small numbers out in full.
export function plainNumber(n) {
  return Number(n).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 18 });
}

export function burnError(code, config) {
  const t = config.ticker;
  switch (code) {
    case 'notfound': return 'We could not find that transaction yet. Wait a few seconds after it confirms and try again.';
    case 'failed': return 'That transaction failed on-chain, so nothing was burned.';
    case 'small': return `That burn is too small. Burn at least ${formatAmount(config.burnPerLesson)} ${t}.`;
    case 'noburn': return `That transaction is not a ${t} burn. Send ${formatAmount(config.burnPerLesson)} ${t} to the burn address, then paste that transaction.`;
    default: return 'Something went wrong checking your burn. Try again in a minute.';
  }
}

export const TX_HASH_ERROR = 'That does not look like a transaction hash. It should start with 0x and be 66 characters long.';

// Who signed `message`? Returns a lowercase address, or null if the signature is unreadable.
export function signerOf(message, signature) {
  try { return verifyMessage(message, String(signature)).toLowerCase(); } catch { return null; }
}

// GET /api/teach/message?txHash=&text= : the exact text the wallet signs.
export function makeMessageHandler(ctx) {
  const { config } = ctx;
  return function message(req, res) {
    const txHash = String(req.query.txHash || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) return res.status(400).json({ ok: false, error: TX_HASH_ERROR });
    const s = checkSentence(req.query.text, config.maxSentence);
    if (s.error) return res.status(400).json({ ok: false, error: s.error });
    return res.json({ ok: true, text: s.text, message: teachMessage(txHash, s.text) });
  };
}

export function makeTeachHandler(ctx) {
  const { config, store, chain } = ctx;
  const log = ctx.log || console;

  return async function teach(req, res) {
    const fail = (status, error) => res.status(status).json({ ok: false, error });
    try {
      if (!config.tokenAddress || !chain.token) return fail(503, 'The token is not deployed yet, so burns cannot be checked.');
      if (!config.brainAddress) return fail(503, 'The brain is not deployed yet. Come back once it is live.');

      const body = req.body || {};
      const txHash = String(body.txHash || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) return fail(400, TX_HASH_ERROR);
      const signature = String(body.signature || '').trim();
      if (!signature) return fail(400, 'Connect your wallet and sign to teach Pip.');

      const s = checkSentence(body.text, config.maxSentence);
      if (s.error) return fail(400, s.error);

      if (await store.isBurnUsed(txHash)) return fail(409, 'That burn was already used to teach a sentence. Each burn teaches one sentence.');

      let receipt;
      try {
        receipt = await chain.provider.getTransactionReceipt(txHash);
      } catch (e) {
        log.warn(`[burns] receipt lookup failed: ${short(e)}`);
        return fail(502, 'We could not reach the chain right now. Try again in a minute.');
      }

      const decimals = await chain.tokenDecimals();
      const minRaw = parseUnits(plainNumber(config.burnPerLesson), decimals);
      const found = findBurn(receipt, { token: config.tokenAddress, dead: config.deadAddress, minRaw });
      if (found.error) return fail(400, burnError(found.error, config));

      let ts = null;
      try {
        const block = await chain.provider.getBlock(receipt.blockNumber);
        ts = block ? block.timestamp : null;
      } catch (e) {
        log.warn(`[burns] block lookup failed: ${short(e)}`);
        return fail(502, 'We could not reach the chain right now. Try again in a minute.');
      }
      if (ts == null) return fail(400, burnError('notfound', config));
      if (Date.now() / 1000 - ts > config.burnMaxAgeSec) return fail(400, 'That burn is older than 3 days. Make a new burn to teach a sentence.');

      // Burn hashes are public, so only the wallet that burned may claim it.
      const signer = signerOf(teachMessage(txHash, s.text), signature);
      if (!signer || signer !== found.from.toLowerCase()) return fail(403, 'Only the wallet that made this burn can use it.');

      const r = await store.enqueue({ burnTx: txHash, text: s.text, by: found.from.toLowerCase(), amount: found.value.toString(), at: new Date() });
      if (r.duplicate) return fail(409, 'That burn was already used to teach a sentence. Each burn teaches one sentence.');
      log.log(`[burns] queued sentence from ${found.from} (burn ${txHash}), position ${r.position}`);
      return res.json({ ok: true, position: r.position });
    } catch (e) {
      log.warn(`[burns] teach error: ${short(e)}`);
      return fail(500, burnError('other', config));
    }
  };
}
