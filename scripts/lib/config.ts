import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The only network these scripts are allowed to touch. */
export const NETWORK_NAME = 'chipnet' as const;

/** Default funded Chipnet test wallet. Testnet only; never commit this file. */
export const DEFAULT_WALLET_PATH = '/tmp/opencode/xo_bounty/work_chipnet_wallet.json';

/** Scratch database location. Gitignored. */
export const DEFAULT_DB_PATH = resolve('.xo-data');

/** Where generated invitations and run records are written. Gitignored. */
export const ARTIFACTS_DIR = resolve('artifacts');

/** Satoshis per byte used for the safety check. 2 sat/B echoes Chipnet mempool policy. */
export const DEFAULT_SAT_PER_BYTE = 2n;

export type WalletConfig = { mnemonic: string };

export function loadWalletConfig(path = process.env.XO_WALLET ?? DEFAULT_WALLET_PATH): WalletConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read wallet config at ${path}: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as WalletConfig).mnemonic !== 'string') {
        throw new Error(`wallet config at ${path} is missing a mnemonic string`);
    }
    return parsed as WalletConfig;
}

export function requireEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '') throw new Error(`${name} is required`);
    return value;
}

export function optionalBigInt(name: string): bigint | undefined {
    const value = process.env[name];
    if (value === undefined || value === '') return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
    return BigInt(value);
}

export function optionalInt(name: string): number | undefined {
    const value = process.env[name];
    if (value === undefined || value === '') return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
    return Number(value);
}

export function isBroadcast(): boolean {
    return process.env.BROADCAST === '1';
}
