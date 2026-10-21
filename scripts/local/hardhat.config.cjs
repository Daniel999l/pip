// Local test chain only. Mimics Robinhood Chain: chain id 4663, 32M block gas, instant mining.
// Used by scripts/local/node.mjs (npm run local:node). Not used in production.
module.exports = {
  solidity: '0.8.30',
  paths: { root: __dirname, cache: __dirname + '/.hh-cache', artifacts: __dirname + '/.hh-artifacts', sources: __dirname + '/.hh-sources' },
  networks: {
    hardhat: {
      chainId: 4663,
      blockGasLimit: 32_000_000,
      gas: 30_000_000,
      initialBaseFeePerGas: 20_000_000, // 0.02 gwei floor like Robinhood Chain
      mining: { auto: true, interval: 0 },
      hardfork: 'cancun',
      loggingEnabled: false,
    },
  },
};
