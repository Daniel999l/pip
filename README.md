# Pip

Pip is an AI that is learning to talk entirely on-chain, out in the open.

It was born knowing nothing. Its whole brain, a small neural network of 2,112 numbers, lives inside a smart contract on Robinhood Chain. Every lesson is a transaction: the contract reads a short piece of text, checks how well it guessed each next letter, and updates its own numbers. Nothing is trained off-chain and nothing is uploaded. Anyone can read the brain, make it speak, and check every lesson ever taught.

Site: [pipsays.fun](https://pipsays.fun) . X: [@pipsaysfun](https://x.com/pipsaysfun)

## How Pip learns

- **Trading fees are its food.** Lessons cost gas. Trading fees top up the teacher wallet that pays for them, so more trading means more lessons and a faster learner.
- **The starter book.** When nobody is teaching, Pip reads the next piece of its starter book (`server/book/book.txt`).
- **Burn to teach.** A holder connects their wallet, writes a sentence, burns $PIP and signs a message. The server checks on-chain that the burn is real and that the signer is the wallet that burned. Holder sentences are taught before the book.
- **Talking is free.** `speak()` is a read-only call, so anyone can ask Pip to write something without paying.

## What a lesson costs

| Lesson size | Gas |
| --- | --- |
| 16 characters | about 3.3M |
| 32 characters | about 4.8M |
| 48 characters (default) | about 6.2M |
| 64 characters | about 7.7M |

Lessons pause automatically while chain gas is above `MAX_GAS_GWEI`, so a gas spike can't drain the wallet.

## How to check that it is real

- Read the brain on the explorer: `slots(i)` or `weights()` return every number in it.
- Call `speak(prompt, n, seed, temp)` on the explorer and watch it write.
- Every lesson emits a `Lesson` event with the text, who taught it and how often Pip guessed right. Each one is linked from the site.
- Run `npm run bench` to deploy the brain in a local EVM, train it and measure the gas yourself.

## Run it

```
npm install
cp .env.example .env     # then fill in the values
npm start
```

Open `http://localhost:3000`. With no addresses set, the site still runs and shows that the contracts are not deployed yet.

## Deploy the brain

```
npm run build            # compiles contracts/Brain.sol into contracts/Brain.json
npm run deploy           # deploys with TEACHER_PRIVATE_KEY and prints the address
```

Put the printed address in `BRAIN_ADDRESS` and restart the server.

## Values you must set

| Name | What it is |
| --- | --- |
| `TOKEN_ADDRESS` | The $PIP token |
| `BRAIN_ADDRESS` | The deployed Brain contract |
| `TEACHER_PRIVATE_KEY` | Wallet that pays for lessons |
| `MONGODB_URI` | Where the queue and lesson history are stored |
| `GITHUB_URL` | Link to this repo, shown on the site |
| `FEE_WALLET_PRIVATE_KEY`, `FEED_PERCENT` | Optional: forward part of new trading fees to the teacher wallet (see `docs/fee-forwarder.md`) |

## Defaults you can override

| Name | Default | What it does |
| --- | --- | --- |
| `PORT` | 3000 | Port the server listens on |
| `RPC_URL` | https://rpc.mainnet.chain.robinhood.com | Chain RPC endpoint |
| `CHAIN_ID` | 4663 | Chain id |
| `EXPLORER` | https://robinhoodchain.blockscout.com | Explorer used for links |
| `BUY_URL` | Pons page built from `TOKEN_ADDRESS` | Where to buy the token |
| `X_URL` | https://x.com/pipsaysfun | X account |
| `TICKER` | PIP | Token ticker |
| `NAME` | Pip | Name |
| `BURN_PER_LESSON` | 100000 | Tokens burned to teach one sentence |
| `TOKEN_DECIMALS` | 18 | Token decimals (read from the token when possible) |
| `LESSON_EVERY_SEC` | 60 | Seconds between lessons |
| `LESSON_CHARS` | 48 | Characters per book lesson |
| `MAX_SENTENCE` | 120 | Longest sentence a holder can send |
| `MAX_GAS_GWEI` | 0.25 | Lessons pause while chain gas is above this |
| `MIN_BALANCE_ETH` | 0.0003 | Lessons pause below this teacher balance |
| `MONGODB_DB` | pip | Database name |

## API

All answers are JSON.

- `GET /api/config`: name, ticker, addresses, links and limits
- `GET /api/state`: lessons, level, teacher balance, lessons left, queue length, next lesson
- `GET /api/speak?seed=&prompt=&n=`: Pip writes some text
- `GET /api/lessons?limit=&before=`: past lessons with transaction links
- `GET /api/timeline`: what Pip wrote at each stage
- `GET /api/teach/message?txHash=&text=`: the exact message a holder signs
- `POST /api/teach` with `{ txHash, text, signature }`: teach Pip a sentence
- `GET /api/queue`: sentences waiting to be taught

## Repo layout

```
contracts/Brain.sol      the brain
contracts/build.mjs      compiles it
contracts/Brain.json     build output
scripts/deploy.mjs       deploys the brain
scripts/bench.mjs        local gas and learning test
server/                  the API and the teaching bot
server/book/book.txt     the starter book
public/                  the site
test/                    tests
```

## Deploy on Railway

One service, start command `npm start`, Node 20 or newer. Set the values above as variables.

## License

MIT
