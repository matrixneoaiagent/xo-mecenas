import { hexToBin } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { MINER_FEE_SATOSHIS, computeReclaimValue } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { isBroadcast, optionalBigInt, optionalInt, requireEnv } from './lib/config.js';
import { archiveAllInvitations, ensureDefaultPolicies, openEngine, stopEngine } from './lib/engine.js';
import { verifyInvitationTransaction } from './verify-tx.js';

const mecenasTxid = requireEnv('MECENAS_TXID');
const mecenasVout = Number(process.env.MECENAS_VOUT ?? '0');
const mecenasSatoshis = optionalBigInt('MECENAS_SATS') ?? 8_000n;
const pledgeSatoshis = optionalBigInt('PLEDGE_SATS') ?? 5_000n;
const periodBlocks = optionalInt('PERIOD_BLOCKS') ?? 1;
const recipientScript = requireEnv('RECIPIENT_SCRIPT');
const feeSatoshis = optionalBigInt('FEE_SATS') ?? MINER_FEE_SATOSHIS + 500n;

const payout = computeReclaimValue(mecenasSatoshis, feeSatoshis);

const { engine, templateIdentifier } = await openEngine();
try {
    await ensureDefaultPolicies(engine);
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const reclaimIntent = template.lockingScripts.mecenasScript.roles?.funder.actions?.find((intent) => intent.action === 'reclaim');
    if (!reclaimIntent) throw new Error('reclaim intent missing');

    const payoutScript = process.env.FUNDER_PAYOUT_SCRIPT ?? await engine.generateLockingBytecodeFromDefaultPolicy('receive');

    console.log('template', templateIdentifier);
    console.log('mecenas', mecenasTxid, mecenasVout, 'balance', String(mecenasSatoshis));
    console.log('fee', String(feeSatoshis), 'payout', String(payout), 'to', payoutScript);
    console.log('reclaim has no age requirement: this works regardless of periodBlocks or UTXO confirmations.');

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'reclaim',
        intent: reclaimIntent,
        variables: [
            { variableIdentifier: 'mecenasSatoshis', roleIdentifier: 'funder', value: mecenasSatoshis },
            { variableIdentifier: 'pledgeSatoshis', roleIdentifier: 'funder', value: pledgeSatoshis },
            { variableIdentifier: 'periodBlocks', roleIdentifier: 'funder', value: periodBlocks },
            { variableIdentifier: 'recipientLockingScript', roleIdentifier: 'funder', value: recipientScript },
            { variableIdentifier: 'funderPayoutLockingScript', roleIdentifier: 'funder', value: payoutScript },
            { variableIdentifier: 'feeSatoshis', roleIdentifier: 'funder', value: feeSatoshis },
        ],
        inputs: [{
            inputIdentifier: 'reclaimInput',
            outpointTransactionHash: hexToBin(mecenasTxid),
            outpointIndex: mecenasVout,
            // No relative-locktime requirement: reclaim works at any age.
            sequenceNumber: 0xffffffff,
        }],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'reclaim',
        outputs: [{ outputIdentifier: 'funderReclaimOutput' }],
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('funder gets', String(payout), 'fee', String(feeSatoshis));
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact('reclaim-invitation.json', serializeInvitation(stored.invitation)));
    console.log('RECLAIM_TXID', preview.transactionHash);

    if (isBroadcast()) {
        const broadcast = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
        console.log('BROADCAST_TXID', broadcast.builtTransaction.transactionHash);
    } else {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
    }
} finally {
    await stopEngine(engine);
}
