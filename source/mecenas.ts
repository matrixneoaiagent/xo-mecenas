import type { XOTemplate } from '@xo-cash/types';

/**
 * XO Mecenas
 *
 * An XO template migration of CashScript's "Licho's Mecenas" recurring-payment
 * covenant (https://cashscript.org/docs/language/examples#lichos-mecenas,
 * https://github.com/CashScript/cashscript/blob/master/examples/mecenas.cash).
 *
 * A funder pledges BCH to a P2SH32 covenant. Once the covenant's UTXO has aged
 * at least `periodBlocks` blocks since its last confirmation (`this.age` in the
 * original CashScript), the recipient may withdraw at most `pledgeSatoshis`;
 * the remainder returns to the *same* covenant bytecode, which resets the age
 * counter for the next period. No signature is required for a withdrawal: the
 * on-chain covenant itself is the entire authorization, which is the point of
 * a covenant.
 *
 * If the remaining balance after a withdrawal would be too small to fund
 * another full pledge, the covenant instead pays the recipient everything
 * that is left (minus the miner fee) and the covenant is fully spent.
 *
 * Separately, the funder can `reclaim` the full balance at any time, to any
 * destination of their choosing, by signing with `funderKey`. Reclaim has no
 * age requirement and no destination restriction: it is the funder's
 * unconditional "cancel the subscription" escape hatch, exactly as in the
 * original contract.
 *
 * On-chain rules (mirroring `receive()` / `reclaim()` in the CashScript
 * original):
 * - withdraw: the covenant input must be the transaction's only input and
 *   must have aged at least `periodBlocks` blocks (OP_CHECKSEQUENCEVERIFY).
 *   Output 0 must pay `recipientLockingScript`. If the balance left after
 *   paying the pledge and the fixed miner fee would not cover another pledge
 *   round, output 0 instead takes the whole balance minus the fee and the
 *   covenant closes. Otherwise output 0 pays exactly `pledgeSatoshis` and
 *   output 1 carries the remainder back to the identical covenant bytecode.
 * - reclaim: output(s) are unconstrained by the covenant. Only a valid
 *   Schnorr signature from `funderKey` is required.
 *
 * Every instance's address is fully determined by `recipientLockingScript`,
 * `funderKey`'s public key hash, `pledgeSatoshis` and `periodBlocks` -- the
 * same four parameters the original CashScript contract takes as constructor
 * arguments. There is no extra uniqueness salt (unlike this repository's
 * sibling Layaway Jar template): the original contract has none either, and
 * two funders who reuse the same four parameters are expected to reuse the
 * same address, exactly as on mainnet CashScript deployments.
 */
