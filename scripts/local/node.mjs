// Starts a local EVM on 127.0.0.1:8545 that mimics Robinhood Chain:
// chain id 4663, 32,000,000 block gas limit, automine, 0.02 gwei base fee.
//
// Engine: anvil (Foundry) by default. The binary is downloaded once from the Foundry GitHub
// release into scripts/local/bin/anvil if missing. Set LOCAL_NODE=hardhat to use the Hardhat
// node instead (works, but is much slower on the Brain's heavy view calls and can drop requests).
//
// Usage: npm run local:node   (or: node scripts/local/node.mjs [port])
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const defaultPort = String((isMain && process.argv[2]) || process.env.LOCAL_NODE_PORT || 8545);

export const ANVIL_BIN = path.join(here, 'bin', 'anvil');
const FOUNDRY_URL = 'https://github.com/foundry-rs/foundry/releases/download/v1.5.1/foundry_v1.5.1_linux_amd64.tar.gz';

export function ensureAnvil() {
  if (fs.existsSync(ANVIL_BIN)) return ANVIL_BIN;
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('auto download only for linux x64; install Foundry and copy anvil to ' + ANVIL_BIN);
  fs.mkdirSync(path.dirname(ANVIL_BIN), { recursive: true });
  const tgz = path.join(path.dirname(ANVIL_BIN), 'foundry.tar.gz');
  console.log(`[node] downloading anvil from ${FOUNDRY_URL}`);
  execFileSync('curl', ['-sSfL', '-o', tgz, FOUNDRY_URL], { stdio: 'inherit' });
  execFileSync('tar', ['xzf', tgz, '-C', path.dirname(ANVIL_BIN), 'anvil'], { stdio: 'inherit' });
  fs.rmSync(tgz, { force: true });
  return ANVIL_BIN;
}

export function engine() {
  return (process.env.LOCAL_NODE || 'anvil').toLowerCase() === 'hardhat' ? 'hardhat' : 'anvil';
}

export function startNode({ port = defaultPort, stdio = 'inherit' } = {}) {
  if (engine() === 'anvil') {
    const bin = ensureAnvil();
    return spawn(bin, [
      '--host', '127.0.0.1', '--port', String(port),
      '--chain-id', '4663',
      '--gas-limit', '32000000',
      '--base-fee', '20000000', // 0.02 gwei
      '--hardfork', 'cancun',
      '--code-size-limit', '49152',
      '--accounts', '10', '--balance', '10000',
      '--silent',
    ], { cwd: here, stdio });
  }
  const bin = path.join(root, 'node_modules', 'hardhat', 'internal', 'cli', 'bootstrap.js');
  return spawn(process.execPath, [bin, '--config', path.join(here, 'hardhat.config.cjs'), 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: here, stdio, env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' },
  });
}

if (isMain) {
  const child = startNode();
  console.log(`[node] ${engine()} on http://127.0.0.1:${defaultPort} (chain 4663, 32M gas, automine)`);
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}
