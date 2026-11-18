import { hexToBin } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { MINER_FEE_SATOSHIS } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { optionalBigInt, optionalInt, requireEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { expectInvitationTransactionRejected } from './verify-tx.js';

/**
 * Deliberately builds a withdraw transaction that pays the recipient MORE than
 * the pledge cap, to demonstrate that the covenant (not an off-chain check)
 * rejects an over-cap withdrawal attempt. Never broadcasts: the point is that
 * libauth's BCH VM -- the same evaluator a Chipnet node runs -- already
 * refuses the spend before a real network round-trip.
 */
const mecenasTxid = requireEnv('MECENAS_TXID');
const mecenasVout = Number(process.env.MECENAS_VOUT ?? '0');
const mecenasSatoshis = optionalBigInt('MECENAS_SATS') ?? 20_000n;
const pledgeSatoshis = optionalBigInt('PLEDGE_SATS') ?? 5_000n;
const periodBlocks = optionalInt('PERIOD_BLOCKS') ?? 1;
const recipientScript = requireEnv('RECIPIENT_SCRIPT');
const overCapExtra = optionalBigInt('OVERCAP_EXTRA_SATS') ?? 2_000n;

const overCapPledge = pledgeSatoshis + overCapExtra;
const remainder = mecenasSatoshis - overCapPledge - MINER_FEE_SATOSHIS;
if (remainder < 0n) throw new Error('OVERCAP_EXTRA_SATS too large for MECENAS_SATS; lower it');

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const withdrawIntent = template.lockingScripts.mecenasScript.roles?.recipient.actions?.find((intent) => intent.action === 'withdraw');
    if (!withdrawIntent) throw new Error('withdraw intent missing');

    console.log('template', templateIdentifier);
    console.log('attempting to withdraw', String(overCapPledge), 'against a pledge cap of', String(pledgeSatoshis));

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'withdraw',
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
            sequenceNumber: periodBlocks,
        }],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    // Explicit valueSatoshis overrides take priority over the template's own
    // expression (see completeMergedOutput in @xo-cash/engine): this is how
    // we construct a deliberately invalid, over-cap spend for this negative test.
    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'withdraw',
        outputs: [
            { outputIdentifier: 'recipientPledgeOutput', valueSatoshis: overCapPledge },
            { outputIdentifier: 'mecenasRemainderOutput', valueSatoshis: remainder },
        ],
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const reason = await expectInvitationTransactionRejected(engine, invitationIdentifier, 0);
    console.log('OVERCAP_REJECTED', reason);

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact('withdraw-overcap-rejected-invitation.json', serializeInvitation(stored.invitation)));

    let networkReason = '(not attempted)';
    if (process.env.BROADCAST_INVALID === '1') {
        try {
            const broadcast = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
            // This would be a serious finding: the network accepted a spend the VM rejects.
            console.log('UNEXPECTED_BROADCAST_ACCEPTED', broadcast.builtTransaction.transactionHash);
            networkReason = `UNEXPECTED: broadcast accepted, txid ${broadcast.builtTransaction.transactionHash}`;
        } catch (error) {
            networkReason = (error as Error).message;
            console.log('NETWORK_REJECTED (expected)', networkReason);
        }
    }
    writeArtifact('withdraw-overcap-rejection-reason.txt', `VM: ${reason}\nNetwork: ${networkReason}\n`);
} finally {
    await stopEngine(engine);
}
