import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'install.sh.txt'), 'utf8');

/** The curl installer, with this server's origin baked in. */
export const installScript = () => TEMPLATE.replaceAll('__SITE__', config.siteUrl);
