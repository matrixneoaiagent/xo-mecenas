import { generateTemplateIdentifier, parseTemplate, serializeTemplate } from '@xo-cash/utils';
import { writeFileSync } from 'node:fs';
import { mecenasTemplate } from '../source/index.js';

const parsed = parseTemplate(mecenasTemplate);
const identifier = generateTemplateIdentifier(parsed);
writeFileSync(new URL('../fixtures/mecenas.template.json', import.meta.url), `${serializeTemplate(parsed)}\n`);
console.log('TEMPLATE_IDENTIFIER', identifier);
console.log('ACTIONS', Object.keys(parsed.actions).join(','));
console.log('WROTE', 'fixtures/mecenas.template.json');
