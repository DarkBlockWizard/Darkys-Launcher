import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rcedit } from 'rcedit';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const executablePath = path.resolve(process.argv[2] || path.join(projectRoot, 'release-single', 'win-unpacked', 'Darkys.exe'));
const iconPath = path.join(projectRoot, 'src', 'assets', 'logo.ico');
const version = packageInfo.version;

await rcedit(executablePath, {
  icon: iconPath,
  'file-version': version,
  'product-version': version,
  'version-string': {
    CompanyName: 'Darkys',
    ProductName: 'Darkys Launcher',
    FileDescription: 'Darkys Launcher',
    InternalName: 'Darkys',
    OriginalFilename: 'Darkys.exe',
    LegalCopyright: 'Copyright © Darkys'
  },
  'requested-execution-level': 'asInvoker'
});
