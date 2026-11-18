import { binToHex, createVirtualMachineBch, decodeTransaction, hexToBin } from '@bitauth/libauth';
import type { Engine } from '@xo-cash/engine';

/**
 * Builds the merged invitation transaction and evaluates the chosen input with
 * libauth's BCH VM. This is the local pre-broadcast covenant test: the engine
 * does not run the VM for single-party invitations, so a bad covenant would
 * otherwise only fail after the transaction reaches a node.
 */
export async function verifyInvitationTransaction(engine: Engine, invitationIdentifier: string, inputIndex: number) {
    const preview = await engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier);
    const decoded = decodeTransaction(hexToBin(preview.serializedTransaction));
    if (typeof decoded === 'string') throw new Error(`decodeTransaction: ${decoded}`);

    const allUtxos = await engine.listUnspentOutputs();
    const sourceOutputs: Array<{ lockingBytecode: Uint8Array; valueSatoshis: bigint }> = [];
    for (const input of decoded.inputs) {
        const txid = binToHex(input.outpointTransactionHash);
        const utxo = allUtxos.find((candidate) => candidate.outpointTransactionHash === txid && candidate.outpointIndex === input.outpointIndex);
        if (!utxo) throw new Error(`source UTXO not found: ${txid}:${input.outpointIndex}`);
        const [scriptHashData] = await engine.listScriptHashData({ scriptHash: utxo.scriptHash });
        if (!scriptHashData) throw new Error(`script hash data not found: ${utxo.scriptHash}`);
        sourceOutputs.push({
            lockingBytecode: hexToBin(scriptHashData.lockingBytecode),
            valueSatoshis: BigInt(utxo.valueSatoshis),
        });
    }

    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex, sourceOutputs, transaction: decoded });
    const result = vm.stateSuccess(state);
    if (result !== true) {
        throw new Error(`VM rejected input ${inputIndex}: ${String(result)}`);
    }
    console.log('VM_OK input', inputIndex, 'txid', preview.transactionHash, 'size', preview.transactionByteLength);
    return preview;
}

/**
 * Like {@link verifyInvitationTransaction}, but expects the VM to REJECT the
 * input and returns the rejection reason instead of throwing. Used to
 * demonstrate a deliberately invalid (over-cap) withdraw attempt.
 */
export async function expectInvitationTransactionRejected(engine: Engine, invitationIdentifier: string, inputIndex: number): Promise<string> {
    const preview = await engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier);
    const decoded = decodeTransaction(hexToBin(preview.serializedTransaction));
    if (typeof decoded === 'string') throw new Error(`decodeTransaction: ${decoded}`);

    const allUtxos = await engine.listUnspentOutputs();
    const sourceOutputs: Array<{ lockingBytecode: Uint8Array; valueSatoshis: bigint }> = [];
    for (const input of decoded.inputs) {
        const txid = binToHex(input.outpointTransactionHash);
        const utxo = allUtxos.find((candidate) => candidate.outpointTransactionHash === txid && candidate.outpointIndex === input.outpointIndex);
        if (!utxo) throw new Error(`source UTXO not found: ${txid}:${input.outpointIndex}`);
        const [scriptHashData] = await engine.listScriptHashData({ scriptHash: utxo.scriptHash });
        if (!scriptHashData) throw new Error(`script hash data not found: ${utxo.scriptHash}`);
        sourceOutputs.push({
            lockingBytecode: hexToBin(scriptHashData.lockingBytecode),
            valueSatoshis: BigInt(utxo.valueSatoshis),
        });
    }

    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex, sourceOutputs, transaction: decoded });
    const result = vm.stateSuccess(state);
    if (result === true) {
        throw new Error(`expected VM to reject input ${inputIndex}, but it succeeded (txid ${preview.transactionHash})`);
    }
    console.log('VM_REJECTED (expected)', 'input', inputIndex, 'txid', preview.transactionHash, 'reason', String(result));
    return String(result);
}
