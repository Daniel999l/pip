// Deploys Brain with a random seed; teacher = deployer address.
// Env: TEACHER_PRIVATE_KEY (required), RPC_URL (default Robinhood Chain mainnet).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from 'ethers';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { (await import('dotenv')).config({ path: path.join(root, '.env'), quiet: true }); } catch {}

const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = process.env.EXPLORER || 'https://robinhoodchain.blockscout.com';
const pk = process.env.TEACHER_PRIVATE_KEY;
if (!pk) { console.error('TEACHER_PRIVATE_KEY is not set.'); process.exit(1); }

const artPath = path.join(root, 'contracts', 'Brain.json');
if (!fs.existsSync(artPath)) { console.error('contracts/Brain.json missing, run: npm run build'); process.exit(1); }
const { abi, bytecode } = JSON.parse(fs.readFileSync(artPath, 'utf8'));

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(pk.startsWith('0x') ? pk : '0x' + pk, provider);
const net = await provider.getNetwork();
const bal = await provider.getBalance(wallet.address);
console.log(`chain ${net.chainId}, deployer ${wallet.address}, balance ${formatEther(bal)} ETH`);

const seed = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
const factory = new ContractFactory(abi, bytecode, wallet);
const brain = await factory.deploy(seed, wallet.address, { gasLimit: 9_000_000n });
const tx = brain.deploymentTransaction();
console.log('tx:', tx.hash, `${EXPLORER}/tx/${tx.hash}`);
await brain.waitForDeployment();
const addr = await brain.getAddress();
console.log('\nBrain deployed at', addr);
console.log(`${EXPLORER}/address/${addr}`);
console.log(`seed ${seed}`);
console.log(`\nPut this in your environment: BRAIN_ADDRESS=${addr}`);
