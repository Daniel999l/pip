// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
 * Brain: a tiny character-level neural network that is born random and learns on-chain.
 *
 * MODEL
 *   3 previous characters -> embedding (8 each, x = 24 values) -> 32 tanh hidden -> 32-way softmax.
 *   2,112 int16 parameters, fixed point Q12 (S = 4096 means 1.0), packed 16 per storage slot.
 *
 * PARAMETER LAYOUT (flat index i, 0..2111)
 *   emb[c][e]  i = c*8 + e                 (0..255)     c = char code, e = 0..7
 *   W1[h][j]   i = 256 + h*24 + j          (256..1023)  h = hidden 0..31, j = input 0..23
 *   b1[h]      i = 1024 + h                (1024..1055)
 *   W2[v][h]   i = 1056 + v*32 + h         (1056..2079) v = output char 0..31
 *   b2[v]      i = 2080 + v                (2080..2111)
 *   Storage: slots[s] holds params i = 16*s + k (k = 0..15) at bits [16k, 16k+16), int16 two's complement.
 *   weights() returns all 132 slots in one call.
 *
 * ALPHABET (32)
 *   0 = space and any unknown byte, 1..26 = a..z (A..Z lowered), 27 '.', 28 ',', 29 '\'', 30 '?', 31 '!'.
 *   code(byte): if 65<=b<=90 then b+=32; if 97<=b<=122 -> b-96; '.'->27 ','->28 '\''->29 '?'->30 '!'->31; else 0.
 *   char(i) = " abcdefghijklmnopqrstuvwxyz.,'?!"[i].
 *
 * ARITHMETIC
 *   All values are int256. "/" below means EVM sdiv: signed division truncating toward zero.
 *   No intermediate ever overflows int256. Results are fully deterministic.
 *
 * FORWARD PASS  forward(c0, c1, c2) -> p[0..31]   (c0 oldest, c2 newest context char)
 *   x[e] = emb[c0][e], x[8+e] = emb[c1][e], x[16+e] = emb[c2][e]                (e = 0..7)
 *   for h in 0..31:
 *     acc   = sum_{j=0..23} W1[h][j] * x[j]                                       (exact integer sum)
 *     pre   = b1[h] + acc / 4096
 *     hh[h] = tanh(pre)
 *   for v in 0..31:
 *     acc   = sum_{h=0..31} W2[v][h] * hh[h]                                      (exact integer sum)
 *     l[v]  = b2[v] + acc / 4096
 *   m = max_v l[v]
 *   for v: e[v] = exp(l[v] - m);  sum = sum_v e[v]
 *   for v: p[v] = (e[v] * 4096) / sum
 *
 *   tanh(x): if x > 12288 -> 4096; if x < -12288 -> -4096;
 *            else x2 = x*x; (x * (452984832 + x2)) / (452984832 + 9*x2)        (452984832 = 27*4096*4096)
 *   exp(x) (x <= 0): if x < -32768 -> 0; else
 *            y = x / 8; y2 = (y*y) / 4096; y3 = (y2*y) / 4096;
 *            r = 4096 + y + y2/2 + y3/6 + ((y3*y)/4096)/24;
 *            r = (r*r)/4096; r = (r*r)/4096; r = (r*r)/4096; return r
 *
 * speak(prompt, n, seed, tempQ12)   (n <= 200)
 *   context: L = prompt.length; c0 = L>2 ? code(prompt[L-3]) : 0; c1 = L>1 ? code(prompt[L-2]) : 0;
 *            c2 = L>0 ? code(prompt[L-1]) : 0
 *   r = uint256(keccak256(abi.encode(seed)))               (keccak of the 32-byte big-endian seed)
 *   repeat n times:
 *     p = forward(c0, c1, c2)
 *     r = (r * 6364136223846793005 + 1442695040888963407) mod 2^256
 *     nx = sample(p, tempQ12, r >> 64)
 *     output char(nx); (c0, c1, c2) = (c1, c2, nx)
 *   sample(p, temp, rr):
 *     if temp == 0: argmax (first index with the largest p, strict >)
 *     k = 4096 / temp (integer, unsigned); if k == 0 then k = 1
 *     for v: q[v] = p[v]; repeat (k-1) times: q[v] = (q[v] * p[v]) / 4096;   tot = sum_v q[v]
 *     if tot <= 0: return 0
 *     pick = rr mod tot (unsigned); acc = 0; for v in 0..31: acc += q[v]; if pick < acc return v
 *   (temp 2048 -> k=2 squares p; temp 4096 -> k=1 plain sampling; a very small temp means a large k and lots of gas)
 *
 * score(text) = (sum_{t=0..L-4} forward(code(text[t]), code(text[t+1]), code(text[t+2]))[code(text[t+3])]) / (L-3)
 *
 * LEARNING (teach, not needed for a speaking port)
 *   For each 4-char window: forward, d[v] = p[v] - 4096*[v==target]; d[v] = 0 if |d[v]| < 16.
 *   dh[h] = sum_v W2[v][h]*d[v]; dp[h] = ((dh[h]/4096) * (4096 - (hh[h]*hh[h])/4096)) / 4096; dp = 0 if |dp| < 4.
 *   dx[j] = sum_h W1[h][j]*dp[h].
 *   Gradients are accumulated exactly at scale 4096 (no per-example truncation):
 *     gW2[v][h] += d[v]*hh[h], gb2[v] += d[v]*4096, gW1[h][j] += dp[h]*x[j], gb1[h] += dp[h]*4096,
 *     gEmb[c_k][e] += dx[8k+e].
 *   Update per param with stochastic rounding: num = lr*g, den = 4096*4096*examples,
 *     q = num/den, rem = num smod den, u = (rnd16 * den) >> 16 (16 bits per param from keccak(seed, slot)),
 *     q += 1 if rem > 0 and u < rem; q -= 1 if rem < 0 and u < -rem; w = clamp(w - q, -32768, 32767).
 */
