const fs = require('node:fs');
const path = require('node:path');
const { rcedit } = require('rcedit');

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const executablePath = path.join(context.appOutDir, 'Darkys.exe');
  const iconPath = path.join(__dirname, '..', 'src', 'assets', 'logo.ico');
  const version = require('../package.json').version;
  if (!fs.existsSync(executablePath)) throw new Error(`Windows app executable missing: ${executablePath}`);

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
};
