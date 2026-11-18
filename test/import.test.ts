import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { generateTemplateIdentifier, parseTemplate } from '@xo-cash/utils';
import { mecenasTemplate } from '../source/index.js';

/**
 * Optional integration test: the engine must derive the same template
 * identifier as @xo-cash/utils. It needs a Chipnet Electrum connection, so it
 * is disabled by default and runs with `npm run test:integration`.
 */
const enabled = process.env.XO_INTEGRATION === '1';

test('Engine.importTemplate agrees with generateTemplateIdentifier', { skip: !enabled, timeout: 120_000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'xo-mecenas-import-'));
    // A throwaway BIP39 test mnemonic; this test never broadcasts.
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const engine = await Engine.create(mnemonic, {
        network: XO_SUPPORTED_NETWORKS.chipnet,
        databasePath: directory,
    });
    try {
        const imported = await engine.importTemplate(mecenasTemplate);
        const expected = generateTemplateIdentifier(parseTemplate(mecenasTemplate));
        assert.equal(imported.templateIdentifier, expected);
    } finally {
        await engine.stop().catch(() => undefined);
        rmSync(directory, { recursive: true, force: true });
    }
});
