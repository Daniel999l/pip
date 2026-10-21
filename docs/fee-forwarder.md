# Fee forwarder (optional)

Sends a slice of new creator fees to the teacher wallet, so the AI keeps getting lunch money without manual top-ups.

## Turn it on
Set `FEE_WALLET_PRIVATE_KEY` to the key of the wallet that receives the creator fees. Leave it empty and the module does nothing. The key is only read from the environment and is never logged or stored.

Required: `FEED_PERCENT` (0 to 100, no default; the forwarder does nothing until it is set). Overrides (these have defaults): `FEED_EVERY_SEC` 300, `FEED_MIN_ETH` 0.001, `FEE_GAS_RESERVE_ETH` 0.0005.

## What it does
Every tick it reads the fee wallet balance and compares it with a stored baseline (the balance after the last check or forward). New inflow = balance minus baseline. It sends `FEED_PERCENT` of that inflow to the teacher wallet, then stores the new balance as the baseline. Each forward (time, amount, tx hash) is saved, last 200 kept. `getStats()` returns `{ enabled, percent, totalForwardedEth, lastForwardAt, history }`.

## Edge cases
- First run only records the baseline. Money already in the wallet is never forwarded.
- If the balance drops below the baseline (you withdrew or spent), the baseline resets to the lower balance and nothing is sent.
- Only new inflow is shared. Amounts under `FEED_MIN_ETH` wait and add up until they are big enough.
- The fee wallet always keeps at least `FEE_GAS_RESERVE_ETH` after the send and its gas. If it cannot, the tick is skipped.
- On Pons, creator fees may need claiming first. Whatever lands in this wallet counts as inflow, so claim to this wallet.
- Failed sends are logged and retried next tick; the baseline is not moved. Errors never stop the server.
- Without store meta helpers (`getMeta` / `setMeta`) state lives in memory, so a restart re-takes the baseline.