export const mecenasTemplate: XOTemplate = {
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',

    name: 'XO Mecenas',
    description: 'Recurring BCH payments: a funder pledges BCH, a recipient withdraws a capped amount once per period, and the remainder stays in the covenant. The funder can reclaim at any time.',
    icon: 'mecenas',

    version: '1',
    supported: [ 'BCH_2023_05', 'BCH_2024_05', 'BCH_2025_05', 'BCH_2026_05' ],

    resources: [
        {
            name: 'XO template documentation',
            description: 'Guide to writing XO templates.',
            url: 'https://stack.xo.cash/blog/2026-08-24-Vision-to-Reality-6-Writing-Templates.html',
        },
        {
            name: "Original contract: Licho's Mecenas (CashScript)",
            description: 'The CashScript recurring-payment covenant this template migrates, with the on-chain state model explained.',
            url: 'https://cashscript.org/docs/language/examples#lichos-mecenas',
        },
        {
            name: 'Original contract source (examples/mecenas.cash)',
            description: 'The CashScript/cashscript repository example this template is modeled after.',
            url: 'https://github.com/CashScript/cashscript/blob/master/examples/mecenas.cash',
        },
    ],

    roles: {
        funder: {
            name: 'Funder',
            description: 'Pledges BCH to the covenant and can reclaim the full balance at any time.',
            icon: 'funder',
        },
        recipient: {
            name: 'Recipient',
            description: 'Receives the capped periodic pledge. Withdrawing needs no signature: the covenant enforces the payout.',
            icon: 'recipient',
        },
    },

    start: [
        {
            action: 'createMecenas',
            role: 'funder',
            generate: [ 'funderKey' ],
        },
    ],

    actions: {
        createMecenas: {
            name: 'Create Mecenas Covenant',
            description: 'Fund a new recurring-payment covenant for a recipient, with a periodic pledge cap.',
            icon: 'mecenas',

            roles: {
                funder: {
                    name: 'Fund covenant',
                    description: 'Choose the recipient, the periodic pledge and the period length, and deposit the initial balance.',
                    icon: 'funder',

                    generate: [ 'funderKey' ],

                    requirements: {
                        variables: [ 'mecenasSatoshis', 'pledgeSatoshis', 'periodBlocks', 'recipientLockingScript' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'funder', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'createMecenasTransaction',
        },

        // The on-chain covenant compiles both withdraw shapes into one
        // enforceWithdraw IF/ELSE branch (see scripts.enforceWithdraw below).
        // Off-chain, an application must pick which *shape* of transaction to
        // build, because a continuing withdrawal has two outputs and a final
        // withdrawal has one: computeWithdrawSplit() in source/types.ts picks
        // the right action. Both compile to the exact same redeem bytecode and
        // address; `withdraw` vs `withdrawFinal` is purely a transaction-shape
        // choice, not a different covenant.
        withdraw: {
            name: 'Withdraw Pledge',
            description: 'Pay the recipient the periodic pledge; the remainder continues in the same covenant. No signature required: the covenant enforces the payout.',
            icon: 'withdraw',

            roles: {
                recipient: {
                    requirements: {
                        variables: [ 'mecenasSatoshis', 'pledgeSatoshis', 'periodBlocks', 'recipientLockingScript' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'recipient', slots: { min: 1, max: 1 } },
                ],
            },

            // UI/application gates mirroring the on-chain age and value checks.
            // The covenant itself is the real enforcement; see docs/ARCHITECTURE.md.
            conditions: [
                '$(OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pledgeSatoshis> <pledgeSatoshis> OP_ADD <1500> OP_ADD <1500> OP_ADD OP_GREATERTHAN)',
            ],

            transaction: 'withdrawTransaction',
        },

        withdrawFinal: {
            name: 'Withdraw Final Balance',
            description: 'The remaining balance cannot cover another pledge round: pay the recipient everything minus the miner fee and close the covenant.',
            icon: 'withdraw',

            roles: {
                recipient: {
                    requirements: {
                        variables: [ 'mecenasSatoshis', 'pledgeSatoshis', 'periodBlocks', 'recipientLockingScript' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'recipient', slots: { min: 1, max: 1 } },
                ],
            },

            conditions: [
                '$(OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pledgeSatoshis> <pledgeSatoshis> OP_ADD <1500> OP_ADD <1500> OP_ADD OP_LESSTHANOREQUAL)',
            ],

            transaction: 'withdrawFinalTransaction',
        },

        reclaim: {
            name: 'Reclaim Balance',
            description: 'The funder cancels the covenant and withdraws the full balance to a destination of their choice, regardless of age.',
            icon: 'reclaim',

            roles: {
                funder: {
                    requirements: {
                        variables: [ 'mecenasSatoshis', 'pledgeSatoshis', 'periodBlocks', 'recipientLockingScript', 'funderPayoutLockingScript', 'feeSatoshis' ],
                        secrets: [ 'funderKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'funder', slots: { min: 1, max: 1 } },
                ],
            },

            conditions: [
                '$(<feeSatoshis> <1500> OP_GREATERTHANOREQUAL)',
            ],

            transaction: 'reclaimTransaction',
        },
    },

    transactions: {
        createMecenasTransaction: {
            name: 'Mecenas Covenant Created',
            description: 'Funded a Mecenas covenant with $(<mecenasSatoshis>) satoshis, pledging up to $(<pledgeSatoshis>) satoshis every $(<periodBlocks>) blocks.',
            icon: 'mecenas',

            inputs: [],
            outputs: [
                { output: 'initialMecenasOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        withdrawTransaction: {
            name: 'Pledge Withdrawn',
            description: 'Paid the recipient from the Mecenas covenant.',
            icon: 'withdraw',

            inputs: [
                { input: 'withdrawInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'recipientPledgeOutput', outputIndex: 0 },
                { output: 'mecenasRemainderOutput', outputIndex: 1 },
            ],

            // Relative locktime (this.age >= periodBlocks) requires version 2.
            version: 2,
            locktime: 0,
            composable: true,
        },

        withdrawFinalTransaction: {
            name: 'Covenant Closed',
            description: 'Paid the recipient the full remaining balance and closed the Mecenas covenant.',
            icon: 'withdraw',

            inputs: [
                { input: 'withdrawInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'recipientFinalOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        reclaimTransaction: {
            name: 'Covenant Reclaimed',
            description: 'The funder reclaimed the full Mecenas covenant balance.',
            icon: 'reclaim',

            inputs: [
                { input: 'reclaimInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'funderReclaimOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },
    },

    inputs: {
        // Two input definitions share the same covenant output because the
        // relative-locktime (nSequence) requirement only applies to withdraw;
        // reclaim has no age requirement. See docs/ARCHITECTURE.md.
        withdrawInput: {
            name: 'Mecenas balance',
            description: 'The covenant output holding $(<mecenasSatoshis>) satoshis, aged at least $(<periodBlocks>) blocks.',
            icon: 'mecenas',

            valueSatoshis: '$(<mecenasSatoshis>)',
            token: null,
            unlockingScript: 'unlockWithdraw',
        },
        reclaimInput: {
            name: 'Mecenas balance',
            description: 'The covenant output holding $(<mecenasSatoshis>) satoshis.',
            icon: 'mecenas',

            valueSatoshis: '$(<mecenasSatoshis>)',
            token: null,
            unlockingScript: 'unlockReclaim',
        },
    },

    outputs: {
        initialMecenasOutput: {
            name: 'Mecenas Covenant',
            description: 'A new covenant holding $(<mecenasSatoshis>) satoshis, pledging $(<pledgeSatoshis>) satoshis every $(<periodBlocks>) blocks.',
            icon: 'mecenas',

            lockingScript: 'mecenasScript',
            valueSatoshis: '$(<mecenasSatoshis>)',
            token: null,
        },

        recipientPledgeOutput: {
            name: 'Recipient payout',
            description: 'The recipient receives the periodic pledge, or the full remaining balance if this is the final round.',
            icon: 'recipient',

            lockingScript: '$(<recipientLockingScript>)',
            // Informational only: the covenant enforces the exact value on-chain.
            // Off-chain callers compute this with computeWithdrawSplit().
            valueSatoshis: '$(<pledgeSatoshis>)',
            token: null,
        },

        mecenasRemainderOutput: {
            name: 'Mecenas Covenant (continued)',
            description: 'The remainder, minus the miner fee, stays in the same covenant for the next period.',
            icon: 'mecenas',

            lockingScript: 'mecenasScript',
            valueSatoshis: '$(<mecenasSatoshis> <pledgeSatoshis> OP_SUB <1500> OP_SUB)',
            token: null,
        },

        recipientFinalOutput: {
            name: 'Recipient final payout',
            description: 'The remaining balance cannot cover another pledge round, so the recipient receives everything minus the miner fee and the covenant closes.',
            icon: 'recipient',

            lockingScript: '$(<recipientLockingScript>)',
            valueSatoshis: '$(<mecenasSatoshis> <1500> OP_SUB)',
            token: null,
        },

        funderReclaimOutput: {
            name: 'Funder payout',
            description: 'The funder receives the full balance minus the miner fee.',
            icon: 'funder',

            lockingScript: '$(<funderPayoutLockingScript>)',
            valueSatoshis: '$(<mecenasSatoshis> <feeSatoshis> OP_SUB)',
            token: null,
        },
    },

    lockingScripts: {
        mecenasScript: {
            name: 'Mecenas Covenant',
            description: 'Holds the pledge balance and enforces the capped periodic withdrawal or an unconditional funder reclaim.',
            icon: 'mecenas',

            lockingType: 'p2sh',
            lockingBytecode: 'mecenasRedeemBytecode',
            unlockingBytecode: 'unlockWithdraw',

            state: {
                variables: [ 'recipientLockingScript', 'pledgeSatoshis', 'periodBlocks', 'mecenasSatoshis' ],
                secrets: [],
            },

            roles: {
                funder: {
                    state: {
                        variables: [],
                        secrets: [ 'funderKey' ],
                    },

                    actions: [
                        { action: 'reclaim', role: 'funder', secrets: [{ funderKey: null }] },
                    ],

                    balance: {
                        satoshis: true,
                    },

                    // The engine currently normalizes Electrum UTXOs as selectable;
                    // apps must pass the covenant input explicitly. See docs/ARCHITECTURE.md.
                    selectable: false,
                },

                recipient: {
                    state: {
                        variables: [],
                        secrets: [],
                    },

                    // Withdraw needs no secret: the covenant is the authorization.
                    actions: [
                        { action: 'withdraw', role: 'recipient' },
                        { action: 'withdrawFinal', role: 'recipient' },
                    ],

                    selectable: false,
                },
            },
        },
    },

    scripts: {
        // Hash of the funder's public key, for the P2PKH-style reclaim check.
        // Compiling any action requires funderKey's *public* key locally; see
        // docs/ARCHITECTURE.md for the single-wallet caveat this implies.
        funderPublicKeyHash: '<funderKey.public_key> OP_HASH160',

        // reclaim(pubkey pk, sig s): require(hash160(pk) == funder); require(checkSig(s, pk));
        enforceFunderSignature: 'OP_DUP OP_HASH160 funderPublicKeyHash OP_EQUALVERIFY OP_CHECKSIG',

        // require(this.age >= period);  (BIP68 relative locktime, block-based)
        enforceAge: '<periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP',

        // require(tx.inputs.length == 1);
        enforceSingleInput: 'OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY',

        // require(tx.outputs[0].lockingBytecode == recipientLockingBytecode);
        enforceRecipientOutput: 'OP_0 OP_OUTPUTBYTECODE <recipientLockingScript> OP_EQUALVERIFY',

        // changeValue <= pledge + fee  <=>  currentValue <= 2*pledge + 2*fee
        isFinalWithdraw:
            'OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pledgeSatoshis> <pledgeSatoshis> OP_ADD <1500> OP_ADD <1500> OP_ADD OP_LESSTHANOREQUAL',

        // require(tx.outputs[0].value == currentValue - minerFee);
        enforceFinalWithdraw:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL',

        // require(tx.outputs[0].value == pledge);
        // require(tx.outputs[1].lockingBytecode == tx.inputs[this.activeInputIndex].lockingBytecode);
        // require(tx.outputs[1].value == changeValue);
        enforcePartialWithdraw:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM <pledgeSatoshis> OP_NUMEQUALVERIFY OP_1 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY OP_1 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pledgeSatoshis> OP_SUB <1500> OP_SUB OP_NUMEQUAL',

        // function receive() { ... }
        enforceWithdraw:
            'enforceAge enforceSingleInput enforceRecipientOutput isFinalWithdraw OP_IF enforceFinalWithdraw OP_ELSE enforcePartialWithdraw OP_ENDIF',

        // Function selector: true (1) runs receive()/withdraw, false (0) runs reclaim().
        mecenasRedeemBytecode: 'OP_IF enforceWithdraw OP_ELSE enforceFunderSignature OP_ENDIF',

        unlockWithdraw: '<1>',
        unlockReclaim: '<funderKey.schnorr_signature.all_outputs> <funderKey.public_key> <0>',
    },

    constants: {
        minerFeeSatoshis: {
            name: 'Miner fee',
            description: 'Fixed miner fee taken by every withdraw and used as the minimum reclaim fee. Inlined into the covenant, mirroring the hardcoded `int minerFee = 1000` in the original CashScript contract.',
            type: 'satoshis',
            value: 1500n,
        },
        dustLimit: {
            name: 'Dust limit',
            description: 'Minimum value for a payout output. Used by off-chain helpers; not separately enforced on-chain (neither is it in the original contract).',
            type: 'satoshis',
            value: 546n,
        },
    },

    variables: {
        funderKey: {
            name: 'Funder key',
            description: 'The key that authorizes reclaim. Its public key hash is committed into the covenant address.',
            type: 'private_key',
        },
        recipientLockingScript: {
            name: 'Recipient destination',
            description: 'The locking script paid the pledge on every withdrawal. Generalizes the original bytes20 P2PKH-only recipient parameter to any locking script.',
            type: 'locking_script',
        },
        pledgeSatoshis: {
            name: 'Pledge',
            description: 'The maximum number of satoshis the recipient may withdraw per period.',
            type: 'satoshis',
        },
        periodBlocks: {
            name: 'Period (blocks)',
            description: 'Minimum number of blocks the covenant UTXO must age before a withdrawal (this.age >= period in the original contract).',
            type: 'integer',
        },
        mecenasSatoshis: {
            name: 'Covenant balance',
            description: 'The current number of satoshis held by the covenant. Informational mirror; the authoritative balance is the UTXO value.',
            type: 'satoshis',
        },
        funderPayoutLockingScript: {
            name: 'Reclaim destination',
            description: "The locking script chosen by the funder to receive a reclaim. Freely chosen at spend time: it is not part of the covenant's committed state, matching the original contract's unconstrained reclaim() outputs.",
            type: 'locking_script',
        },
        feeSatoshis: {
            name: 'Reclaim fee',
            description: 'The miner fee taken from the balance on reclaim. Freely chosen (at least the documented minimum): unlike withdraw, the covenant does not fix this value.',
            type: 'satoshis',
        },
    },

    icons: [
        { name: 'mecenas', hash: '0000000000000000000000' },
        { name: 'funder', hash: '0000000000000000000000' },
        { name: 'recipient', hash: '0000000000000000000000' },
        { name: 'withdraw', hash: '0000000000000000000000' },
        { name: 'reclaim', hash: '0000000000000000000000' },
    ],
};
