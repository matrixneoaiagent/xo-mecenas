import { DUST_LIMIT_SATOSHIS } from '@xo-cash/engine';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { MINER_FEE_SATOSHIS } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { isBroadcast, optionalBigInt, optionalInt } from './lib/config.js';
import { archiveAllInvitations, ensureDefaultPolicies, openEngine, stopEngine } from './lib/engine.js';
import { verifyInvitationTransaction } from './verify-tx.js';

const mecenasSatoshis = optionalBigInt('MECENAS_SATS') ?? 20_000n;
const pledgeSatoshis = optionalBigInt('PLEDGE_SATS') ?? 5_000n;
const periodBlocks = optionalInt('PERIOD_BLOCKS') ?? 1;
if (mecenasSatoshis <= pledgeSatoshis + MINER_FEE_SATOSHIS) {
    throw new Error('MECENAS_SATS must exceed PLEDGE_SATS + the miner fee so at least one withdraw round is possible');
}
if (periodBlocks < 0) throw new Error('PERIOD_BLOCKS must be non-negative');

const { engine, templateIdentifier } = await openEngine();
try {
    await ensureDefaultPolicies(engine);
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing after import');
    const start = template.start.find((intent) => intent.action === 'createMecenas');
    if (!start) throw new Error('createMecenas start intent missing');

    const recipientScript = process.env.RECIPIENT_SCRIPT ?? await engine.generateLockingBytecodeFromDefaultPolicy('receive');

    console.log('template', templateIdentifier);
    console.log('mecenas', String(mecenasSatoshis), 'pledge', String(pledgeSatoshis), 'period (blocks)', periodBlocks);
    console.log('recipient', recipientScript);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'createMecenas',
        intent: start,
        variables: [
            { variableIdentifier: 'mecenasSatoshis', roleIdentifier: 'funder', value: mecenasSatoshis },
            { variableIdentifier: 'pledgeSatoshis', roleIdentifier: 'funder', value: pledgeSatoshis },
            { variableIdentifier: 'periodBlocks', roleIdentifier: 'funder', value: periodBlocks },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'funder', value: recipientScript },
        ],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createMecenas',
        outputs: [{ outputIdentifier: 'initialMecenasOutput' }],
    });

    const spendable = await engine.listSpendableUnspentOutputs();
    const funding = spendable
        .filter((utxo) => BigInt(utxo.valueSatoshis) > mecenasSatoshis + 5_000n)
        .sort((a, b) => Number(BigInt(b.valueSatoshis) - BigInt(a.valueSatoshis)))[0];
    if (!funding) throw new Error('no funding UTXO larger than MECENAS_SATS + 5000');
    console.log('funding', funding.outpointTransactionHash, funding.outpointIndex, String(funding.valueSatoshis));

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createMecenas',
        inputs: [{
            outpointTransactionHash: hexToBin(funding.outpointTransactionHash),
            outpointIndex: funding.outpointIndex,
        }],
    });

    const funderScript = process.env.FUNDER_CHANGE_SCRIPT ?? await engine.generateLockingBytecodeFromDefaultPolicy('change');
    const estimatedFee = await engine.estimateTransactionFee(invitationIdentifier);
    const feeSatoshis = optionalBigInt('FEE_SATS') ?? BigInt(Math.max(estimatedFee, Number(MINER_FEE_SATOSHIS)));
    const fundingValue = BigInt(funding.valueSatoshis);
    const changeSatoshis = fundingValue - mecenasSatoshis - feeSatoshis;
    if (changeSatoshis < BigInt(DUST_LIMIT_SATOSHIS)) {
        throw new Error(`change ${changeSatoshis} is below dust; lower MECENAS_SATS or raise the funding UTXO`);
    }
    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createMecenas',
        outputs: [{ lockingBytecode: hexToBin(funderScript), valueSatoshis: changeSatoshis }],
    });
    console.log('fee', String(feeSatoshis), 'change', String(changeSatoshis));

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    const invitationPath = writeArtifact('createMecenas-invitation.json', serializeInvitation(stored.invitation));
    const record = {
        templateIdentifier,
        invitationIdentifier,
        mecenasTxid: preview.transactionHash,
        mecenasVout: 0,
        mecenasSatoshis: mecenasSatoshis.toString(),
        pledgeSatoshis: pledgeSatoshis.toString(),
        periodBlocks,
        recipientLockingScript: recipientScript,
    };
    const recordPath = writeArtifact('mecenas.json', JSON.stringify(record, null, 2));
    console.log('invitation', invitationPath);
    console.log('mecenas record', recordPath);
    console.log('MECENAS_TXID', preview.transactionHash);
    console.log('RECIPIENT_SCRIPT', recipientScript);

    if (isBroadcast()) {
        const result = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
        console.log('BROADCAST_TXID', result.builtTransaction.transactionHash);
    } else {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
    }
} finally {
    await stopEngine(engine);
}
