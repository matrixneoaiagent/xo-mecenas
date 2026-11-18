import { mkdirSync } from 'node:fs';
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { mecenasTemplate } from '../../source/index.js';
import { DEFAULT_DB_PATH, NETWORK_NAME, loadWalletConfig } from './config.js';

export type OpenedEngine = {
    engine: Engine;
    templateIdentifier: string;
};

/**
 * Opens a Chipnet-only engine backed by the scratch database and imports the
 * Mecenas template. Refuses to run against any other network.
 */
export async function openEngine(): Promise<OpenedEngine> {
    const wallet = loadWalletConfig();
    const databasePath = process.env.XO_DB_PATH ?? DEFAULT_DB_PATH;
    mkdirSync(databasePath, { recursive: true });
    const engine = await Engine.create(wallet.mnemonic, {
        network: XO_SUPPORTED_NETWORKS[NETWORK_NAME],
        databasePath,
        ...(process.env.XO_DB_NAME === undefined ? {} : { databaseFilename: process.env.XO_DB_NAME }),
    });
    try {
        const { templateIdentifier } = await engine.importTemplate(mecenasTemplate);
        return { engine, templateIdentifier };
    } catch (error) {
        try { await engine.stop(); } catch { /* best effort */ }
        throw error;
    }
}

/** Imports the p2pkh helper template used for receiving/change addresses. */
export async function ensureDefaultPolicies(engine: Engine): Promise<void> {
    const p2pkh = await engine.importTemplate(p2pkhTemplate);
    await engine.setDefaultPolicies({
        receive: { templateIdentifier: p2pkh.templateIdentifier },
        change: { templateIdentifier: p2pkh.templateIdentifier },
        address: { templateIdentifier: p2pkh.templateIdentifier },
    });
}

/**
 * Archives every stored invitation. Archiving clears the unspent-output
 * reservations held by earlier dry runs, so the next run can reuse the same
 * funding UTXO. Safe to call repeatedly.
 */
export async function archiveAllInvitations(engine: Engine): Promise<void> {
    for (const stored of await engine.listInvitations()) {
        try {
            await engine.archiveInvitation(stored.invitation.invitationIdentifier);
        } catch (error) {
            console.log('archive skipped', stored.invitation.invitationIdentifier, (error as Error).message);
        }
    }
}

/** Stops the engine without letting shutdown noise fail the script. */
export async function stopEngine(engine: Engine): Promise<void> {
    try { await engine.stop(); } catch (error) { console.error('stop warning', (error as Error).message); }
}