contract Brain {
    // ---------------- storage ----------------
    uint256[132] public slots; // packed weights, slot 0.. (must stay the first state variable)
    address public owner;
    address public teacher;
    uint256 public lessons;
    uint256 public examplesSeen;
    int256 public lr = 1229; // 0.3 in Q12

    event Lesson(
        uint256 indexed n, address indexed by, bytes32 indexed ref, uint256 examples, int256 avgTargetProbQ12, bytes text
    );

    error NotOwner();
    error NotTeacher();
    error BadLength();
    error TooLong();
    error BadRate();
    error ZeroAddress();

    // ---------------- fixed memory map (byte addresses) ----------------
    // Packed words hold 4 signed 64-bit lanes: word = sum_l v_l * 2^(64 l).
    uint256 constant M_ORIG = 0x80; //   132 words: raw storage slots
    uint256 constant M_EMB = 0x1100; //  256 words: emb scalar
    uint256 constant M_B1 = 0x3100; //   32 words
    uint256 constant M_B2 = 0x3500; //   32 words
    uint256 constant M_W1F = 0x3900; //  [j][k] 24x8 packed, lanes h = 4k+l
    uint256 constant M_W2F = 0x5100; //  [h][k] 32x8 packed, lanes v = 4k+l
    uint256 constant M_X = 0x7100; //    24 words
    uint256 constant M_HH = 0x7400; //   32 words
    uint256 constant M_P = 0x7800; //    32 words
    uint256 constant M_DP = 0x7C00; //   32 words
    uint256 constant M_CODES = 0x8000; // 64 words
    uint256 constant M_END_F = 0x8800;
    uint256 constant M_W1T = 0x8800; //  [h][w] 32x6 packed, lanes j = 4w+l
    uint256 constant M_W2T = 0xA000; //  [v][k] 32x8 packed, lanes h = 4k+l
    uint256 constant M_GEMB = 0xC000; // 256 words scalar
    uint256 constant M_GW1F = 0xE000; // like W1F
    uint256 constant M_GW2F = 0xF800; // like W2F
    uint256 constant M_GB1 = 0x11800; // 8 packed (lanes h)
    uint256 constant M_GB2 = 0x11900; // 8 packed (lanes v)
    uint256 constant M_END_T = 0x11A00;

    uint256 constant BIAS = 0x8000000000000000800000000000000080000000000000008000000000000000;
    uint256 constant H63 = 0x8000000000000000;
    uint256 constant M64 = 0xffffffffffffffff;
    bytes32 constant ALPHA = " abcdefghijklmnopqrstuvwxyz.,'?!";

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 seed, address teacher_) {
        owner = msg.sender;
        teacher = teacher_ == address(0) ? msg.sender : teacher_;
        uint256 r = uint256(keccak256(abi.encode(seed)));
        for (uint256 s = 0; s < 132; s++) {
            uint256 packed;
            for (uint256 k = 0; k < 16; k++) {
                uint256 i = s * 16 + k;
                r = uint256(keccak256(abi.encode(r)));
                int256 range;
                if (i < 256) range = 2048; // emb  +-0.5
                else if (i < 1024) range = 836; // W1   +-1/sqrt(24)
                else if (i < 1056) range = 0; // b1
                else if (i < 2080) range = 724; // W2   +-1/sqrt(32)
                else range = 0; // b2
                int256 v = range == 0 ? int256(0) : int256(r % uint256(2 * range + 1)) - range;
                packed |= uint256(uint16(int16(v))) << (16 * k);
            }
            slots[s] = packed;
        }
    }

    // ---------------- admin ----------------
    function setTeacher(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        teacher = t;
    }

    function setLr(int256 v) external onlyOwner {
        if (v < 205 || v > 4096) revert BadRate();
        lr = v;
    }

    function transferOwnership(address o) external onlyOwner {
        if (o == address(0)) revert ZeroAddress();
        owner = o;
    }

    /// all packed weights in one call
    function weights() external view returns (uint256[132] memory w) {
        w = slots;
    }

    // ---------------- loading ----------------
    /// Copies storage into the fixed memory map. train=true also builds the transposed copies.
    function _load(bool train) private view {
        assembly ("memory-safe") {
            // the fixed memory map assumes nothing has been allocated yet
            if iszero(eq(mload(0x40), 0x80)) { revert(0, 0) }
            switch train
            case 0 { mstore(0x40, M_END_F) }
            default { mstore(0x40, M_END_T) }

            for { let s := 0 } lt(s, 132) { s := add(s, 1) } { mstore(add(M_ORIG, shl(5, s)), sload(s)) }

            function unp(w, dst) {
                mstore(dst, signextend(1, w))
                mstore(add(dst, 32), signextend(1, shr(16, w)))
                mstore(add(dst, 64), signextend(1, shr(32, w)))
                mstore(add(dst, 96), signextend(1, shr(48, w)))
                mstore(add(dst, 128), signextend(1, shr(64, w)))
                mstore(add(dst, 160), signextend(1, shr(80, w)))
                mstore(add(dst, 192), signextend(1, shr(96, w)))
                mstore(add(dst, 224), signextend(1, shr(112, w)))
                mstore(add(dst, 256), signextend(1, shr(128, w)))
                mstore(add(dst, 288), signextend(1, shr(144, w)))
                mstore(add(dst, 320), signextend(1, shr(160, w)))
                mstore(add(dst, 352), signextend(1, shr(176, w)))
                mstore(add(dst, 384), signextend(1, shr(192, w)))
                mstore(add(dst, 416), signextend(1, shr(208, w)))
                mstore(add(dst, 448), signextend(1, shr(224, w)))
                mstore(add(dst, 480), signextend(1, shr(240, w)))
            }
            function el(i) -> v {
                v := signextend(1, shr(shl(4, and(i, 15)), mload(add(M_ORIG, shl(5, shr(4, i))))))
            }
            // 4 params with stride st packed into 4 lanes
            function f4(i, st) -> w {
                w := add(add(el(i), shl(64, el(add(i, st)))), add(shl(128, el(add(i, add(st, st)))), shl(192, el(add(i, mul(3, st))))))
            }
            // 4 consecutive params (i multiple of 4) packed into 4 lanes
            function t4(i) -> w {
                let x := shr(shl(4, and(i, 15)), mload(add(M_ORIG, shl(5, shr(4, i)))))
                w := add(add(signextend(1, x), shl(64, signextend(1, shr(16, x)))), add(shl(128, signextend(1, shr(32, x))), shl(192, signextend(1, shr(48, x)))))
            }

            for { let s := 0 } lt(s, 16) { s := add(s, 1) } { unp(mload(add(M_ORIG, shl(5, s))), add(M_EMB, shl(9, s))) }
            unp(mload(add(M_ORIG, 2048)), M_B1) // slot 64
            unp(mload(add(M_ORIG, 2080)), add(M_B1, 512)) // slot 65
            unp(mload(add(M_ORIG, 4160)), M_B2) // slot 130
            unp(mload(add(M_ORIG, 4192)), add(M_B2, 512)) // slot 131

            // W1F[j][k] lanes h = 4k+l : i = 256 + (4k+l)*24 + j
            for { let j := 0 } lt(j, 24) { j := add(j, 1) } {
                let dst := add(M_W1F, shl(8, j))
                let i := add(256, j)
                mstore(dst, f4(i, 24))
                mstore(add(dst, 32), f4(add(i, 96), 24))
                mstore(add(dst, 64), f4(add(i, 192), 24))
                mstore(add(dst, 96), f4(add(i, 288), 24))
                mstore(add(dst, 128), f4(add(i, 384), 24))
                mstore(add(dst, 160), f4(add(i, 480), 24))
                mstore(add(dst, 192), f4(add(i, 576), 24))
                mstore(add(dst, 224), f4(add(i, 672), 24))
            }
            // W2F[h][k] lanes v = 4k+l : i = 1056 + (4k+l)*32 + h
            for { let h := 0 } lt(h, 32) { h := add(h, 1) } {
                let dst := add(M_W2F, shl(8, h))
                let i := add(1056, h)
                mstore(dst, f4(i, 32))
                mstore(add(dst, 32), f4(add(i, 128), 32))
                mstore(add(dst, 64), f4(add(i, 256), 32))
                mstore(add(dst, 96), f4(add(i, 384), 32))
                mstore(add(dst, 128), f4(add(i, 512), 32))
                mstore(add(dst, 160), f4(add(i, 640), 32))
                mstore(add(dst, 192), f4(add(i, 768), 32))
                mstore(add(dst, 224), f4(add(i, 896), 32))
            }
            if train {
                // W1T[h][w] lanes j = 4w+l : i = 256 + h*24 + 4w  (192 words, consecutive)
                for { let q := 0 } lt(q, 192) { q := add(q, 1) } { mstore(add(M_W1T, shl(5, q)), t4(add(256, shl(2, q)))) }
                // W2T[v][k] lanes h = 4k+l : i = 1056 + v*32 + 4k (256 words, consecutive)
                for { let q := 0 } lt(q, 256) { q := add(q, 1) } { mstore(add(M_W2T, shl(5, q)), t4(add(1056, shl(2, q)))) }
            }
        }
    }

    // ---------------- forward ----------------
    function _fwd(uint256 c0, uint256 c1, uint256 c2) private pure {
        assembly ("memory-safe") {
            function th(x) -> r {
                switch sgt(x, 12288)
                case 1 { r := 4096 }
                default {
                    switch slt(x, sub(0, 12288))
                    case 1 { r := sub(0, 4096) }
                    default {
                        let x2 := mul(x, x)
                        r := sdiv(mul(x, add(452984832, x2)), add(452984832, mul(9, x2)))
                    }
                }
            }
            function ex(x) -> r {
                if iszero(slt(x, sub(0, 32768))) {
                    let y := sdiv(x, 8)
                    let y2 := sdiv(mul(y, y), 4096)
                    let y3 := sdiv(mul(y2, y), 4096)
                    r := add(add(add(4096, y), add(sdiv(y2, 2), sdiv(y3, 6))), sdiv(sdiv(mul(y3, y), 4096), 24))
                    r := sdiv(mul(r, r), 4096)
                    r := sdiv(mul(r, r), 4096)
                    r := sdiv(mul(r, r), 4096)
                }
            }
            // 4 hidden units from one packed accumulator; off = byte offset of first unit
            function hid4(acc, off) {
                let b := add(acc, BIAS)
                mstore(add(M_HH, off), th(add(mload(add(M_B1, off)), sdiv(sub(and(b, M64), H63), 4096))))
                off := add(off, 32)
                mstore(add(M_HH, off), th(add(mload(add(M_B1, off)), sdiv(sub(and(shr(64, b), M64), H63), 4096))))
                off := add(off, 32)
                mstore(add(M_HH, off), th(add(mload(add(M_B1, off)), sdiv(sub(and(shr(128, b), M64), H63), 4096))))
                off := add(off, 32)
                mstore(add(M_HH, off), th(add(mload(add(M_B1, off)), sdiv(sub(shr(192, b), H63), 4096))))
            }
            function lg4(acc, off, m0) -> m {
                m := m0
                let b := add(acc, BIAS)
                let l := add(mload(add(M_B2, off)), sdiv(sub(and(b, M64), H63), 4096))
                mstore(add(M_P, off), l)
                if sgt(l, m) { m := l }
                off := add(off, 32)
                l := add(mload(add(M_B2, off)), sdiv(sub(and(shr(64, b), M64), H63), 4096))
                mstore(add(M_P, off), l)
                if sgt(l, m) { m := l }
                off := add(off, 32)
                l := add(mload(add(M_B2, off)), sdiv(sub(and(shr(128, b), M64), H63), 4096))
                mstore(add(M_P, off), l)
                if sgt(l, m) { m := l }
                off := add(off, 32)
                l := add(mload(add(M_B2, off)), sdiv(sub(shr(192, b), H63), 4096))
                mstore(add(M_P, off), l)
                if sgt(l, m) { m := l }
            }

            // gather x
            {
                let e0 := add(M_EMB, shl(8, c0))
                let e1 := add(M_EMB, shl(8, c1))
                let e2 := add(M_EMB, shl(8, c2))
                for { let o := 0 } lt(o, 256) { o := add(o, 32) } {
                    mstore(add(M_X, o), mload(add(e0, o)))
                    mstore(add(M_X, add(o, 256)), mload(add(e1, o)))
                    mstore(add(M_X, add(o, 512)), mload(add(e2, o)))
                }
            }
            // hidden layer: lanes over h
            {
                let a0 := 0
                let a1 := 0
                let a2 := 0
                let a3 := 0
                let a4 := 0
                let a5 := 0
                let a6 := 0
                let a7 := 0
                for { let o := 0 } lt(o, 768) { o := add(o, 32) } {
                    let xv := mload(add(M_X, o))
                    let p := add(M_W1F, shl(3, o))
                    a0 := add(a0, mul(mload(p), xv))
                    a1 := add(a1, mul(mload(add(p, 32)), xv))
                    a2 := add(a2, mul(mload(add(p, 64)), xv))
                    a3 := add(a3, mul(mload(add(p, 96)), xv))
                    a4 := add(a4, mul(mload(add(p, 128)), xv))
                    a5 := add(a5, mul(mload(add(p, 160)), xv))
                    a6 := add(a6, mul(mload(add(p, 192)), xv))
                    a7 := add(a7, mul(mload(add(p, 224)), xv))
                }
                hid4(a0, 0)
                hid4(a1, 128)
                hid4(a2, 256)
                hid4(a3, 384)
                hid4(a4, 512)
                hid4(a5, 640)
                hid4(a6, 768)
                hid4(a7, 896)
            }
            // output layer: lanes over v
            {
                let a0 := 0
                let a1 := 0
                let a2 := 0
                let a3 := 0
                let a4 := 0
                let a5 := 0
                let a6 := 0
                let a7 := 0
                for { let o := 0 } lt(o, 1024) { o := add(o, 32) } {
                    let hv := mload(add(M_HH, o))
                    let p := add(M_W2F, shl(3, o))
                    a0 := add(a0, mul(mload(p), hv))
                    a1 := add(a1, mul(mload(add(p, 32)), hv))
                    a2 := add(a2, mul(mload(add(p, 64)), hv))
                    a3 := add(a3, mul(mload(add(p, 96)), hv))
                    a4 := add(a4, mul(mload(add(p, 128)), hv))
                    a5 := add(a5, mul(mload(add(p, 160)), hv))
                    a6 := add(a6, mul(mload(add(p, 192)), hv))
                    a7 := add(a7, mul(mload(add(p, 224)), hv))
                }
                let m := sub(0, shl(254, 1))
                m := lg4(a0, 0, m)
                m := lg4(a1, 128, m)
                m := lg4(a2, 256, m)
                m := lg4(a3, 384, m)
                m := lg4(a4, 512, m)
                m := lg4(a5, 640, m)
                m := lg4(a6, 768, m)
                m := lg4(a7, 896, m)

                let sum := 0
                for { let o := M_P } lt(o, add(M_P, 1024)) { o := add(o, 128) } {
                    let e := ex(sub(mload(o), m))
                    mstore(o, e)
                    sum := add(sum, e)
                    e := ex(sub(mload(add(o, 32)), m))
                    mstore(add(o, 32), e)
                    sum := add(sum, e)
                    e := ex(sub(mload(add(o, 64)), m))
                    mstore(add(o, 64), e)
                    sum := add(sum, e)
                    e := ex(sub(mload(add(o, 96)), m))
                    mstore(add(o, 96), e)
                    sum := add(sum, e)
                }
                for { let o := M_P } lt(o, add(M_P, 1024)) { o := add(o, 128) } {
                    mstore(o, sdiv(shl(12, mload(o)), sum))
                    mstore(add(o, 32), sdiv(shl(12, mload(add(o, 32))), sum))
                    mstore(add(o, 64), sdiv(shl(12, mload(add(o, 64))), sum))
                    mstore(add(o, 96), sdiv(shl(12, mload(add(o, 96))), sum))
                }
            }
        }
    }

    // ---------------- backward (accumulates gradients) ----------------
    function _bwd(uint256 c0, uint256 c1, uint256 c2, uint256 tg) private pure returns (int256 prob) {
        assembly ("memory-safe") {
            function m16(a) -> d {
                d := a
                if lt(add(a, 15), 31) { d := 0 }
            }
            // mask 4 dlogits at byte offset off, write back, return packed
            function pk4(off) -> w {
                let p := add(M_P, off)
                let d0 := m16(mload(p))
                mstore(p, d0)
                let d1 := m16(mload(add(p, 32)))
                mstore(add(p, 32), d1)
                let d2 := m16(mload(add(p, 64)))
                mstore(add(p, 64), d2)
                let d3 := m16(mload(add(p, 96)))
                mstore(add(p, 96), d3)
                w := add(add(d0, shl(64, d1)), add(shl(128, d2), shl(192, d3)))
            }
            function dp1(dhv, off) -> dp {
                let hv := mload(add(M_HH, off))
                dp := sdiv(mul(sdiv(dhv, 4096), sub(4096, sdiv(mul(hv, hv), 4096))), 4096)
                if lt(add(dp, 3), 7) { dp := 0 }
                mstore(add(M_DP, off), dp)
            }
            function dp4(acc, off) -> w {
                let b := add(acc, BIAS)
                let d0 := dp1(sub(and(b, M64), H63), off)
                let d1 := dp1(sub(and(shr(64, b), M64), H63), add(off, 32))
                let d2 := dp1(sub(and(shr(128, b), M64), H63), add(off, 64))
                let d3 := dp1(sub(shr(192, b), H63), add(off, 96))
                w := add(add(d0, shl(64, d1)), add(shl(128, d2), shl(192, d3)))
            }
            function gex(acc, a) {
                let b := add(acc, BIAS)
                mstore(a, add(mload(a), sub(and(b, M64), H63)))
                mstore(add(a, 32), add(mload(add(a, 32)), sub(and(shr(64, b), M64), H63)))
                mstore(add(a, 64), add(mload(add(a, 64)), sub(and(shr(128, b), M64), H63)))
                mstore(add(a, 96), add(mload(add(a, 96)), sub(shr(192, b), H63)))
            }

            let pt := add(M_P, shl(5, tg))
            prob := mload(pt)
            mstore(pt, sub(prob, 4096))

            // ---- output layer gradients ----
            {
                let d0 := pk4(0)
                let d1 := pk4(128)
                let d2 := pk4(256)
                let d3 := pk4(384)
                let d4 := pk4(512)
                let d5 := pk4(640)
                let d6 := pk4(768)
                let d7 := pk4(896)
                mstore(M_GB2, add(mload(M_GB2), shl(12, d0)))
                mstore(add(M_GB2, 32), add(mload(add(M_GB2, 32)), shl(12, d1)))
                mstore(add(M_GB2, 64), add(mload(add(M_GB2, 64)), shl(12, d2)))
                mstore(add(M_GB2, 96), add(mload(add(M_GB2, 96)), shl(12, d3)))
                mstore(add(M_GB2, 128), add(mload(add(M_GB2, 128)), shl(12, d4)))
                mstore(add(M_GB2, 160), add(mload(add(M_GB2, 160)), shl(12, d5)))
                mstore(add(M_GB2, 192), add(mload(add(M_GB2, 192)), shl(12, d6)))
                mstore(add(M_GB2, 224), add(mload(add(M_GB2, 224)), shl(12, d7)))
                for { let o := 0 } lt(o, 1024) { o := add(o, 32) } {
                    let hv := mload(add(M_HH, o))
                    let p := add(M_GW2F, shl(3, o))
                    mstore(p, add(mload(p), mul(d0, hv)))
                    mstore(add(p, 32), add(mload(add(p, 32)), mul(d1, hv)))
                    mstore(add(p, 64), add(mload(add(p, 64)), mul(d2, hv)))
                    mstore(add(p, 96), add(mload(add(p, 96)), mul(d3, hv)))
                    mstore(add(p, 128), add(mload(add(p, 128)), mul(d4, hv)))
                    mstore(add(p, 160), add(mload(add(p, 160)), mul(d5, hv)))
                    mstore(add(p, 192), add(mload(add(p, 192)), mul(d6, hv)))
                    mstore(add(p, 224), add(mload(add(p, 224)), mul(d7, hv)))
                }
            }
            // ---- dh = W2^T d  (lanes over h), then dp ----
            {
                let a0 := 0
                let a1 := 0
                let a2 := 0
                let a3 := 0
                let a4 := 0
                let a5 := 0
                let a6 := 0
                let a7 := 0
                for { let o := 0 } lt(o, 1024) { o := add(o, 32) } {
                    let d := mload(add(M_P, o))
                    if d {
                        let p := add(M_W2T, shl(3, o))
                        a0 := add(a0, mul(mload(p), d))
                        a1 := add(a1, mul(mload(add(p, 32)), d))
                        a2 := add(a2, mul(mload(add(p, 64)), d))
                        a3 := add(a3, mul(mload(add(p, 96)), d))
                        a4 := add(a4, mul(mload(add(p, 128)), d))
                        a5 := add(a5, mul(mload(add(p, 160)), d))
                        a6 := add(a6, mul(mload(add(p, 192)), d))
                        a7 := add(a7, mul(mload(add(p, 224)), d))
                    }
                }
                a0 := dp4(a0, 0)
                a1 := dp4(a1, 128)
                a2 := dp4(a2, 256)
                a3 := dp4(a3, 384)
                a4 := dp4(a4, 512)
                a5 := dp4(a5, 640)
                a6 := dp4(a6, 768)
                a7 := dp4(a7, 896)
                mstore(M_GB1, add(mload(M_GB1), shl(12, a0)))
                mstore(add(M_GB1, 32), add(mload(add(M_GB1, 32)), shl(12, a1)))
                mstore(add(M_GB1, 64), add(mload(add(M_GB1, 64)), shl(12, a2)))
                mstore(add(M_GB1, 96), add(mload(add(M_GB1, 96)), shl(12, a3)))
                mstore(add(M_GB1, 128), add(mload(add(M_GB1, 128)), shl(12, a4)))
                mstore(add(M_GB1, 160), add(mload(add(M_GB1, 160)), shl(12, a5)))
                mstore(add(M_GB1, 192), add(mload(add(M_GB1, 192)), shl(12, a6)))
                mstore(add(M_GB1, 224), add(mload(add(M_GB1, 224)), shl(12, a7)))
                for { let o := 0 } lt(o, 768) { o := add(o, 32) } {
                    let xv := mload(add(M_X, o))
                    let p := add(M_GW1F, shl(3, o))
                    mstore(p, add(mload(p), mul(a0, xv)))
                    mstore(add(p, 32), add(mload(add(p, 32)), mul(a1, xv)))
                    mstore(add(p, 64), add(mload(add(p, 64)), mul(a2, xv)))
                    mstore(add(p, 96), add(mload(add(p, 96)), mul(a3, xv)))
                    mstore(add(p, 128), add(mload(add(p, 128)), mul(a4, xv)))
                    mstore(add(p, 160), add(mload(add(p, 160)), mul(a5, xv)))
                    mstore(add(p, 192), add(mload(add(p, 192)), mul(a6, xv)))
                    mstore(add(p, 224), add(mload(add(p, 224)), mul(a7, xv)))
                }
            }
            // ---- dx = W1^T dp (lanes over j), embedding gradients ----
            {
                let x0 := 0
                let x1 := 0
                let x2 := 0
                let x3 := 0
                let x4 := 0
                let x5 := 0
                for { let o := 0 } lt(o, 1024) { o := add(o, 32) } {
                    let d := mload(add(M_DP, o))
                    if d {
                        let p := add(M_W1T, mul(o, 6))
                        x0 := add(x0, mul(mload(p), d))
                        x1 := add(x1, mul(mload(add(p, 32)), d))
                        x2 := add(x2, mul(mload(add(p, 64)), d))
                        x3 := add(x3, mul(mload(add(p, 96)), d))
                        x4 := add(x4, mul(mload(add(p, 128)), d))
                        x5 := add(x5, mul(mload(add(p, 160)), d))
                    }
                }
                let g0 := add(M_GEMB, shl(8, c0))
                gex(x0, g0)
                gex(x1, add(g0, 128))
                let g1 := add(M_GEMB, shl(8, c1))
                gex(x2, g1)
                gex(x3, add(g1, 128))
                let g2 := add(M_GEMB, shl(8, c2))
                gex(x4, g2)
                gex(x5, add(g2, 128))
            }
        }
    }

    // ---------------- update ----------------
    function _apply(uint256 r, uint256 ex) private {
        int256 rate = lr;
        assembly ("memory-safe") {
            function lane(w, l) -> v { v := sub(and(shr(shl(6, l), add(w, BIAS)), M64), H63) }
            // handles param i with gradient g; pk/rnd carry the slot being built
            function put(i, g, pk, rnd, seedr, lrq, den) -> pk2, rnd2 {
                let k := and(i, 15)
                let s := shr(4, i)
                rnd2 := rnd
                pk2 := pk
                if iszero(k) {
                    mstore(0, seedr)
                    mstore(32, s)
                    rnd2 := keccak256(0, 64)
                    pk2 := 0
                }
                let orig := mload(add(M_ORIG, shl(5, s)))
                let sh := shl(4, k)
                let nv := signextend(1, shr(sh, orig))
                if g {
                    let num := mul(lrq, g)
                    let q := sdiv(num, den)
                    let rem := smod(num, den)
                    let u := shr(16, mul(and(shr(sh, rnd2), 0xffff), den))
                    if sgt(rem, 0) { if lt(u, rem) { q := add(q, 1) } }
                    if slt(rem, 0) { if lt(u, sub(0, rem)) { q := sub(q, 1) } }
                    nv := sub(nv, q)
                    if sgt(nv, 32767) { nv := 32767 }
                    if slt(nv, sub(0, 32768)) { nv := sub(0, 32768) }
                }
                pk2 := or(pk2, shl(sh, and(nv, 0xffff)))
                if eq(k, 15) { if iszero(eq(pk2, orig)) { sstore(s, pk2) } }
            }

            let den := shl(24, ex)
            let pk := 0
            let rnd := 0
            // emb
            for { let i := 0 } lt(i, 256) { i := add(i, 1) } {
                pk, rnd := put(i, mload(add(M_GEMB, shl(5, i))), pk, rnd, r, rate, den)
            }
            // W1[h][j] -> GW1F[j][h>>2] lane h&3
            for { let h := 0 } lt(h, 32) { h := add(h, 1) } {
                let base := add(256, mul(h, 24))
                let col := add(M_GW1F, shl(5, shr(2, h)))
                let l := and(h, 3)
                for { let j := 0 } lt(j, 24) { j := add(j, 1) } {
                    pk, rnd := put(add(base, j), lane(mload(add(col, shl(8, j))), l), pk, rnd, r, rate, den)
                }
            }
            // b1
            for { let h := 0 } lt(h, 32) { h := add(h, 1) } {
                pk, rnd := put(add(1024, h), lane(mload(add(M_GB1, shl(5, shr(2, h)))), and(h, 3)), pk, rnd, r, rate, den)
            }
            // W2[v][h] -> GW2F[h][v>>2] lane v&3
            for { let v := 0 } lt(v, 32) { v := add(v, 1) } {
                let base := add(1056, shl(5, v))
                let col := add(M_GW2F, shl(5, shr(2, v)))
                let l := and(v, 3)
                for { let h := 0 } lt(h, 32) { h := add(h, 1) } {
                    pk, rnd := put(add(base, h), lane(mload(add(col, shl(8, h))), l), pk, rnd, r, rate, den)
                }
            }
            // b2
            for { let v := 0 } lt(v, 32) { v := add(v, 1) } {
                pk, rnd := put(add(2080, v), lane(mload(add(M_GB2, shl(5, shr(2, v)))), and(v, 3)), pk, rnd, r, rate, den)
            }
        }
    }

    // ---------------- helpers ----------------
    function _code(uint256 c) private pure returns (uint256 r) {
        assembly ("memory-safe") {
            if and(gt(c, 64), lt(c, 91)) { c := add(c, 32) }
            switch and(gt(c, 96), lt(c, 123))
            case 1 { r := sub(c, 96) }
            default {
                switch c
                case 46 { r := 27 }
                case 44 { r := 28 }
                case 39 { r := 29 }
                case 63 { r := 30 }
                case 33 { r := 31 }
                default { r := 0 }
            }
        }
    }

    function _p(uint256 v) private pure returns (int256 r) {
        assembly ("memory-safe") { r := mload(add(M_P, shl(5, v))) }
    }

    function _sample(uint256 temp, uint256 rr) private pure returns (uint256 nx) {
        assembly ("memory-safe") {
            function samp(t, x) -> n {
                if iszero(t) {
                    let best := sub(0, 1)
                    for { let v := 0 } lt(v, 32) { v := add(v, 1) } {
                        let pv := mload(add(M_P, shl(5, v)))
                        if sgt(pv, best) {
                            best := pv
                            n := v
                        }
                    }
                    leave
                }
                let k := div(4096, t)
                if iszero(k) { k := 1 }
                let tot := 0
                for { let v := 0 } lt(v, 32) { v := add(v, 1) } {
                    let a := add(M_P, shl(5, v))
                    let pv := mload(a)
                    let q := pv
                    for { let z := 1 } lt(z, k) { z := add(z, 1) } { q := sdiv(mul(q, pv), 4096) }
                    mstore(a, q)
                    tot := add(tot, q)
                }
                if slt(tot, 1) { leave }
                let pick := mod(x, tot)
                let acc := 0
                for { let v := 0 } lt(v, 32) { v := add(v, 1) } {
                    acc := add(acc, mload(add(M_P, shl(5, v))))
                    if slt(pick, acc) {
                        n := v
                        leave
                    }
                }
            }
            nx := samp(temp, rr)
        }
    }

    // ---------------- learning ----------------
    /// One lesson: slides a 3-char window over `text` and takes one gradient step on the batch.
    function teach(bytes calldata text, address by, bytes32 ref) external {
        if (msg.sender != teacher) revert NotTeacher();
        uint256 n = text.length;
        if (n < 4 || n > 64) revert BadLength();
        _load(true);
        uint256 ex = n - 3;
        int256 probSum;
        unchecked {
            uint256 c0 = _code(uint8(text[0]));
            uint256 c1 = _code(uint8(text[1]));
            uint256 c2 = _code(uint8(text[2]));
            for (uint256 t = 3; t < n; t++) {
                uint256 tg = _code(uint8(text[t]));
                _fwd(c0, c1, c2);
                probSum += _bwd(c0, c1, c2, tg);
                c0 = c1;
                c1 = c2;
                c2 = tg;
            }
        }
        uint256 L = lessons;
        uint256 r;
        assembly ("memory-safe") {
            mstore(M_END_T, L)
            calldatacopy(add(M_END_T, 32), text.offset, n)
            r := keccak256(M_END_T, add(n, 32))
        }
        _apply(r, ex);
        unchecked {
            L += 1;
            lessons = L;
            examplesSeen += ex;
        }
        emit Lesson(L, by, ref, ex, probSum / int256(ex), text);
    }

    // ---------------- speaking (free, read-only) ----------------
    function speak(bytes calldata prompt, uint256 n, uint256 seed, uint256 tempQ12)
        external
        view
        returns (string memory)
    {
        if (n > 200) revert TooLong();
        if (tempQ12 != 0 && tempQ12 < 256) revert BadRate();
        _load(false);
        bytes memory o = new bytes(n);
        uint256 L = prompt.length;
        uint256 c0 = L > 2 ? _code(uint8(prompt[L - 3])) : 0;
        uint256 c1 = L > 1 ? _code(uint8(prompt[L - 2])) : 0;
        uint256 c2 = L > 0 ? _code(uint8(prompt[L - 1])) : 0;
        uint256 r = uint256(keccak256(abi.encode(seed)));
        unchecked {
            for (uint256 i = 0; i < n; i++) {
                _fwd(c0, c1, c2);
                r = r * 6364136223846793005 + 1442695040888963407;
                uint256 nx = _sample(tempQ12, r >> 64);
                bytes32 a = ALPHA;
                assembly ("memory-safe") { mstore8(add(add(o, 32), i), byte(nx, a)) }
                c0 = c1;
                c1 = c2;
                c2 = nx;
            }
        }
        return string(o);
    }

    /// average probability (Q12) the brain gives the correct next char over `text` (free check)
    function score(bytes calldata text) external view returns (int256) {
        uint256 n = text.length;
        if (n < 4) revert BadLength();
        _load(false);
        int256 tot;
        unchecked {
            uint256 c0 = _code(uint8(text[0]));
            uint256 c1 = _code(uint8(text[1]));
            uint256 c2 = _code(uint8(text[2]));
            for (uint256 t = 3; t < n; t++) {
                uint256 tg = _code(uint8(text[t]));
                _fwd(c0, c1, c2);
                tot += _p(tg);
                c0 = c1;
                c1 = c2;
                c2 = tg;
            }
        }
        return tot / int256(n - 3);
    }
}
