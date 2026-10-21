// Chain access: provider, Brain contract (read-only + teacher signer), token contract.
import { JsonRpcProvider, Network, Wallet, Contract, FetchRequest } from 'ethers';
import { loadBrainAbi, ERC20_ABI } from './brainAbi.js';

export function createChain(config, log = console) {
  const network = new Network('robinhood', config.chainId);
  const req = new FetchRequest(config.rpcUrl);
  req.timeout = 60000; // speak/score are heavy view calls
  const provider = new JsonRpcProvider(req, network, { staticNetwork: network, batchMaxCount: 1 });

  const { abi, source } = loadBrainAbi();
  const wallet = config.teacherPrivateKey ? new Wallet(config.teacherPrivateKey, provider) : null;
  const brain = config.brainAddress ? new Contract(config.brainAddress, abi, provider) : null;
  const brainSigner = brain && wallet ? brain.connect(wallet) : null;
  const token = config.tokenAddress ? new Contract(config.tokenAddress, ERC20_ABI, provider) : null;

  log.log(`[chain] rpc ${config.rpcUrl} chain ${config.chainId}, brain abi from ${source}` +
    (wallet ? `, teacher ${wallet.address}` : ', no teacher key'));

  let decimalsCache = null;
  async function tokenDecimals() {
    if (decimalsCache != null) return decimalsCache;
    if (!token) return config.tokenDecimals;
    try {
      decimalsCache = Number(await token.decimals());
    } catch (e) {
      log.warn('[chain] decimals() failed, using TOKEN_DECIMALS:', short(e));
      return config.tokenDecimals;
    }
    return decimalsCache;
  }

  return { provider, wallet, teacherAddress: wallet ? wallet.address : null, brain, brainSigner, token, tokenDecimals, abiSource: source };
}

export function short(e) {
  if (!e) return 'unknown error';
  return (e.shortMessage || e.reason || e.message || String(e)).slice(0, 200);
}
