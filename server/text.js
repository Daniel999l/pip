// Pure text helpers shared by the teacher, the burn route and the self-test.

// Alphabet the brain understands (32): space, a..z, . , ' ? !
const KEEP = new Set(" abcdefghijklmnopqrstuvwxyz.,'?!".split(''));
const OVERLAP = 3; // the model looks at 3 chars to guess the 4th

// Lowercase, map smart quotes, turn anything unknown into a space, collapse spaces, trim.
export function cleanText(input) {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents (e -> e)
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'");
  let out = '';
  for (const ch of s) out += KEEP.has(ch) ? ch : ' ';
  return out.replace(/ +/g, ' ').trim();
}

// Split cleaned text into chunks of at most `max` chars where each chunk repeats the
// last 3 chars of the previous one, so every (3 chars -> next char) step is taught once.
export function chunkWithOverlap(text, max = 64, overlap = OVERLAP) {
  if (text.length <= max) return text.length >= 4 ? [text] : [];
  const step = max - overlap;
  const chunks = [];
  for (let start = 0; start + overlap < text.length; start += step) {
    const c = text.slice(start, start + max);
    if (c.length >= 4) chunks.push(c);
    if (start + max >= text.length) break;
  }
  return chunks;
}

// Book chunk number i (each LESSON_CHARS long, stepping LESSON_CHARS-3). Returns null past the end.
export function bookChunk(book, i, size) {
  const step = size - OVERLAP;
  const start = i * step;
  if (start + OVERLAP >= book.length) return null;
  const c = book.slice(start, start + size);
  return c.length >= 4 ? c : null;
}

export function bookChunkCount(book, size) {
  let n = 0;
  while (bookChunk(book, n, size) !== null) n++;
  return n;
}

export function hasLetters(text) {
  return /[a-z]/.test(text);
}

// Burn check on a receipt. Returns { from, value } of the first Transfer of `token` to the
// dead address with value >= minRaw, otherwise { error } with the reason.
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export function findBurn(receipt, { token, dead, minRaw }) {
  if (!receipt) return { error: 'notfound' };
  if (Number(receipt.status) !== 1) return { error: 'failed' };
  const tokenL = token.toLowerCase();
  const deadTopic = '0x' + dead.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  let sawSmall = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== tokenL) continue;
    const t = log.topics || [];
    if (t.length < 3 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (String(t[2]).toLowerCase() !== deadTopic) continue;
    const value = BigInt(log.data && log.data !== '0x' ? log.data : 0);
    const from = '0x' + String(t[1]).slice(-40);
    if (value >= BigInt(minRaw)) return { from, value };
    if (sawSmall === null || value > sawSmall) sawSmall = value;
  }
  return sawSmall !== null ? { error: 'small', value: sawSmall } : { error: 'noburn' };
}

// The exact message a burner signs to claim their burn for one sentence.
// `text` must already be cleaned with cleanText.
export function teachMessage(txHash, text) {
  return `Teach Pip\n\nSentence: ${text}\nBurn: ${String(txHash).toLowerCase()}`;
}

export function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
