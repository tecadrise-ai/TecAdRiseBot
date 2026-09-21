import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rcedit = require('rcedit').rcedit || require('rcedit');
const electronPath = require('electron');
const distDir = path.dirname(electronPath);
const branded = path.join(distDir, 'TecAdRiseBot.exe');
const ico = path.resolve('resources/tecadrisebot-v2.ico');
if (!fs.existsSync(ico)) {
  throw new Error('missing ' + ico);
}
fs.copyFileSync(electronPath, branded);
await rcedit(branded, { icon: ico });
console.log('stamped', branded);
