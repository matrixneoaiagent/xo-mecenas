# XO Mecenas — a recurring-payment XO template

An XO migration of CashScript's
[**Licho's Mecenas**](https://cashscript.org/docs/language/examples#lichos-mecenas)
recurring-payment covenant. A funder pledges BCH into a P2SH32 covenant. Once
the covenant's UTXO has aged at least `periodBlocks` blocks
(`this.age >= period` in the original, a BIP68 relative locktime), the
recipient may withdraw at most `pledgeSatoshis` — no signature required, the
covenant itself is the authorization — and the remainder returns to the
identical covenant, resetting the age counter for the next period. If the
remaining balance can no longer fund another full pledge, the covenant pays
out everything that is left and closes. Separately, the funder can `reclaim`
the whole balance at any time, to any destination, with no age requirement:
the unconditional "cancel the subscription" escape hatch from the original
contract.

> **Chipnet only.** This repository contains no mainnet configuration. The
> included run scripts are dry-run by default and refuse to broadcast unless
> `BROADCAST=1` is set.

## Original project

- Docs: <https://cashscript.org/docs/language/examples#lichos-mecenas> and
  <https://cashscript.org/docs/design/covenants#restricting-p2pkh-and-p2sh>
- Source: <https://github.com/CashScript/cashscript> —
  [`examples/mecenas.cash`](https://github.com/CashScript/cashscript/blob/master/examples/mecenas.cash)
  ships a simplified copy with the age check removed "so it can be tested
  without time requirements." This template keeps the age gate: see
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1 for why.

## This XO implementation

- Repository: <https://github.com/matrixneoaiagent/xo-mecenas> (this repo)
- Full CashScript → XO mapping: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Findings for BCH BLAZE feedback: [`docs/FINDINGS.md`](docs/FINDINGS.md)

## Template identifier

```
cc1209a1662e53660b236a1045e35bf180ee70f8ecc1288bf4051859fb38e191
```

`parseTemplate` + `generateTemplateIdentifier` and `Engine.importTemplate`
produce the same identifier (verified against a live Chipnet engine; see
`test/import.test.ts`, run with `XO_INTEGRATION=1`).

Serialized template: [`fixtures/mecenas.template.json`](fixtures/mecenas.template.json).

## Covenant

| Action | On-chain rule | Signature |
|---|---|---|
| `createMecenas` | Creates the P2SH32 covenant output holding `mecenasSatoshis`. | funder (generates `funderKey`) |
| `withdraw` | Covenant input must be the tx's only input, aged ≥ `periodBlocks` blocks. Output 0 pays `recipientLockingScript` exactly `pledgeSatoshis`; output 1 carries the remainder back to the **identical covenant bytecode**. | none |
| `withdrawFinal` | Same age/single-input checks; the remaining balance cannot fund another pledge round, so output 0 pays `recipientLockingScript` everything minus the fixed miner fee and the covenant closes. | none |
| `reclaim` | No age requirement, no destination restriction. | funder |

`withdraw` and `withdrawFinal` are two different **off-chain transaction
shapes** for the **same on-chain branch** (`scripts.enforceWithdraw`); see
`computeWithdrawSplit()` in `source/types.ts` and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2/§5.

The redeem script (selector-style, mirroring how `cashc` compiles multiple
functions into one script):

```
OP_IF
    <periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP
    OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE <recipientLockingScript> OP_EQUALVERIFY
    if currentValue <= 2*pledge + 2*fee:
        output0.value == currentValue - fee
    else:
        output0.value == pledge
        output1.bytecode == input.bytecode && output1.value == currentValue - pledge - fee
OP_ELSE
    OP_DUP OP_HASH160 <funderPublicKeyHash> OP_EQUALVERIFY OP_CHECKSIG
OP_ENDIF
```

## Fee model

The original hardcodes `int minerFee = 1000;`. Template constants are not
exposed inside compiled covenant scripts by the current XO engine (the same
limitation the sibling Layaway Jar template documents for its refund-fee cap),
so the fee is inlined as the literal `<1500>` everywhere it is used on-chain —
raised slightly from the original's 1000 sats to comfortably clear Chipnet's
relay-fee floor for this template's larger (P2SH32, two-branch) redeem script.
`constants.minerFeeSatoshis` documents the same value for off-chain code.
`reclaim`'s fee is **not** covenant-fixed: it is a free `feeSatoshis` variable
with only a documented minimum, matching the original's unconstrained
`reclaim()` outputs.

## Repository layout

```
source/
  index.ts            public exports
  mecenas.ts           the XO template (CashASM covenant)
  types.ts             state types, computeWithdrawSplit/computeReclaimValue
test/
  helpers/covenant.ts  libauth VM harness (compiles the real CashASM)
  vm.test.ts           VM vectors: both withdraw shapes, age gate, over-cap
                       rejection, wrong destination/remainder, both reclaim
                       paths
  template.test.ts     parse/serialize, required variables/secrets per action
  import.test.ts       optional Engine.importTemplate agreement
fixtures/
  mecenas.template.json   serialized final template
scripts/
  lib/                 config, engine, artifacts helpers
  serialize-template.ts
  create.ts withdraw.ts reclaim.ts reject-overcap.ts verify-tx.ts
docs/ARCHITECTURE.md
docs/FINDINGS.md
docs/REPRODUCTION.md
.github/workflows/ci.yml
```

## Quick start

Requirements: Node.js 22+, a Chipnet Electrum connection, and a funded Chipnet
wallet file. The default test wallet is
`/tmp/opencode/xo_bounty/work_chipnet_wallet.json` (mode 600, testnet only; the
mnemonic is never printed or committed).

```bash
npm install            # or npm ci with the lockfile
npm run typecheck
npm test
npm run fixtures:template
```

`npm test` runs the unit suite (19 tests, 1 integration test skipped) and
skips the engine integration test. To run the integration test (needs a
Chipnet connection):

```bash
npm run test:integration
```

Observed locally: `tsc --noEmit` clean, **19/19 unit tests passing**
(`test/template.test.ts` + `test/vm.test.ts`), and the gated import test
passes with `XO_INTEGRATION=1` against a live Chipnet engine.

## Commands

All scripts read the wallet from `XO_WALLET` (default:
`/tmp/opencode/xo_bounty/work_chipnet_wallet.json`) and use Chipnet.

| Command | Purpose |
|---|---|
| `npm run fixtures:template` | Parse, validate, print the id, rewrite the fixture. |
| `npm run create` | Create a covenant (`MECENAS_SATS`, `PLEDGE_SATS`, `PERIOD_BLOCKS`). |
| `npm run withdraw` | Withdraw the pledge (or the final balance), picking the right action automatically. |
| `npm run reclaim` | Funder reclaims the full balance, no age requirement. |
| `npm run reject-overcap` | Demonstrates the covenant (and the real Chipnet network) rejecting an over-cap withdrawal attempt. |

Common environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `BROADCAST` | unset | Set to `1` to broadcast; anything else is a dry run. |
| `XO_DB_PATH` | `./.xo-data` | Engine database directory. |
| `MECENAS_SATS` | `20000` | Initial/current covenant balance. |
| `PLEDGE_SATS` | `5000` | Per-period pledge cap. |
| `PERIOD_BLOCKS` | `1` | Relative-locktime period, in blocks. |
| `MECENAS_TXID` / `MECENAS_VOUT` | — | Existing covenant outpoint. |
| `RECIPIENT_SCRIPT` | wallet receive policy | Recipient's locking script (hex). |
| `FEE_SATS` | `MINER_FEE_SATOSHIS + 500` | Reclaim fee (free choice; withdraw's fee is covenant-fixed). |
| `OVERCAP_EXTRA_SATS` | `2000` | How far over the pledge cap `reject-overcap` attempts to pay. |
| `BROADCAST_INVALID` | unset | `1` also attempts a real (expected-to-fail) Chipnet broadcast of the over-cap transaction. |

Full reproduction commands, including the exact sequence used for the final
run: [`docs/REPRODUCTION.md`](docs/REPRODUCTION.md).

## Debug tool

1. Open <https://blaze.xo.cash>, create/use an account and select **Chipnet**.
2. **Import the template first**: **Import Template** → paste
   `fixtures/mecenas.template.json` → **Import JSON**. A toast confirms
   `Template imported: XO Mecenas (<template id>)`.
3. **Join Invitation** → paste an invitation JSON from `artifacts/` into the
   **Invitation JSON** box → **View invitation**. The preview shows the
   action, invitation id, signed commits and inputs; no error banner.
4. Do not click **Accept invitation** unless you intend to add your signature.

Invitations cannot be resolved before the matching template is imported.
Screenshots: `docs/debug-tool/` (template import, invitation previews for
`createMecenas`, `withdraw`, `withdrawFinal`, `reclaim`, and the rejected
over-cap invitation).

## Chipnet run

All transactions below are real, broadcast Chipnet transactions (no mainnet,
no fabricated txids). Explorer: `https://chipnet.imaginary.cash/tx/<txid>`.
Screenshots: `docs/explorer/`.

| Step | Txid | Notes |
|---|---|---|
| create Mecenas A | `9be34854c7708a50500f0225275c7549f29634616ba0d430410a061202b38294` | 20,000 sats, pledge 5,000, period 1 block |
| withdraw A round 1 (partial) | `c9b4c9b978a23b8aa1afaec505ac7a9d8b29227cad1f0608a24f41a3e06f622c` | recipient 5,000, covenant carries 13,500 |
| withdraw A round 2 (partial) | *(filled after confirmation; see docs/REPRODUCTION.md)* | recipient 5,000, covenant carries 7,000 |
| withdraw A round 3 (final) | *(filled after confirmation)* | recipient 5,500, covenant closes |
| create Mecenas B | `36348b5d07ee22b83e01004690eaee7c6ed90ca84b4889d5e07886bb1066e95b` | 8,000 sats, pledge 3,000, period 100,000 blocks (deliberately unreachable) |
| reclaim B | `33306f44f601f767b56b4bc96f7713c1a016af99d49d06be93969627e4dd7a66` | funder reclaims 6,000 sats, despite the 100,000-block period, confirming reclaim ignores the age gate |

**Over-cap rejection (required negative test):** an attempt to withdraw 7,000
sats against Mecenas A's 5,000-sat pledge cap was rejected both locally, by
libauth's BCH VM (`Program failed an OP_VERIFY operation`), and by the live
Chipnet network when actually broadcast (`the transaction was rejected by
network rules`). See [`docs/FINDINGS.md`](docs/FINDINGS.md) item 2 for the
full detail, including the raw invitation and rejection reason.

## Limitations

These are engine/design constraints, not hidden TODOs. Full detail and
reproduction steps for the first two are in
[`docs/FINDINGS.md`](docs/FINDINGS.md).

1. **`XOTemplateInput.sequenceNumber` is schema-valid but engine-ignored.**
   Every relative-locktime spend sets `sequenceNumber` explicitly on the
   invitation input commit, not the template.
2. **Template constants are not exposed inside covenant scripts.** The miner
   fee is inlined as a literal.
3. **Fee estimator ignores P2SH32 unlocking bytecode size** for
   `createMecenas`'s ordinary wallet-funded input (the covenant spends
   themselves have a covenant-fixed fee, so this matters less here than in
   Layaway Jar).
4. **UTXO `selectable` flag is ignored by the Electrum UTXO ingest.** The
   covenant input is always passed explicitly.
5. **`withdraw`/`withdrawFinal` split is an off-chain concern.** One on-chain
   branch, two transaction shapes; see `docs/ARCHITECTURE.md` §2.
6. **No synthetic uniqueness salt.** Reusing the same four parameters reuses
   the same address, exactly like the original contract.
7. **`mecenasSatoshis` is informational.** The authoritative balance is the
   UTXO value.
8. **No merchant/recipient signature or receipt**, matching the original: the
   recipient is a fixed destination, not a party that proves anything.

## Security notes

- Testnet only. No mainnet address, key or transaction exists in this repo.
- Not audited. The covenant is covered by deterministic libauth VM tests, but
  that is not a substitute for an external review.
- The funder key controls `reclaim`, which is unconditional and
  unrestricted: losing it loses the ability to cancel early; leaking it lets
  the holder drain the covenant at any time, to any address.
- The recipient destination (`recipientLockingScript`) and the pledge/period
  are committed for the life of the covenant. Verify them before funding.
- Invitations contain only public commit data and signatures. They never
  contain the mnemonic or private key.
- Never commit `artifacts/`, `.xo-data/`, or the wallet file (all gitignored).

## CI

`.github/workflows/ci.yml` runs `npm install`, `npm run typecheck` and
`npm test` on Node 22. The integration test is opt-in because it needs a
Chipnet connection.

## License

MIT. See [LICENSE](LICENSE).
