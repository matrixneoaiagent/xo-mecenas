import {
    bigIntToVmNumber,
    createVirtualMachineBch,
    encodeDataPush,
    encodeLockingBytecodeP2pkh,
    flattenBinArray,
    generateSigningSerializationBch,
    hash160,
    hash256,
    hexToBin,
    secp256k1,
} from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { mecenasTemplate } from '../../source/index.js';

/** SIGHASH_ALL | SIGHASH_FORKID. */
export const SIGHASH_ALL_FORKID = 0x41;

export type TestCovenant = {
    redeem: Uint8Array;
    p2sh32: Uint8Array;
    funderPrivateKey: Uint8Array;
    funderPublicKey: Uint8Array;
    recipientLockingScript: Uint8Array;
    pledgeSatoshis: bigint;
    periodBlocks: bigint;
};

const parse = parseTemplate(mecenasTemplate);

function keyFromByte(byte: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    return { privateKey, publicKey };
}

export function buildTestCovenant(options?: {
    pledgeSatoshis?: bigint;
    periodBlocks?: bigint;
}): TestCovenant {
    const funder = keyFromByte(1);
    const recipient = keyFromByte(2);
    const pledgeSatoshis = options?.pledgeSatoshis ?? 5_000n;
    const periodBlocks = options?.periodBlocks ?? 1n;
    const recipientLockingScript = encodeLockingBytecodeP2pkh(hash160(recipient.publicKey));

    // Replace the key method with a concrete test key so the rest of the
    // template's actual CashASM source is compiled unchanged.
    const scripts: Record<string, string> = {
        ...parse.scripts,
        funderPublicKeyHash: `<0x${Buffer.from(funder.publicKey).toString('hex')}> OP_HASH160`,
    };

    const redeemHex = compileCashAssemblyString({
        cashAssemblyText: scripts.mecenasRedeemBytecode,
        variables: {
            pledgeSatoshis,
            periodBlocks,
            recipientLockingScript,
        },
        templateVariables: parse.variables,
        templateScripts: scripts,
        evaluationDecodeMode: 'hex',
    });
    const redeem = hexToBin(redeemHex);
    const p2sh32 = flattenBinArray([
        Uint8Array.of(0xaa), // OP_HASH256
        Uint8Array.of(0x20), // push 32 bytes
        hash256(redeem),
        Uint8Array.of(0x87), // OP_EQUAL
    ]);

    return {
        redeem,
        p2sh32,
        funderPrivateKey: funder.privateKey,
        funderPublicKey: funder.publicKey,
        recipientLockingScript,
        pledgeSatoshis,
        periodBlocks,
    };
}

export type EvaluateResult = {
    success: boolean;
    reason?: string;
};

/** Builds and evaluates a withdraw spend: `<1>` selects the receive() branch. */
export function evaluateWithdraw(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    inputSequenceNumber: number;
    outputs: Array<{ lockingBytecode: Uint8Array; valueSatoshis: bigint }>;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, inputSequenceNumber, outputs } = params;
    const input = {
        outpointTransactionHash: new Uint8Array(32).fill(0x11),
        outpointIndex: 0,
        sequenceNumber: inputSequenceNumber,
        unlockingBytecode: new Uint8Array(),
    };
    const transaction = { version: 2, inputs: [ input ], outputs, locktime: 0 };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: inputValueSatoshis }];

    const unlockingBytecode = flattenBinArray([
        Uint8Array.of(0x51), // OP_1: selector true, runs receive()/withdraw
        encodeDataPush(covenant.redeem),
    ]);
    const signedTransaction = { ...transaction, inputs: [{ ...input, unlockingBytecode }] };

    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction: signedTransaction });
    const result = vm.stateSuccess(state);
    return { success: result === true, reason: result === true ? undefined : String(result) };
}

/** Builds and evaluates a reclaim spend, signed by `signWith` (defaults to the funder key). */
export function evaluateReclaim(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    outputs: Array<{ lockingBytecode: Uint8Array; valueSatoshis: bigint }>;
    signWith?: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, outputs } = params;
    const input = {
        outpointTransactionHash: new Uint8Array(32).fill(0x22),
        outpointIndex: 0,
        sequenceNumber: 0,
        unlockingBytecode: new Uint8Array(),
    };
    const transaction = { version: 2, inputs: [ input ], outputs, locktime: 0 };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: inputValueSatoshis }];

    const signingSerialization = generateSigningSerializationBch(
        { inputIndex: 0, sourceOutputs, transaction },
        { coveredBytecode: covenant.redeem, signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID) },
    );
    const signature = secp256k1.signMessageHashSchnorr(
        params.signWith ?? covenant.funderPrivateKey,
        hash256(signingSerialization),
    );
    if (typeof signature === 'string') throw new Error(signature);

    const unlockingBytecode = flattenBinArray([
        encodeDataPush(flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ])),
        encodeDataPush(covenant.funderPublicKey),
        Uint8Array.of(0x00), // OP_0: selector false, runs reclaim()
        encodeDataPush(covenant.redeem),
    ]);
    const signedTransaction = { ...transaction, inputs: [{ ...input, unlockingBytecode }] };

    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction: signedTransaction });
    const result = vm.stateSuccess(state);
    return { success: result === true, reason: result === true ? undefined : String(result) };
}

export function p2pkhForPrivateKeyByte(byte: number): Uint8Array {
    const { publicKey } = keyFromByte(byte);
    return encodeLockingBytecodeP2pkh(hash160(publicKey));
}

export function vmNumber(value: bigint): Uint8Array {
    return bigIntToVmNumber(value);
}
