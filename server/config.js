// All settings live here. Only TOKEN_ADDRESS, BRAIN_ADDRESS, TEACHER_PRIVATE_KEY and
// MONGODB_URI have no default; everything else can be overridden from the environment.
import 'dotenv/config';
import { isAddress, getAddress } from 'ethers';

const env = process.env;

function str(name, def) {
  const v = env[name];
  return v === undefined || String(v).trim() === '' ? def : String(v).trim();
}
function num(name, def) {
  const v = Number(str(name, ''));
  return Number.isFinite(v) && str(name, '') !== '' ? v : def;
}
function addr(name) {
  const v = str(name, '');
  if (!v || !isAddress(v)) {
    if (v) console.warn(`[config] ${name} is not a valid address, treating as not set`);
    return null;
  }
  const a = getAddress(v);
  return a === '0x0000000000000000000000000000000000000000' ? null : a;
}
function key(name) {
  let v = str(name, '');
  if (!v) return null;
  if (!v.startsWith('0x')) v = '0x' + v;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    console.warn(`[config] ${name} is not a 32 byte hex key, treating as not set`);
    return null;
  }
  return v;
}

const tokenAddress = addr('TOKEN_ADDRESS');

export const config = {
  name: str('NAME', 'Pip'),
  ticker: str('TICKER', 'PIP'),

  port: num('PORT', 3000),
  rpcUrl: str('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  chainId: num('CHAIN_ID', 4663),
  explorer: str('EXPLORER', 'https://robinhoodchain.blockscout.com').replace(/\/+$/, ''),
  xUrl: str('X_URL', 'https://x.com/pipsaysfun'),
  githubUrl: str('GITHUB_URL', null),

  tokenAddress,
  brainAddress: addr('BRAIN_ADDRESS'),
  teacherPrivateKey: key('TEACHER_PRIVATE_KEY'),
  buyUrl: str('BUY_URL', tokenAddress ? `https://www.ponsfamily.com/launchpad/${tokenAddress}` : null),

  burnPerLesson: num('BURN_PER_LESSON', 100000),
  tokenDecimals: num('TOKEN_DECIMALS', 18),
  deadAddress: '0x000000000000000000000000000000000000dEaD',
  burnMaxAgeSec: 3 * 24 * 3600,

  lessonEverySec: num('LESSON_EVERY_SEC', 60),
  lessonChars: Math.max(8, Math.min(64, num('LESSON_CHARS', 48))),
  maxSentence: num('MAX_SENTENCE', 120),
  minBalanceEth: str('MIN_BALANCE_ETH', '0.0003'),
  maxGasGwei: str('MAX_GAS_GWEI', '0.25'), // lessons pause while chain gas is above this

  mongoUri: str('MONGODB_URI', null),
  mongoDb: str('MONGODB_DB', 'pip'),
};

// Public view of the config (served at /api/config). Never includes secrets.
export function publicConfig() {
  return {
    name: config.name,
    ticker: config.ticker,
    tokenAddress: config.tokenAddress,
    brainAddress: config.brainAddress,
    buyUrl: config.buyUrl,
    explorer: config.explorer,
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    burnPerLesson: config.burnPerLesson,
    deadAddress: config.deadAddress,
    xUrl: config.xUrl,
    githubUrl: config.githubUrl,
    lessonChars: config.lessonChars,
    maxSentence: config.maxSentence,
  };
}
