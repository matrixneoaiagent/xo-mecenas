# Findings

Concrete, reproduced observations from building and running XO Mecenas end to
end on Chipnet. Each item says what worked, what was confusing, what is
missing, or includes a reproduction for a bug. Several were already visible
while building this repository's sibling, Layaway Jar; they are re-confirmed
here independently (marked **repeat**) because a relative-locktime (CSV)
covenant with two parties exercises the engine differently than a
single-party, balance-watermark covenant.

## 1. Relative-locktime (BIP68/CSV) spends can be rejected as `non-BIP68-final`
   well past the point simple confirmation counting says they should work

**What happened.** `withdraw`'s covenant requires `this.age >= periodBlocks`
(`<periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP`), with `periodBlocks = 1`.
The ancestor (`createMecenas`) transaction
`9be34854c7708a50500f0225275c7549f29634616ba0d430410a061202b38294` confirmed
in block `336,913`. Two independent Chipnet Electrum servers
(`chipnet.imaginary.cash` and `chipnet.bch.ninja`), queried directly over raw
Electrum RPC, both reported the transaction had **9 confirmations** (chain tip
at query time: height `336,919`–`336,921`) — far more than a `periodBlocks = 1`
requirement should ever need (by the textbook BIP68 formula, `tip >=
ancestorHeight + period - 1`, one confirmation is already sufficient). Despite
this, broadcasting the correctly-built, correctly-signed withdraw transaction
(`sequenceNumber = 1`, `version = 2`, verified independently via libauth's own
VM) was rejected by **both** servers with `the transaction was rejected by
network rules. non-BIP68-final (code 64)`.

**Reproduction.**
```bash
BROADCAST=1 MECENAS_TXID=9be34854c7708a50500f0225275c7549f29634616ba0d430410a061202b38294 \
  MECENAS_VOUT=0 MECENAS_SATS=20000 PLEDGE_SATS=5000 PERIOD_BLOCKS=1 \
  RECIPIENT_SCRIPT=<hex> npm run withdraw
```
Immediately after the ancestor's first confirmation, this failed with
`non-BIP68-final`. Retrying the identical command every ~60 seconds
eventually succeeded (txid
`c9b4c9b978a23b8aa1afaec505ac7a9d8b29227cad1f0608a24f41a3e06f622c`), after
more elapsed wall-clock time than the confirmation counts alone would predict.
The `@electrum-cash/checkpoint` package's own source comments that chipnet
"operators reorg the chain back to height 10,000 about twice a year so the
history stays downloadable" — a plausible root cause: nodes recovering from
or indexing around such a reset may have temporarily inconsistent per-UTXO
confirmation-height bookkeeping even while ordinary confirmation *counts*
look normal.

**Why it matters.** Anyone building a CSV-gated XO covenant should budget
extra margin and a retry loop around the first spend after the age gate
opens, rather than assuming "N confirmations observed == spend will be
accepted." This is environmental (Chipnet-side), not a template bug, but it
is exactly the kind of integration surprise this bounty's "demonstrate it on
Chipnet" requirement is meant to surface.

**This pattern repeated three times in the same run**, not as a one-off
fluke: each of the three sequential `withdraw`/`withdrawFinal` rounds in the
final Chipnet run (txids
`c9b4c9b978a23b8aa1afaec505ac7a9d8b29227cad1f0608a24f41a3e06f622c`,
`e01111767b0a601150ad37452321a55279934a84079d315da8bd707f10520bfa`,
`84eb5ffeccdb7bafc065047fca2a4ebacc45d2b23590517dbea03a1d90ac9c5c`) needed
roughly 10-12 retries, one per minute, after its ancestor's first
confirmation before the identical, unchanged transaction was accepted —
consistently well beyond what `periodBlocks = 1` should require by the
textbook BIP68 formula.

## 2. Over-cap withdrawal is rejected at both the VM and network level (the required negative test)

**What happened.** `scripts/reject-overcap.ts` deliberately builds a
`withdraw` invitation that pays the recipient `pledgeSatoshis + 2000` instead
of the committed `pledgeSatoshis`. Both:

