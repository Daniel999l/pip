// Brain ABI. Prefers contracts/Brain.json (compiled build output) when it exists, otherwise
// uses a human-readable ABI matching contracts/Brain.sol.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(here, '..', 'contracts', 'Brain.json');

export const FALLBACK_BRAIN_ABI = [
  'constructor(uint256 seed, address teacher)',
  'function owner() view returns (address)',
  'function teacher() view returns (address)',
  'function lessons() view returns (uint256)',
  'function examplesSeen() view returns (uint256)',
  'function lr() view returns (int256)',
  'function slots(uint256) view returns (uint256)',
  'event Lesson(uint256 indexed n, address indexed by, bytes32 indexed ref, uint256 examples, int256 avgTargetProbQ12, bytes text)',
  'function teach(bytes text, address by, bytes32 ref)',
  'function speak(bytes prompt, uint256 n, uint256 seed, uint256 tempQ12) view returns (string)',
  'function score(bytes text) view returns (int256)',
  'function setTeacher(address t)',
  'function setLr(int256 v)',
  'function transferOwnership(address o)',
];

export function loadBrainAbi() {
  try {
    if (fs.existsSync(JSON_PATH)) {
      const j = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      if (Array.isArray(j.abi) && j.abi.length) return { abi: j.abi, source: 'contracts/Brain.json' };
    }
  } catch (e) {
    console.warn('[abi] could not read contracts/Brain.json, using built-in ABI:', e.message);
  }
  return { abi: FALLBACK_BRAIN_ABI, source: 'built-in' };
}

export const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)',
];
