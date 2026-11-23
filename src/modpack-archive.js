const fs = require('fs');
const path = require('path');

function validateArchivePath(input, allowedRoots) {
  const normalized = String(input || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[\x00-\x1f]/.test(part))) return null;
  if (!allowedRoots.includes(parts[0])) return null;
  return parts.join('/');
}

function resolveArchivePath(root, relativePath) {
  const destination = path.resolve(root, ...String(relativePath).split('/'));
  const relative = path.relative(path.resolve(root), destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Arşiv yolu hedef klasörün dışına çıkıyor.');
  }
  return destination;
}

function addPackFolderToZip(zip, packRoot, folderName, archiveFolder = folderName) {
  const folderRoot = path.join(packRoot, folderName);
  if (!fs.existsSync(folderRoot)) return;
  const visit = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const dest = relative ? `${archiveFolder}/${relative}` : archiveFolder;
      if (entry.isDirectory()) visit(fullPath, relative ? `${relative}/${entry.name}` : entry.name);
      else if (entry.isFile()) zip.addLocalFile(fullPath, dest);
    }
  };
  visit(folderRoot, '');
}

function writeArchiveEntry(root, relativePath, bytes) {
  const destination = resolveArchivePath(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes, { flag: 'w' });
  return destination;
}

function parseMrpackManifest(index) {
  if (index?.formatVersion !== 1 || index.game !== 'minecraft' || !index.dependencies || typeof index.dependencies.minecraft !== 'string') {
    throw new Error('Modrinth modpack formatı desteklenmiyor veya Minecraft sürümü eksik.');
  }
  const gameVersion = index.dependencies.minecraft.trim();
  const loaderRows = [['fabric-loader', 'fabric'], ['forge', 'forge'], ['neoforge', 'neoforge']]
    .filter(([key]) => typeof index.dependencies[key] === 'string');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(gameVersion) || loaderRows.length > 1) {
    throw new Error('Modrinth modpack’teki Minecraft/loader seçimi geçersiz.');
  }
  const [dependencyName, loader] = loaderRows[0] || ['', 'vanilla'];
  const loaderVersion = loader === 'vanilla' ? 'release' : String(index.dependencies[dependencyName]).trim();
  if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(loaderVersion)) {
    throw new Error('Modrinth modpack’teki loader sürümü geçersiz.');
  }
  return { gameVersion, loader, loaderVersion, name: String(index.name || '').trim().slice(0, 40) || 'Modrinth Modpack' };
}

module.exports = { validateArchivePath, resolveArchivePath, addPackFolderToZip, writeArchiveEntry, parseMrpackManifest };
