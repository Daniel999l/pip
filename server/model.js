// Bit-exact JavaScript port of the Brain contract's read-only maths (speak and score).
// Given the 132 packed storage slots from weights(), produces exactly the same text and score
// integer as the contract's speak()/score() eth_calls, so speaking costs nothing and has no limit.
// Anyone can verify an output by calling speak(prompt, n, seed, tempQ12) on the contract.
//
// Number maths is used for the forward pass: every intermediate stays far below 2^53
// (largest is ~32768*32768*24 = 2.6e10 in the hidden sums), so Math.trunc(a / b) is an exact
// signed division truncating toward zero, like the EVM's sdiv. The RNG and sampling pick use BigInt.
import { keccak256, toBeHex, toUtf8Bytes } from 'ethers';

export const N_PARAMS = 2112;
export const N_SLOTS = 132;
export const ALPHABET = " abcdefghijklmnopqrstuvwxyz.,'?!";
export const MAX_SPEAK = 200;

const EMB = 0, W1 = 256, B1 = 1024, W2 = 1056, B2 = 2080;
const MASK256 = (1n << 256n) - 1n;
const LCG_A = 6364136223846793005n;
const LCG_C = 1442695040888963407n;

const div = (a, b) => Math.trunc(a / b); // sdiv for |a| < 2^53

// slots: 132 values (bigint, number, decimal or hex string). Returns Int16Array(2112) of params.
export function unpack(slots) {
  if (!slots || slots.length !== N_SLOTS) throw new Error(`unpack needs ${N_SLOTS} slots`);
  const out = new Int16Array(N_PARAMS);
  for (let s = 0; s < N_SLOTS; s++) {
    let w = BigInt(slots[s]) & MASK256;
    for (let k = 0; k < 16; k++) {
      let v = Number(w & 0xffffn);
      if (v >= 0x8000) v -= 0x10000;
      out[s * 16 + k] = v;
      w >>= 16n;
    }
  }
  return out;
}

// Contract _code(byte): 0 = space/unknown, 1..26 letters, 27..31 . , ' ? !
export function code(b) {
  if (b > 64 && b < 91) b += 32;
  if (b > 96 && b < 123) return b - 96;
  switch (b) {
    case 46: return 27;
    case 44: return 28;
    case 39: return 29;
    case 63: return 30;
    case 33: return 31;
    default: return 0;
  }
}

function tanhQ(x) {
  if (x > 12288) return 4096;
  if (x < -12288) return -4096;
  const x2 = x * x;
  return div(x * (452984832 + x2), 452984832 + 9 * x2);
}

function expQ(x) { // x <= 0
  if (x < -32768) return 0;
  const y = div(x, 8);
  const y2 = div(y * y, 4096);
  const y3 = div(y2 * y, 4096);
  let r = 4096 + y + (div(y2, 2) + div(y3, 6)) + div(div(y3 * y, 4096), 24);
  r = div(r * r, 4096);
  r = div(r * r, 4096);
  r = div(r * r, 4096);
  return r;
}

// forward(c0, c1, c2) -> p[0..31] (Q12 probabilities), written into `p`.
const xBuf = new Array(24);
const hBuf = new Array(32);
function forward(P, c0, c1, c2, p) {
  for (let e = 0; e < 8; e++) {
    xBuf[e] = P[EMB + c0 * 8 + e];
    xBuf[8 + e] = P[EMB + c1 * 8 + e];
    xBuf[16 + e] = P[EMB + c2 * 8 + e];
  }
  for (let h = 0; h < 32; h++) {
    let acc = 0;
    const base = W1 + h * 24;
    for (let j = 0; j < 24; j++) acc += P[base + j] * xBuf[j];
    hBuf[h] = tanhQ(P[B1 + h] + div(acc, 4096));
  }
  let m = -Infinity;
  for (let v = 0; v < 32; v++) {
    let acc = 0;
    const base = W2 + v * 32;
    for (let h = 0; h < 32; h++) acc += P[base + h] * hBuf[h];
    const l = P[B2 + v] + div(acc, 4096);
    p[v] = l;
    if (l > m) m = l;
  }
  let sum = 0;
  for (let v = 0; v < 32; v++) {
    const e = expQ(p[v] - m);
    p[v] = e;
    sum += e;
  }
  for (let v = 0; v < 32; v++) p[v] = div(p[v] * 4096, sum);
  return p;
}

// Contract _sample. temp: BigInt, rr: BigInt (r >> 64). Mutates p like the contract does.
function sample(p, temp, rr) {
  if (temp === 0n) {
    let best = -1, n = 0;
    for (let v = 0; v < 32; v++) if (p[v] > best) { best = p[v]; n = v; }
    return n;
  }
  let k = 4096n / temp;
  if (k === 0n) k = 1n;
  const kk = Number(k); // k <= 4096
  let tot = 0;
  for (let v = 0; v < 32; v++) {
    const pv = p[v];
    let q = pv;
    for (let z = 1; z < kk && q !== 0; z++) q = div(q * pv, 4096);
    p[v] = q;
    tot += q;
  }
  if (tot < 1) return 0;
  const pick = Number(rr % BigInt(tot));
  let acc = 0;
  for (let v = 0; v < 32; v++) {
    acc += p[v];
    if (pick < acc) return v;
  }
  return 0;
}

function toBytes(text) {
  if (text instanceof Uint8Array) return text;
  return toUtf8Bytes(String(text ?? ''));
}

// speak(params, prompt, n, seed, tempQ12) -> string, identical to Brain.speak().
// prompt: string (UTF-8 encoded like ethers toUtf8Bytes) or Uint8Array of raw bytes.
export function speak(params, prompt, n, seed, tempQ12 = 2048) {
  const N = Number(n);
  if (!Number.isInteger(N) || N < 0) throw new Error('n must be a non-negative integer');
  if (N > MAX_SPEAK) throw new Error('TooLong');
  const b = toBytes(prompt);
  const L = b.length;
  let c0 = L > 2 ? code(b[L - 3]) : 0;
  let c1 = L > 1 ? code(b[L - 2]) : 0;
  let c2 = L > 0 ? code(b[L - 1]) : 0;
  let r = BigInt(keccak256(toBeHex(BigInt(seed), 32)));
  const temp = BigInt(tempQ12);
  const p = new Array(32);
  let out = '';
  for (let i = 0; i < N; i++) {
    forward(params, c0, c1, c2, p);
    r = (r * LCG_A + LCG_C) & MASK256;
    const nx = sample(p, temp, r >> 64n);
    out += ALPHABET[nx];
    c0 = c1; c1 = c2; c2 = nx;
  }
  return out;
}

// score(params, text) -> integer (Q12 average probability of the right next char), identical to Brain.score().
export function score(params, text) {
  const b = toBytes(text);
  const n = b.length;
  if (n < 4) throw new Error('BadLength');
  const p = new Array(32);
  let c0 = code(b[0]), c1 = code(b[1]), c2 = code(b[2]);
  let tot = 0;
  for (let t = 3; t < n; t++) {
    const tg = code(b[t]);
    forward(params, c0, c1, c2, p);
    tot += p[tg];
    c0 = c1; c1 = c2; c2 = tg;
  }
  return div(tot, n - 3);
}
