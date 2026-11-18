import assert from 'node:assert/strict';
import test from 'node:test';
import { MINER_FEE_SATOSHIS } from '../source/index.js';
import { buildTestCovenant, evaluateReclaim, evaluateWithdraw, p2pkhForPrivateKeyByte } from './helpers/covenant.js';

const PLEDGE = 5_000n;
const PERIOD = 1;
const FEE = MINER_FEE_SATOSHIS;

test('pledgeSatoshis and periodBlocks change the P2SH32 address and redeem script', () => {
    const first = buildTestCovenant({ pledgeSatoshis: 5_000n });
    const second = buildTestCovenant({ pledgeSatoshis: 6_000n });
    assert.notDeepEqual(first.redeem, second.redeem);
    assert.notDeepEqual(first.p2sh32, second.p2sh32);
});

test('withdraw (partial): pays the pledge and carries the remainder back to the covenant', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    // currentValue = 20000 > 2*pledge + 2*fee = 13000, so this is a partial round.
    const currentValue = 20_000n;
    const changeValue = currentValue - PLEDGE - FEE;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PLEDGE },
            { lockingBytecode: covenant.p2sh32, valueSatoshis: changeValue },
        ],
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('withdraw rejects an age below the period (relative locktime not satisfied)', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: 5n });
    const currentValue = 20_000n;
    const changeValue = currentValue - PLEDGE - FEE;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: 4, // one short of the required period (5)
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PLEDGE },
            { lockingBytecode: covenant.p2sh32, valueSatoshis: changeValue },
        ],
    });
    assert.equal(result.success, false);
});

test('withdraw rejects paying more than the pledge cap (over-cap attempt)', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    const currentValue = 20_000n;
    const tooMuch = PLEDGE + 2_000n;
    const changeValue = currentValue - tooMuch - FEE;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: tooMuch },
            { lockingBytecode: covenant.p2sh32, valueSatoshis: changeValue },
        ],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_EQUALVERIFY/);
});

test('withdraw rejects a payout to the wrong destination', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    const currentValue = 20_000n;
    const changeValue = currentValue - PLEDGE - FEE;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: PLEDGE },
            { lockingBytecode: covenant.p2sh32, valueSatoshis: changeValue },
        ],
    });
    assert.equal(result.success, false);
});

test('withdraw rejects a remainder sent anywhere but back to the same covenant', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    const currentValue = 20_000n;
    const changeValue = currentValue - PLEDGE - FEE;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PLEDGE },
            { lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: changeValue },
        ],
    });
    assert.equal(result.success, false);
});

test('withdrawFinal: balance too small for another round pays everything minus the fee', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    // currentValue = 10000 <= 2*pledge + 2*fee = 13000, so this must be the final round.
    const currentValue = 10_000n;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: currentValue - FEE },
        ],
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('withdrawFinal rejects leaving a remainder output when the covenant should close', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    const currentValue = 10_000n;
    const result = evaluateWithdraw({
        covenant,
        inputValueSatoshis: currentValue,
        inputSequenceNumber: PERIOD,
        // Pays the pledge and tries to also keep a (too-small) remainder: the
        // "partial" branch would reject this because the covenant's own branch
        // selection is `isFinalWithdraw`, not a choice the spender makes.
        outputs: [
            { lockingBytecode: covenant.recipientLockingScript, valueSatoshis: PLEDGE },
            { lockingBytecode: covenant.p2sh32, valueSatoshis: currentValue - PLEDGE - FEE },
        ],
    });
    assert.equal(result.success, false);
});

test('reclaim: the funder takes the full balance to any destination, with no age requirement', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: 1_000_000n });
    const currentValue = 8_000n;
    const result = evaluateReclaim({
        covenant,
        inputValueSatoshis: currentValue,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(42), valueSatoshis: currentValue - FEE },
        ],
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('reclaim rejects a signature from a different key', () => {
    const covenant = buildTestCovenant({ pledgeSatoshis: PLEDGE, periodBlocks: BigInt(PERIOD) });
    const currentValue = 8_000n;
    const result = evaluateReclaim({
        covenant,
        inputValueSatoshis: currentValue,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(42), valueSatoshis: currentValue - FEE },
        ],
        signWith: new Uint8Array(32).fill(0x09),
    });
    assert.equal(result.success, false);
});
