# Architecture

XO Mecenas is a migration of CashScript's ["Licho's Mecenas"](https://cashscript.org/docs/language/examples#lichos-mecenas)
recurring-payment covenant to an XO template. This document describes the
on-chain state model, the redeem-script branches, the fee model, and the parts
of the XO engine that shaped the implementation.

## 1. The original contract

```solidity
contract Mecenas(bytes20 recipient, bytes20 funder, int pledge, int period) {
    function receive() {
        require(this.age >= period);
        require(tx.inputs.length == 1);
        bytes25 recipientLockingBytecode = new LockingBytecodeP2PKH(recipient);
        require(tx.outputs[0].lockingBytecode == recipientLockingBytecode);

        int minerFee = 1000;
        int currentValue = tx.inputs[this.activeInputIndex].value;
        int changeValue = currentValue - pledge - minerFee;
        if (changeValue <= pledge + minerFee) {
            require(tx.outputs[0].value == currentValue - minerFee);
        } else {
            require(tx.outputs[0].value == pledge);
            require(tx.outputs[1].lockingBytecode == tx.inputs[this.activeInputIndex].lockingBytecode);
            require(tx.outputs[1].value == changeValue);
        }
    }

    function reclaim(pubkey pk, sig s) {
        require(hash160(pk) == funder);
        require(checkSig(s, pk));
    }
}
```

A funder deposits BCH to the contract's address. The recipient may call
`receive()` once the UTXO has aged at least `period` blocks
(`this.age`, a BIP68 relative locktime), paying themselves at most `pledge`
and sending the remainder back to the identical contract. Once the balance can
no longer fund another full round, `receive()` instead pays out everything and
the contract closes. The funder can call `reclaim()` at any time, with no age
requirement and no destination restriction, to cancel the arrangement.