- libauth's BCH VM (the same evaluator Chipnet nodes run), run locally before
  any broadcast: **rejected**, `Program failed an OP_VERIFY operation.`
- An actual Chipnet broadcast attempt of that exact transaction: **rejected**
  by network rules.

**Reproduction.**
```bash
MECENAS_TXID=<covenant txid> MECENAS_VOUT=0 MECENAS_SATS=20000 PLEDGE_SATS=5000 \
  PERIOD_BLOCKS=1 RECIPIENT_SCRIPT=<hex> OVERCAP_EXTRA_SATS=2000 \
  BROADCAST_INVALID=1 npm run reject-overcap
```
Artifacts: `artifacts/withdraw-overcap-rejected-invitation.json` and
`artifacts/withdraw-overcap-rejection-reason.txt`.

**Note on isolating the reason.** The first network attempt (made before the
ancestor had enough age; see finding 1) surfaced the *same*
`non-BIP68-final` message as an otherwise-valid withdraw would at that point
in time — i.e., the age gate and the pledge-cap check both reject, and the
node's error message does not distinguish *which* on-chain requirement
failed. Isolating the pledge-cap-specific rejection message required
re-running the negative test once the covenant input had unambiguous age.
This is itself worth knowing: **a generic Electrum rejection reason does not
tell you which `require()` failed**; libauth's local VM evaluation
(`Program failed an OP_VERIFY operation.` at a specific instruction) is the
more actionable signal during development.

## 3. `XOTemplateInput.sequenceNumber` is schema-valid but silently ignored by the engine

**What happened.** `XOTemplateInput` (the template-level input declaration)
accepts a `sequenceNumber` field (`number | string`, the latter a CashASM
expression). This template's `withdrawInput` declares one conceptually (the
relative-locktime requirement is intrinsic to the action). But
`completeMergedInput` in `@xo-cash/engine` (`source/invitation/merge/complete.ts`)
only ever applies `DEFAULT_SEQUENCE_NUMBER` (`0`) when a *commit* leaves
`sequenceNumber` unset — it never reads the matching field from the
*template's* input declaration. A CSV-gated covenant is therefore unusable
through the declarative template schema alone.

**Reproduction.** Build an invitation for `withdraw` without passing
`sequenceNumber` in the `inputs` array of `engine.createInvitation(...)`;
decode `engine.buildInvitationTransactionFromMergedCommit(...)`'s
`serializedTransaction` and observe `sequence = 0` in the input, regardless of
what the template documents. `scripts/withdraw.ts` works around this by
passing `sequenceNumber: periodBlocks` explicitly on every invitation-level
input commit.

## 4. Template constants are not exposed inside covenant scripts

**What happened.** Referencing a declared `constants` entry (e.g.
`<minerFeeSatoshis>`) from inside a `scripts` CashASM string throws
`Missing required variable: variableNames [minerFeeSatoshis]` when compiled
— even though the same identifier is declared, typed and valued under
`constants`. The compiler only resolves `variables`, not `constants`, inside
script bodies.

**Reproduction.** In `test/helpers/covenant.ts`'s `buildTestCovenant`, replace
any inlined `<1500>` literal with `<minerFeeSatoshis>` and re-run
`npm test`; every VM test fails to even compile the covenant.

**Workaround used.** The fee is inlined as the literal `<1500>` everywhere a
script needs it; `constants.minerFeeSatoshis` only documents the same number
for off-chain helpers (`source/types.ts`). The sibling Layaway Jar template
hit the identical limitation for its refund-fee cap, so this is a confirmed,
repeated pattern, not a one-off. **(repeat, independently reconfirmed)**

## 5. A commit's explicit output value silently overrides the template's own expression

**What happened.** `completeMergedOutput` in `@xo-cash/engine` only computes
an output's value from the template's `valueSatoshis` expression when the
commit does **not** already supply one. Supplying an explicit `valueSatoshis`
on a named output (e.g. `{ outputIdentifier: 'recipientPledgeOutput',
valueSatoshis: 7000n }`) silently wins, with no warning that the template's
own computed value was discarded.

