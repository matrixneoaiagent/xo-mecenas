# Reproduction guide

Everything below was run for real against Chipnet from this repository. No
step is simulated.

## 0. Setup

```bash
git clone https://github.com/matrixneoaiagent/xo-mecenas.git
cd xo-mecenas
npm install
export XO_WALLET=/path/to/your/chipnet-wallet.json   # { "mnemonic": "..." }
export XO_DB_PATH=./.xo-data                          # or any writable scratch dir
```

`XO_WALLET` must point at a JSON file with a `mnemonic` field for a funded
Chipnet wallet. Get Chipnet BCH from a faucet (e.g. `tbch.googol.cash` or
`chipnet.bch.ninja`) if needed.

## 1. Sanity checks

```bash
npm run typecheck
npm test                      # 19/19 unit tests
npm run fixtures:template     # prints: TEMPLATE_IDENTIFIER cc1209a1662e53660b236a1045e35bf180ee70f8ecc1288bf4051859fb38e191
XO_INTEGRATION=1 npm run test:integration   # needs a live Chipnet connection
```

## 2. Create a covenant (Mecenas A)

```bash
BROADCAST=1 MECENAS_SATS=20000 PLEDGE_SATS=5000 PERIOD_BLOCKS=1 npm run create
```

Copy `MECENAS_TXID` and `RECIPIENT_SCRIPT` from the output; these are needed
for every follow-up command. `PERIOD_BLOCKS=1` is deliberately small so the
demo does not require a long wait; production use should choose a period
appropriate to the real recurring-payment cadence (e.g. ~4320 blocks for
"monthly").

## 3. Withdraw, respecting the cap

Wait for the covenant's creating transaction to confirm, **then wait for at
least one additional block** (see `docs/FINDINGS.md` item 1: a relative
locktime of `period` blocks needs the chain tip to advance `period` blocks
*past* the confirming block, and Chipnet nodes were observed to reject a
spend as `non-BIP68-final` for longer than naive confirmation-counting would
suggest — retry on that specific error).

```bash
BROADCAST=1 MECENAS_TXID=<create-A txid> MECENAS_VOUT=0 \
  MECENAS_SATS=20000 PLEDGE_SATS=5000 PERIOD_BLOCKS=1 \
  RECIPIENT_SCRIPT=<recipient script hex> npm run withdraw
```

The script picks `withdraw` (continuing) or `withdrawFinal` (closing)
automatically via `computeWithdrawSplit()`. It prints `NEW_MECENAS_SATS` when
continuing; feed that, plus the new txid and `MECENAS_VOUT=1`, into the next
round. Repeat until `isFinal true` is printed (the covenant closes and
`npm run withdraw` has nothing further to do with that covenant instance).

## 4. Demonstrate the over-cap rejection (required negative test)

```bash
MECENAS_TXID=<covenant txid> MECENAS_VOUT=<vout> MECENAS_SATS=<balance> \
  PLEDGE_SATS=5000 PERIOD_BLOCKS=1 RECIPIENT_SCRIPT=<recipient script hex> \
  OVERCAP_EXTRA_SATS=2000 BROADCAST_INVALID=1 npm run reject-overcap
```

Expect `OVERCAP_REJECTED Program failed an OP_VERIFY operation.` from the
local libauth VM check, and (with `BROADCAST_INVALID=1`) a real Chipnet
rejection too. Never broadcasts a transaction that could actually succeed;
this is a read-only/rejected-on-purpose test.

## 5. Create a second covenant and reclaim it (no age requirement)

```bash
BROADCAST=1 MECENAS_SATS=8000 PLEDGE_SATS=3000 PERIOD_BLOCKS=100000 npm run create
# copy MECENAS_TXID (call it create-B) and RECIPIENT_SCRIPT

BROADCAST=1 MECENAS_TXID=<create-B txid> MECENAS_VOUT=0 \
  MECENAS_SATS=8000 PLEDGE_SATS=3000 PERIOD_BLOCKS=100000 \
  RECIPIENT_SCRIPT=<recipient script hex> npm run reclaim
```

`PERIOD_BLOCKS=100000` makes `withdraw` permanently unreachable (no realistic
wait would satisfy it); `reclaim` succeeds immediately regardless, proving it
genuinely has no age requirement. This reclaim was observed to succeed even
chained directly off the still-unconfirmed `createMecenas` transaction
(0-conf), and both transactions confirmed together in the very next block.

## 6. Debug tool

1. <https://blaze.xo.cash> → Chipnet account.
2. **Import Template** → paste `fixtures/mecenas.template.json` → **Import JSON**.
3. **Join Invitation** → paste any file from `artifacts/*-invitation.json` →
   **View invitation**.

`artifacts/` is gitignored (run-specific, no private key material). Re-running
any script regenerates the relevant invitation file.

## Final-run txids

See the table in [`README.md`](../README.md#chipnet-run) for the confirmed
txids from the run that backs this submission.
