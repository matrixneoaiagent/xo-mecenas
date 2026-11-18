import { hexToBin } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { computeWithdrawSplit } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { isBroadcast, optionalBigInt, optionalInt, requireEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { verifyInvitationTransaction } from './verify-tx.js';

const mecenasTxid = requireEnv('MECENAS_TXID');
const mecenasVout = Number(process.env.MECENAS_VOUT ?? '0');
const mecenasSatoshis = optionalBigInt('MECENAS_SATS') ?? 20_000n;
const pledgeSatoshis = optionalBigInt('PLEDGE_SATS') ?? 5_000n;
const periodBlocks = optionalInt('PERIOD_BLOCKS') ?? 1;
const recipientScript = requireEnv('RECIPIENT_SCRIPT');

const split = computeWithdrawSplit({
    recipientLockingScript: recipientScript,
    pledgeSatoshis,
    periodBlocks: BigInt(periodBlocks),
    mecenasSatoshis,
});

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const actionIdentifier = split.isFinal ? 'withdrawFinal' : 'withdraw';
    const withdrawIntent = template.lockingScripts.mecenasScript.roles?.recipient.actions?.find((intent) => intent.action === actionIdentifier);
    if (!withdrawIntent) throw new Error(`${actionIdentifier} intent missing`);

    console.log('template', templateIdentifier);
    console.log('mecenas', mecenasTxid, mecenasVout);
    console.log('balance', String(mecenasSatoshis), 'pledge', String(pledgeSatoshis), 'period (blocks)', periodBlocks);
    console.log('action', actionIdentifier, 'isFinal', split.isFinal);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier,
        intent: withdrawIntent,
        variables: [
            { variableIdentifier: 'mecenasSatoshis', roleIdentifier: 'recipient', value: mecenasSatoshis },
            { variableIdentifier: 'pledgeSatoshis', roleIdentifier: 'recipient', value: pledgeSatoshis },
            { variableIdentifier: 'periodBlocks', roleIdentifier: 'recipient', value: periodBlocks },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'recipient', value: recipientScript },
        ],
        inputs: [{
            inputIdentifier: 'withdrawInput',
            outpointTransactionHash: hexToBin(mecenasTxid),
            outpointIndex: mecenasVout,
            // Relative locktime: must be >= periodBlocks for this.age >= period
            // (OP_CHECKSEQUENCEVERIFY) to pass. See docs/ARCHITECTURE.md.
            sequenceNumber: periodBlocks,
        }],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    const outputIdentifiers = split.isFinal ? ['recipientFinalOutput'] : ['recipientPledgeOutput', 'mecenasRemainderOutput'];
    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier,
        outputs: outputIdentifiers.map((outputIdentifier) => ({ outputIdentifier })),
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    if (split.isFinal) {
        console.log('recipient gets (final)', String(split.recipientSatoshis));
    } else {
        console.log('recipient gets', String(split.recipientSatoshis), 'covenant carries forward', String(split.remainderSatoshis));
    }
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    const fileName = split.isFinal ? 'withdrawFinal-invitation.json' : 'withdraw-invitation.json';
    console.log('invitation', writeArtifact(fileName, serializeInvitation(stored.invitation)));
    console.log('WITHDRAW_TXID', preview.transactionHash);

    if (isBroadcast()) {
        const broadcast = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
        console.log('BROADCAST_TXID', broadcast.builtTransaction.transactionHash);
        if (!split.isFinal) {
            console.log('NEW_MECENAS_SATS', split.remainderSatoshis.toString());
        }
    } else {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
    }
} finally {
    await stopEngine(engine);
}