CashScript's repository also ships a second, simplified copy at
[`examples/mecenas.cash`](https://github.com/CashScript/cashscript/blob/master/examples/mecenas.cash)
with the `this.age`/`period` check commented out "so it can be tested without
time requirements." This template keeps the age gate: it is the more
interesting XO demonstration (a real BIP68 relative locktime plus a
state-preserving covenant), and the bounty specifically calls out the
"periodic cap" behavior that the age gate provides.

## 2. Mapping CashScript to XO

| CashScript concept | XO equivalent | Notes |
|---|---|---|
| `contract Mecenas(recipient, funder, pledge, period)` constructor parameters | Template variables `recipientLockingScript`, `funderKey` (role secret), `pledgeSatoshis`, `periodBlocks`, committed into `mecenasScript.state.variables` | `funderPublicKeyHash` is derived from `funderKey.public_key` inside a `scripts` entry, the same pattern `source/layaway-jar.ts`'s sibling template uses for `saverPublicKeyHash`. |
| Two `function`s compiled into one redeem script with a selector | `scripts.mecenasRedeemBytecode = 'OP_IF enforceWithdraw OP_ELSE enforceFunderSignature OP_ENDIF'`, plus `unlockWithdraw` / `unlockReclaim` | The selector is the first (or last-pushed) stack item, exactly as `cashc` compiles multi-function contracts. |
| `require(this.age >= period);` | `scripts.enforceAge = '<periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP'` | Needs the spending transaction's input `sequenceNumber` set to (at least) `periodBlocks`. The XO *template* schema has a `sequenceNumber` field on `XOTemplateInput`, but the current engine does not read it when building an invitation (see §6); the scripts set it explicitly via `engine.createInvitation({ inputs: [{ sequenceNumber: periodBlocks }] })`. |
| `require(tx.inputs.length == 1);` | `scripts.enforceSingleInput = 'OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY'` | |
| One `receive()` function with two possible output shapes | **Two XO actions**, `withdraw` (2 outputs, continues the covenant) and `withdrawFinal` (1 output, closes it) | XO's `transactions` entries declare a fixed output list; a single CashScript function that sometimes has one output and sometimes two cannot be one XO transaction definition. Both actions compile to the exact same `mecenasScript` redeem bytecode and address; `source/types.ts`'s `computeWithdrawSplit()` picks which action to build. |
| `int minerFee = 1000;` (hardcoded local variable) | `constants.minerFeeSatoshis` (documentation) + the literal `<1500>` inlined directly in every script that needs it | Template `constants` are not exposed inside compiled covenant scripts by the current engine (see §6); the sibling Layaway Jar template hit the same limitation for its refund-fee cap. The value is raised from CashScript's original 1000 sats to 1500 sats to comfortably clear Chipnet's relay-fee floor for this template's larger (P2SH32, two-branch) redeem script. |
| `reclaim(pubkey pk, sig s)`, unconstrained outputs | Action `reclaim`, with a free `funderPayoutLockingScript` variable (not committed into the covenant's address) and a free `feeSatoshis` variable (only a documented minimum, no on-chain cap) | This is a deliberate asymmetry, inherited from the original contract: `withdraw`'s destination and fee are covenant-fixed; `reclaim`'s are chosen at spend time. |
| No uniqueness salt in the constructor | No synthetic salt added | Unlike Layaway Jar's `jarId`, Mecenas's four original parameters (recipient, funder, pledge, period) already make every instance's address unique in practice, because `funderKey` is generated fresh per instance. Reusing all four parameters reuses the address, exactly as it would with the original CashScript contract. |

## 3. Redeem script

```
OP_IF
    <periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP
    OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE <recipientLockingScript> OP_EQUALVERIFY
    <isFinalWithdraw math>
    OP_IF
        OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL
    OP_ELSE
        OP_0 OP_OUTPUTVALUE OP_BIN2NUM <pledgeSatoshis> OP_NUMEQUALVERIFY
        OP_1 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
        OP_1 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pledgeSatoshis> OP_SUB <1500> OP_SUB OP_NUMEQUAL
    OP_ENDIF
OP_ELSE
    OP_DUP OP_HASH160 <funderPublicKeyHash> OP_EQUALVERIFY OP_CHECKSIG
OP_ENDIF
```

`isFinalWithdraw` computes `currentValue <= 2*pledge + 2*fee`, algebraically
equivalent to the original's `changeValue <= pledge + minerFee`.

`unlockWithdraw` pushes a single `<1>` (true, selects the `receive()` branch;
no signature at all). `unlockReclaim` pushes
`<signature> <publicKey> <0>` (false, selects the `reclaim()` branch).

## 4. State model

| Value | Where it lives | Mutable? |
|---|---|---|
| `recipientLockingScript` | pushed as bytes inside the covenant | No |
| `funderKey`'s public key hash | pushed as bytes inside the covenant (via the `funderPublicKeyHash` script) | No |
| `pledgeSatoshis` | pushed as a VM number inside the covenant | No |
| `periodBlocks` | pushed as a VM number inside the covenant (the CHECKSEQUENCEVERIFY operand) | No |
| balance | the UTXO value | Yes; `withdraw` decreases it, `reclaim`/`withdrawFinal` close it |
| `mecenasSatoshis` | template variable, used for descriptions and output construction | Informational mirror only, like Layaway Jar's `jarSatoshis` |

## 5. Actions and variables

| Action | Inputs | Outputs | Required variables | Secrets |
|---|---|---|---|---|
| `createMecenas` | funding | `initialMecenasOutput` (+ change) | `mecenasSatoshis`, `pledgeSatoshis`, `periodBlocks`, `recipientLockingScript` | generates `funderKey` |
| `withdraw` | `withdrawInput` (sequenceNumber = `periodBlocks`) | `recipientPledgeOutput`, `mecenasRemainderOutput` | the four state values | none |
| `withdrawFinal` | `withdrawInput` (sequenceNumber = `periodBlocks`) | `recipientFinalOutput` | the four state values | none |
| `reclaim` | `reclaimInput` (sequenceNumber = final) | `funderReclaimOutput` | the four state values + `funderPayoutLockingScript` + `feeSatoshis` | `funderKey` |

`withdraw` and `withdrawFinal` share one on-chain branch
(`scripts.enforceWithdraw`); `source/types.ts`'s `computeWithdrawSplit()`
decides which action's transaction shape matches the covenant's current
balance, mirroring the original contract's own `if (changeValue <= pledge +
minerFee)` branch.

## 6. Engine limitations encountered

These were discovered through hands-on testing, not read from documentation.
Several are shared with the sibling Layaway Jar template; the CSV-specific
ones (6.1, 6.6) are new to this template.

1. **`XOTemplateInput.sequenceNumber` is accepted by the schema but ignored by
   the engine when resolving a template's declared inputs.** `completeMergedInput`
   in `@xo-cash/engine` only applies `DEFAULT_SEQUENCE_NUMBER` (`0`) when a
   commit leaves `sequenceNumber` unset; it never reads the template's own
   `sequenceNumber` field. A relative-locktime covenant (`this.age`/CSV) is
   unusable through the declarative template schema alone: every script in
   this repository sets `sequenceNumber` explicitly in the *invitation* input
   commit (`engine.createInvitation({ inputs: [{ ..., sequenceNumber }] })`),
   not in the template.
2. **Constants are not exposed inside covenant scripts.** Same limitation
   Layaway Jar hit for its refund-fee cap. `minerFeeSatoshis` is inlined as the
   literal `<1500>` everywhere it is used on-chain; `constants.minerFeeSatoshis`
   only documents the same value for off-chain code.
3. **Fee estimation ignores the P2SH32 unlocking bytecode size**, same as
   Layaway Jar. Because this template's fee is fixed (inlined in the covenant)
   rather than measured per spend, this mattered less here than in Layaway
   Jar, but it still applies to `createMecenas`'s ordinary wallet-funded input.
4. **`selectable: false` is ignored for Electrum UTXOs.** Same as Layaway Jar;
   scripts pass the covenant input explicitly and never rely on automatic
   coin selection to avoid it.
5. **Conditions are UI metadata, not enforcement.** `actions.withdraw.conditions`
   and `actions.withdrawFinal.conditions` describe which balance range each
   action applies to; the covenant's own `isFinalWithdraw` branch is the real
   authority, and the two must agree by construction (`computeWithdrawSplit`
   implements the exact same inequality).
6. **A commit's explicit `valueSatoshis` on a named output silently overrides
   the template's own output-value expression** (`completeMergedOutput` only
   fills in the template expression when the commit leaves `valueSatoshis`
   unset). This is how `scripts/reject-overcap.ts` constructs its deliberately
   invalid, over-cap withdrawal for the negative test -- useful here, but worth
   knowing: nothing stops a buggy application from doing this by accident.
7. **No VM check for single-party invitations in the engine.**
   `scripts/verify-tx.ts` runs libauth's VM before every broadcast, exactly as
   in Layaway Jar.
8. **A relative-locktime (BIP68) spend was rejected by Chipnet nodes as
   `non-BIP68-final` well past the naive confirmation-count threshold.** See
   `docs/FINDINGS.md` item 1 for the full reproduction: two independent Chipnet
   Electrum servers agreed the ancestor UTXO had 9+ confirmations (more than
   `periodBlocks = 1` should ever require), yet both rejected the same raw,
   correctly-signed transaction (`sequenceNumber = 1`, `version = 2`) with
   `non-BIP68-final`. This looks like a Chipnet-side relative-locktime/height
   bookkeeping inconsistency rather than a bug in this template; it is
   documented, not hidden.

## 7. Test strategy

- `test/template.test.ts`: parse/serialize identifier stability, required
  variables and secrets per action, the inlined fee literal, and
  `computeWithdrawSplit`/`computeReclaimValue` off-chain helpers.
- `test/vm.test.ts`: compiles the real CashASM with libauth, signs with real
  Schnorr keys, and evaluates both withdraw shapes, the age gate, the
  over-cap rejection, the wrong-destination and wrong-remainder rejections,
  and both reclaim paths (valid signature, and an absurdly large
  `periodBlocks` that would make `withdraw` permanently unusable, to show
  `reclaim` genuinely ignores the age gate).
- `test/import.test.ts`: optional engine import agreement
  (`Engine.importTemplate` derives the same template identifier as
  `generateTemplateIdentifier`), gated behind `XO_INTEGRATION=1` because it
  needs a live Chipnet connection.

The VM vectors are the strongest guarantee: they exercise the actual compiled
redeem script, not a reimplementation of its rules.
