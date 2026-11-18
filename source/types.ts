import type { XOTemplateVariableIdentifier } from '@xo-cash/types';

/** Actions exposed by the XO Mecenas template. */
export type MecenasAction = 'createMecenas' | 'withdraw' | 'withdrawFinal' | 'reclaim';

/** The immutable and mutable state carried by one Mecenas covenant. */
export type MecenasState = {
    /** Locking script paid the pledge on every withdrawal. */
    recipientLockingScript: string;
    /** Maximum satoshis the recipient may withdraw per period. */
    pledgeSatoshis: bigint;
    /** Minimum blocks the covenant UTXO must age before a withdrawal. */
    periodBlocks: bigint;
    /** Informational balance mirror. The authoritative balance is the UTXO value. */
    mecenasSatoshis: bigint;
};

/** Fixed miner fee baked into the covenant; mirrors `int minerFee = 1000` in the original contract. */
export const MINER_FEE_SATOSHIS = 1_500n;

/** Dust floor for a payout output. Not separately enforced on-chain. */
export const DUST_SATOSHIS = 546n;

export type WithdrawSplit = {
    /** True when the covenant pays everything out and closes (no remainder output): build `withdrawFinal`. */
    isFinal: boolean;
    /** Satoshis paid to the recipient. */
    recipientSatoshis: bigint;
    /** Satoshis carried forward in the covenant. Zero when `isFinal`. */
    remainderSatoshis: bigint;
};

/**
 * Computes the withdraw split and rejects spends the covenant would refuse
 * before they reach the engine. Mirrors the on-chain branch in `enforceWithdraw`:
 * `changeValue <= pledge + fee` closes the covenant in one payout.
 *
 * The result's `isFinal` flag tells the caller which *action* to build:
 * `withdraw` (two outputs, continues the covenant) when false, or
 * `withdrawFinal` (one output, closes the covenant) when true. Both compile
 * to the same on-chain branch; only the transaction shape differs.
 */
export function computeWithdrawSplit(state: MecenasState): WithdrawSplit {
    const { mecenasSatoshis, pledgeSatoshis } = state;
    if (mecenasSatoshis < pledgeSatoshis + MINER_FEE_SATOSHIS) {
        throw new Error(`covenant balance ${mecenasSatoshis} cannot cover the pledge ${pledgeSatoshis} plus the ${MINER_FEE_SATOSHIS} sat fee`);
    }
    const changeValue = mecenasSatoshis - pledgeSatoshis - MINER_FEE_SATOSHIS;
    if (changeValue <= pledgeSatoshis + MINER_FEE_SATOSHIS) {
        return { isFinal: true, recipientSatoshis: mecenasSatoshis - MINER_FEE_SATOSHIS, remainderSatoshis: 0n };
    }
    return { isFinal: false, recipientSatoshis: pledgeSatoshis, remainderSatoshis: changeValue };
}

/**
 * Computes the funder's reclaim payout and rejects a spend that would leave
 * less than dust. The covenant itself only requires `feeSatoshis` to meet the
 * documented minimum; it does not cap the reclaim fee.
 */
export function computeReclaimValue(mecenasSatoshis: bigint, feeSatoshis: bigint): bigint {
    if (feeSatoshis < MINER_FEE_SATOSHIS) throw new Error(`fee ${feeSatoshis} is below the minimum ${MINER_FEE_SATOSHIS}`);
    const payout = mecenasSatoshis - feeSatoshis;
    if (payout < DUST_SATOSHIS) throw new Error(`reclaim payout ${payout} would be below dust or negative`);
    return payout;
}

/** Variable identifiers that every follow-up action must provide. */
export const MECENAS_FOLLOW_UP_VARIABLES: readonly XOTemplateVariableIdentifier[] = [
    'recipientLockingScript',
    'pledgeSatoshis',
    'periodBlocks',
    'mecenasSatoshis',
];