**Reproduction.** This is exactly how `scripts/reject-overcap.ts` builds its
deliberately invalid transaction (finding 2) — useful here, as a controlled
negative-test tool. But it also means a typo or a stale cached value in
application code can silently desynchronize an output from the template's
intended math, with the engine never noticing until (if) the covenant itself
rejects the spend. An application author who is *not* deliberately testing
a negative case would want a lint/warning for "commit supplies a value that
conflicts with the template's own expression," which the engine does not
offer today.

## 6. Electrum header sync throws continuously and the engine's own view of a UTXO's mined height can read `0`

**What happened.** Every engine session against the shared Chipnet database
logs repeated errors of the shape:
```
Failed to synchronize block headers, will retry later: Error: Header '<hash>' at height 332451
claims target 486604799, expected 437753688.
Failed to process transaction update: Error: Could not validate a block header on height 332336:
The requested header is ahead of the current checkpoint at height 332335
```
even while `blockchain.transaction.get`/`blockchain.headers.subscribe`
(queried directly, bypassing the engine) correctly report current, consistent
chain state in the 336,900s. Separately, `engine.listUnspentOutputs()`
reported `minedAtHeight: 0` for a UTXO confirmed in block 336,913. This
points at the bundled `@electrum-cash/checkpoint` package's embedded chipnet
checkpoint data (last entry at height `302,144`) being out of step with the
live chain, consistent with its own source comment that chipnet operators
periodically reset the chain's history.

**Why it matters.** This is cosmetic noise most of the time (operations
still completed correctly in every case here, after retries), but it makes
debugging genuinely confusing: it is easy to misattribute a real
`non-BIP68-final` rejection (finding 1) to this unrelated, constantly-logged
header-sync error, or vice versa, when they are two separate problems that
happen to show up in the same terminal output at the same time.

## 7. `selectable: false` is still ignored for Electrum UTXOs **(repeat)**

Re-confirmed independently of Layaway Jar: the covenant output's role
declares `selectable: false`, yet `engine.listSpendableUnspentOutputs()`
still included it. Every script in this repository passes the covenant input
explicitly and never relies on automatic coin selection to exclude it.

## 8. Fee estimation does not account for P2SH32 unlocking bytecode size **(repeat, lower impact here)**

Re-confirmed: `engine.estimateTransactionFee` underestimates for a covenant
spend's large unlocking script. It mattered less for this template than for
Layaway Jar because `withdraw`/`withdrawFinal`/`reclaim`'s fees are either
covenant-fixed or chosen explicitly up front, but `createMecenas`'s ordinary
wallet-funded P2PKH input still benefits from the explicit `FEE_SATS`
override this repository's scripts support.

## 9. The debug tool (blaze.xo.cash) requires importing the template before any invitation resolves **(repeat)**

Re-confirmed: pasting an invitation JSON before importing
`fixtures/mecenas.template.json` produces `Template not found: import
template "<id>" before joining this invitation.` Once the template is
imported, every invitation in `artifacts/` (for `createMecenas`, `withdraw`,
`withdrawFinal`, `reclaim`, and the rejected over-cap test) previews cleanly.
This onboarding step is not obvious from the landing page.

## 10. No first-class modeling for "one on-chain branch, two off-chain transaction shapes"

**What's missing.** CashScript's `receive()` function has a single body with
an `if`/`else` that produces either one output or two, depending on the
run-time balance. XO's declarative `transactions` schema requires a fixed
output list per transaction definition, so this template needed **two**
actions (`withdraw`, `withdrawFinal`) that compile to the exact same redeem
bytecode and address, with `computeWithdrawSplit()` in application code
deciding which one to build. This works, and is documented, but there is no
template-level way to express "this action's output count depends on a
runtime value" — an application author migrating a branching CashScript
contract should expect to split it into multiple XO actions per distinct
output shape, which is not obvious before trying it.
