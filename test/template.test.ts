import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTemplateIdentifier, parseTemplate, serializeTemplate } from '@xo-cash/utils';
import { mecenasTemplate } from '../source/index.js';
import { MINER_FEE_SATOSHIS, computeReclaimValue, computeWithdrawSplit } from '../source/types.js';

const parsed = parseTemplate(mecenasTemplate);

test('parseTemplate returns a usable template with all four actions', () => {
    assert.deepEqual(
        Object.keys(parsed.actions).sort(),
        ['createMecenas', 'reclaim', 'withdraw', 'withdrawFinal'],
    );
    assert.equal(typeof parsed.scripts.mecenasRedeemBytecode, 'string');
    assert.match(parsed.scripts.mecenasRedeemBytecode, /OP_IF enforceWithdraw OP_ELSE enforceFunderSignature OP_ENDIF/);
});

test('the template identifier is stable across parse and serialization', () => {
    const first = generateTemplateIdentifier(parsed);
    const reparsed = parseTemplate(serializeTemplate(parsed));
    assert.equal(generateTemplateIdentifier(reparsed), first);
});

function requiredVariables(action: 'withdraw' | 'withdrawFinal' | 'reclaim'): string[] {
    const role = action === 'reclaim' ? 'funder' : 'recipient';
    return parsed.actions[action]?.roles?.[role]?.requirements?.variables ?? [];
}

test('withdraw and withdrawFinal require the full committed state, with no secrets', () => {
    for (const action of ['withdraw', 'withdrawFinal'] as const) {
        const required = requiredVariables(action);
        for (const variable of ['recipientLockingScript', 'pledgeSatoshis', 'periodBlocks', 'mecenasSatoshis']) {
            assert.ok(required.includes(variable), `${action} must require ${variable}`);
        }
        const secrets = parsed.actions[action]?.roles?.recipient?.requirements?.secrets ?? [];
        assert.deepEqual(secrets, [], `${action} must not require a recipient secret`);
    }
});

test('reclaim requires the funder secret plus its own free destination and fee', () => {
    const required = requiredVariables('reclaim');
    for (const variable of ['recipientLockingScript', 'pledgeSatoshis', 'periodBlocks', 'mecenasSatoshis', 'funderPayoutLockingScript', 'feeSatoshis']) {
        assert.ok(required.includes(variable), `reclaim must require ${variable}`);
    }
    assert.deepEqual(parsed.actions.reclaim?.roles?.funder?.requirements?.secrets, ['funderKey']);
});

test('the miner fee constant is a documented, non-negative satoshi value matching the inlined script literal', () => {
    const constant = parsed.constants?.minerFeeSatoshis;
    assert.ok(constant);
    assert.equal(constant.type, 'satoshis');
    assert.equal(typeof constant.value, 'bigint');
    assert.equal(MINER_FEE_SATOSHIS, constant.value as bigint);
    assert.match(parsed.scripts.enforceFinalWithdraw, new RegExp(`<${MINER_FEE_SATOSHIS}>`));
});

test('computeWithdrawSplit rejects a balance that cannot cover the pledge plus the fee', () => {
    const state = {
        recipientLockingScript: '76a914000000000000000000000000000000000000000088ac',
        pledgeSatoshis: 5_000n,
        periodBlocks: 1n,
        mecenasSatoshis: 1_000n,
    };
    assert.throws(() => computeWithdrawSplit(state), /cannot cover the pledge/);
});

test('computeWithdrawSplit picks the partial branch, matching the on-chain math', () => {
    const state = {
        recipientLockingScript: '76a914000000000000000000000000000000000000000088ac',
        pledgeSatoshis: 5_000n,
        periodBlocks: 1n,
        mecenasSatoshis: 20_000n,
    };
    const split = computeWithdrawSplit(state);
    assert.deepEqual(split, { isFinal: false, recipientSatoshis: 5_000n, remainderSatoshis: 13_500n });
});

test('computeWithdrawSplit picks the final branch, matching the on-chain math', () => {
    const state = {
        recipientLockingScript: '76a914000000000000000000000000000000000000000088ac',
        pledgeSatoshis: 5_000n,
        periodBlocks: 1n,
        mecenasSatoshis: 10_000n,
    };
    const split = computeWithdrawSplit(state);
    assert.deepEqual(split, { isFinal: true, recipientSatoshis: 8_500n, remainderSatoshis: 0n });
});

test('computeReclaimValue rejects a fee below the minimum and a payout below dust', () => {
    assert.throws(() => computeReclaimValue(10_000n, 100n), /below the minimum/);
    assert.throws(() => computeReclaimValue(1_600n, MINER_FEE_SATOSHIS), /below dust or negative/);
    assert.equal(computeReclaimValue(10_000n, MINER_FEE_SATOSHIS), 8_500n);
});
