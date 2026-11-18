import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACTS_DIR } from './config.js';

/** Writes a run artifact under `artifacts/` and returns its path. */
export function writeArtifact(name: string, contents: string): string {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const path = resolve(ARTIFACTS_DIR, name);
    writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`);
    return path;
}
