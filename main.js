const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');
const Store = require('electron-store');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const AdmZip = require('adm-zip');
const { ensureLauncherSkinPack, defaultSkinChoice } = require('./src/skin-pack');
const { validateArchivePath, addPackFolderToZip, writeArchiveEntry, parseMrpackManifest } = require('./src/modpack-archive');

app.setAppUserModelId('Darkys Launcher');

// Keep player profiles, Minecraft instances, and runtimes stable when the
// distributable is renamed to the single-file Darkys.exe portable launcher.
app.setPath('userData', path.join(app.getPath('appData'), 'darkys-launcher'));
const store = new Store({ name: 'darkys-launcher' });
const launcher = new Client();
let mainWindow = null;
let recentGameLog = [];

function writeStartupLog(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'launcher-startup.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (error) {
    console.error('Unable to write launcher startup log:', error);
  }
}

process.on('uncaughtException', error => {
  writeStartupLog(`uncaughtException: ${error?.stack || error}`);
  console.error(error);
});

process.on('unhandledRejection', reason => {
  writeStartupLog(`unhandledRejection: ${reason?.stack || reason}`);
  console.error(reason);
});

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEOFORGE_METADATA = `${NEOFORGE_MAVEN}/maven-metadata.xml`;
const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest';

function createOfflineUUID(username) {
  const hash = crypto.createHash('md5')
    .update(`OfflinePlayer:${username}`, 'utf8')
    .digest();

  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

function requestJson(targetUrl) {
  return fetch(targetUrl, {
    headers: { 'User-Agent': 'DarkysLauncher/1.0' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    try {
      return await response.json();
    } catch (_err) {
      throw new Error('Sunucudan geçerli JSON verisi alınamadı.');
    }
  });
}

function defaultSettings() {
  return {
    ramMin: 2,
    ramMax: 4,
    javaPath: '',
    autoServerEnabled: false,
    autoServerAddress: ''
  };
}

function getSettings() {
  return { ...defaultSettings(), ...(store.get('settings') || {}) };
}

function getCurseForgeApiKey() {
  const encrypted = store.get('curseForgeApiKey');
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  catch (_error) { return ''; }
}

function getGameRoot(profile = store.get('profile'), versionId = 'default', loader = 'vanilla', modpackId = '') {
  const identity = String(profile?.uuid || profile?.name || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const version = String(versionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const safeLoader = ['vanilla', 'fabric', 'forge', 'neoforge'].includes(String(loader).toLowerCase())
    ? String(loader).toLowerCase() : 'vanilla';
  const userData = app.getPath('userData');
  const safePack = String(modpackId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  const instanceRoot = safePack
    ? path.join(userData, 'instances', identity, 'modpacks', safePack, `${version}-${safeLoader}`)
    : path.join(userData, 'instances', identity, `${version}-${safeLoader}`);
  if (fs.existsSync(instanceRoot)) return instanceRoot;

  fs.mkdirSync(path.dirname(instanceRoot), { recursive: true });
  const legacyRoot = path.join(userData, 'instances', `${version}-${safeLoader}`);
  if (fs.existsSync(legacyRoot)) {
    try { fs.renameSync(legacyRoot, instanceRoot); }
    catch (error) { writeStartupLog(`Instance migration skipped: ${error.message}`); }
  }

  // The previous build kept worlds and packs in one shared directory. Preserve
  // those user files when moving to the new per-profile/per-version layout.
  const oldGameRoot = path.join(userData, 'minecraft');
  if (fs.existsSync(oldGameRoot)) {
    for (const entry of ['saves', 'resourcepacks', 'shaderpacks', 'config', 'screenshots', 'options.txt', 'servers.dat']) {
      const source = path.join(oldGameRoot, entry);
      const destination = path.join(instanceRoot, entry);
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      try { fs.cpSync(source, destination, { recursive: true, errorOnExist: false }); }
      catch (error) { writeStartupLog(`User data migration skipped for ${entry}: ${error.message}`); }
    }
  }
  return instanceRoot;
}

function getModpacks() { return store.get('modpacks', []); }
function getActiveModpack() {
  const activeId = store.get('activeModpackId');
  return getModpacks().find(pack => pack.id === activeId) || null;
}
function instanceRootFor(versionId, loader, modpackOverride = undefined) {
  const active = modpackOverride === undefined ? getActiveModpack() : modpackOverride;
  const packId = active && active.gameVersion === versionId && active.loader === loader ? active.id : '';
  return getGameRoot(store.get('profile'), versionId, loader, packId);
}

ipcMain.handle('modpacks:list', () => ({ ok: true, modpacks: getModpacks(), activeId: store.get('activeModpackId') || null }));
ipcMain.handle('modpacks:create', (_event, input = {}) => {
  const name = String(input.name || '').trim().slice(0, 40);
  const gameVersion = String(input.gameVersion || '').trim();
  const loader = String(input.loader || '').trim().toLowerCase();
  const loaderVersion = String(input.loaderVersion || '').trim();
  if (!name) return { ok: false, error: 'Modpack adı gerekli.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(gameVersion)) return { ok: false, error: 'Minecraft sürümü seç.' };
  if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader)) return { ok: false, error: 'Vanilla, Fabric, Forge veya NeoForge seç.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(loaderVersion)) return { ok: false, error: 'Loader sürümü seç.' };
  const modpacks = getModpacks();
  if (modpacks.some(pack => pack.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'Bu isimde bir modpack zaten var.' };
  const pack = { id: crypto.randomUUID(), name, gameVersion, loader, loaderVersion, createdAt: new Date().toISOString() };
  try {
    const root = getGameRoot(store.get('profile'), gameVersion, loader, pack.id);
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(root, 'modpack.json'), JSON.stringify(pack, null, 2));
    modpacks.push(pack);
    store.set('modpacks', modpacks);
    store.set('activeModpackId', pack.id);
  } catch (error) {
    return { ok: false, error: `Modpack oluşturulamadı: ${error.message}` };
  }
  return { ok: true, modpack: pack, activeId: pack.id };
});
ipcMain.handle('modpacks:select', (_event, id) => {
  const pack = getModpacks().find(item => item.id === String(id || ''));
  if (!pack) return { ok: false, error: 'Modpack bulunamadı.' };
  store.set('activeModpackId', pack.id);
  return { ok: true, modpack: pack, activeId: pack.id };
});
ipcMain.handle('modpacks:delete', (_event, id) => {
  const modpacks = getModpacks();
  const pack = modpacks.find(item => item.id === String(id || ''));
  if (!pack) return { ok: false, error: 'Modpack bulunamadı.' };
  store.set('modpacks', modpacks.filter(item => item.id !== pack.id));
  if (store.get('activeModpackId') === pack.id) store.delete('activeModpackId');
  // Keep its files on disk so deleting a profile never destroys worlds or mods.
  return { ok: true };
});

ipcMain.handle('modpacks:export', async (_event, id) => {
  const pack = getModpacks().find(item => item.id === String(id || ''));
  if (!pack) return { ok: false, error: 'Dışa aktarılacak modpack bulunamadı.' };
  const safeName = String(pack.name || 'Darkys-Modpack').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'Darkys-Modpack';
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Modpack’i dışa aktar',
    defaultPath: `${safeName}.darkyspack`,
    filters: [{ name: 'Darkys Modpack', extensions: ['darkyspack', 'zip'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const packRoot = getGameRoot(store.get('profile'), pack.gameVersion, pack.loader, pack.id);
  const zip = new AdmZip();
  zip.addFile('darkys-pack.json', Buffer.from(JSON.stringify({
    format: 'darkys-modpack', formatVersion: 1,
    modpack: { name: pack.name, gameVersion: pack.gameVersion, loader: pack.loader, loaderVersion: pack.loaderVersion },
    exportedAt: new Date().toISOString()
  }, null, 2)));
  for (const folder of ['mods', 'config', 'resourcepacks', 'shaderpacks']) addPackFolderToZip(zip, packRoot, folder);
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    zip.writeZip(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
    return { ok: true, filePath };
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_cleanupError) { /* Keep the original export error. */ }
    return { ok: false, error: `Modpack dışa aktarılamadı: ${error.message}` };
  }
});

ipcMain.handle('modpacks:import', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Darkys modpack içe aktar',
    properties: ['openFile'],
    filters: [{ name: 'Modpack', extensions: ['darkyspack', 'mrpack', 'zip'] }]
  });
  if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
  if (!store.get('profile')) return { ok: false, error: 'Önce oyuncu profili oluştur.' };
  const archivePath = filePaths[0];
  const archiveStat = fs.statSync(archivePath);
  if (archiveStat.size < 1 || archiveStat.size > 512 * 1024 * 1024) return { ok: false, error: 'Arşiv boş veya 512 MB sınırını aşıyor.' };

  let zip;
  try { zip = new AdmZip(archivePath); }
  catch (error) { return { ok: false, error: `Modpack arşivi okunamadı: ${error.message}` }; }
  const entries = zip.getEntries();
  if (!entries.length || entries.length > 10000) return { ok: false, error: 'Modpack arşivindeki dosya sayısı geçersiz.' };
  if (entries.some(entry => Number(entry.header?.size || 0) > 256 * 1024 * 1024)) return { ok: false, error: 'Arşivde tek dosya için 256 MB sınırı aşılıyor.' };
  if (entries.reduce((sum, entry) => sum + Number(entry.header?.size || 0), 0) > 1024 * 1024 * 1024) return { ok: false, error: 'Arşiv açılmış halde 1 GB sınırını aşıyor.' };
  if (entries.some(entry => entry.entryName === 'modrinth.index.json' && !entry.isDirectory)) {
    try { return await importMrpackArchive(zip); }
    catch (error) { return { ok: false, error: `Modrinth modpack içe aktarılamadı: ${error.message}` }; }
  }
  const manifestEntry = entries.find(entry => entry.entryName === 'darkys-pack.json' && !entry.isDirectory);
  if (!manifestEntry) return { ok: false, error: 'Bu ZIP, Darkys modpack dışa aktarımı değil (darkys-pack.json yok).' };

  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); }
  catch (_error) { return { ok: false, error: 'Modpack manifest dosyası bozuk.' }; }
  const source = manifest?.modpack;
  const name = String(source?.name || '').trim().slice(0, 40);
  const gameVersion = String(source?.gameVersion || '').trim();
  const loader = String(source?.loader || '').trim().toLowerCase();
  const loaderVersion = String(source?.loaderVersion || '').trim();
  if (manifest.format !== 'darkys-modpack' || manifest.formatVersion !== 1 || !name || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(gameVersion)
      || !['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(loaderVersion)) {
    return { ok: false, error: 'Modpack manifest alanları desteklenmiyor veya geçersiz.' };
  }

  const accepted = [];
  const seen = new Set();
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.entryName === 'darkys-pack.json' || entry.isDirectory) continue;
    const normalized = validateArchivePath(entry.entryName, ['mods', 'config', 'resourcepacks', 'shaderpacks']);
    if (!normalized) return { ok: false, error: `Arşivde güvenli olmayan veya izin verilmeyen dosya yolu var: ${String(entry.entryName).slice(0, 100)}` };
    if (seen.has(normalized.toLowerCase())) return { ok: false, error: 'Arşivde yinelenen dosya yolu var.' };
    seen.add(normalized.toLowerCase());
    totalUncompressed += Number(entry.header?.size || 0);
    if (totalUncompressed > 1024 * 1024 * 1024) return { ok: false, error: 'Modpack açılmış halde 1 GB sınırını aşıyor.' };
    accepted.push({ entry, normalized });
  }

  let importedName = name;
  const existingNames = new Set(getModpacks().map(item => item.name.toLocaleLowerCase('tr-TR')));
  if (existingNames.has(importedName.toLocaleLowerCase('tr-TR'))) {
    let suffix = 2;
    let candidate;
    do {
      const suffixText = ` (${suffix++})`;
      candidate = `${name.slice(0, 40 - suffixText.length)}${suffixText}`;
    } while (existingNames.has(candidate.toLocaleLowerCase('tr-TR')));
    importedName = candidate;
  }
  const pack = { id: crypto.randomUUID(), name: importedName, gameVersion, loader, loaderVersion, createdAt: new Date().toISOString(), imported: true };
  const identity = String(store.get('profile')?.uuid || store.get('profile')?.name || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const safeVersion = gameVersion.replace(/[^A-Za-z0-9._-]/g, '_');
  const root = path.join(app.getPath('userData'), 'instances', identity, 'modpacks', pack.id, `${safeVersion}-${loader}`);
  const staging = `${root}.import-${crypto.randomUUID()}`;
  try {
    if (fs.existsSync(root)) throw new Error('Yeni modpack klasörü zaten mevcut.');
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(path.join(staging, 'mods'), { recursive: true });
    for (const { entry, normalized } of accepted) {
      writeArchiveEntry(staging, normalized, entry.getData());
    }
    fs.writeFileSync(path.join(staging, 'modpack.json'), JSON.stringify(pack, null, 2), { flag: 'wx' });
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(staging, root);
    store.set('modpacks', [...getModpacks(), pack]);
    store.set('activeModpackId', pack.id);
    return { ok: true, modpack: pack, importedFiles: accepted.length, activeId: pack.id };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_cleanupError) { /* Ignore failed cleanup. */ }
    return { ok: false, error: `Modpack içe aktarılamadı: ${error.message}` };
  }
});

const MRPACK_ALLOWED_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const MODPACK_CONTENT_ROOTS = ['mods', 'config', 'resourcepacks', 'shaderpacks'];

function allowedMrpackUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && MRPACK_ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch (_error) { return null; }
}

async function downloadMrpackFile(value, maxBytes) {
  let url = allowedMrpackUrl(value);
  if (!url) throw new Error('Modrinth paketindeki indirme bağlantısı güvenli kaynak listesinde değil.');
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    const response = await fetch(url, { headers: { 'User-Agent': 'DarkysLauncher/1.3' }, redirect: 'manual', signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === 3) throw new Error('İndirme bağlantısı çok fazla yönlendirme yaptı.');
      const location = response.headers.get('location');
      url = location ? allowedMrpackUrl(new URL(location, url).toString()) : null;
      if (!url) throw new Error('Modrinth indirme bağlantısı güvenli olmayan bir adrese yönlendirdi.');
      continue;
    }
    if (!response.ok) throw new Error(`Modpack dosyası indirilemedi (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('Modpack dosyası izin verilen boyutu aşıyor.');
    return bytes;
  }
  throw new Error('İndirme yönlendirmesi tamamlanamadı.');
}

function uniqueImportedPackName(name) {
  const names = new Set(getModpacks().map(item => String(item.name).toLocaleLowerCase('tr-TR')));
  if (!names.has(name.toLocaleLowerCase('tr-TR'))) return name;
  let suffix = 2;
  while (true) {
    const suffixText = ` (${suffix++})`;
    const candidate = `${name.slice(0, 40 - suffixText.length)}${suffixText}`;
    if (!names.has(candidate.toLocaleLowerCase('tr-TR'))) return candidate;
  }
}

async function importMrpackArchive(zip) {
  const entries = zip.getEntries();
  const indexEntry = entries.find(entry => entry.entryName === 'modrinth.index.json' && !entry.isDirectory);
  if (!indexEntry || Number(indexEntry.header?.size || 0) > 1024 * 1024) return { ok: false, error: 'Modrinth manifest eksik veya 1 MB sınırını aşıyor.' };
  let index;
  try { index = JSON.parse(indexEntry.getData().toString('utf8')); }
  catch (_error) { return { ok: false, error: 'Modrinth manifest dosyası bozuk.' }; }
  let parsed;
  try { parsed = parseMrpackManifest(index); }
  catch (error) { return { ok: false, error: error.message }; }
  const { gameVersion, loader, loaderVersion } = parsed;
  const rawName = parsed.name;
  const name = uniqueImportedPackName(rawName);
  const filesByPath = new Map();
  let downloadedBytes = 0;
  let manualFiles = 0;
  const installableFiles = Array.isArray(index.files) ? index.files : [];
  if (installableFiles.length > 10000) return { ok: false, error: 'Modrinth modpack 10.000’den fazla dosya içeriyor.' };

  for (const file of installableFiles) {
    if (file?.env?.client === 'unsupported') continue;
    const relative = validateArchivePath(file?.path, MODPACK_CONTENT_ROOTS);
    if (!relative) return { ok: false, error: `Modrinth modpack’te güvensiz/izin verilmeyen dosya yolu: ${String(file?.path || '').slice(0, 100)}` };
    if (!file.hashes || !/^[a-f0-9]{128}$/i.test(String(file.hashes.sha512 || '')) || !/^[a-f0-9]{40}$/i.test(String(file.hashes.sha1 || '')) || !Array.isArray(file.downloads)) {
      return { ok: false, error: `${relative} dosyasının doğrulama bilgisi eksik.` };
    }
    if (!file.downloads.length) { manualFiles++; continue; }
    const expectedSize = Number(file.fileSize || 0);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 256 * 1024 * 1024 || downloadedBytes + expectedSize > 1024 * 1024 * 1024) {
      return { ok: false, error: `${relative} için boyut sınırı geçersiz veya paket 1 GB sınırını aşıyor.` };
    }
    let bytes;
    let lastError;
    for (const downloadUrl of file.downloads) {
      try { bytes = await downloadMrpackFile(downloadUrl, expectedSize); break; }
      catch (error) { lastError = error; }
    }
    if (!bytes) throw new Error(`${relative} indirilemedi: ${lastError?.message || 'geçerli indirme adresi yok.'}`);
    if (bytes.length !== expectedSize) throw new Error(`${relative} boyut doğrulamasından geçmedi.`);
    const sha512 = crypto.createHash('sha512').update(bytes).digest('hex');
    if (sha512.toLowerCase() !== String(file.hashes.sha512).toLowerCase()) throw new Error(`${relative} SHA-512 doğrulamasından geçmedi.`);
    if (file.hashes.sha1) {
      const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
      if (sha1.toLowerCase() !== String(file.hashes.sha1).toLowerCase()) throw new Error(`${relative} SHA-1 doğrulamasından geçmedi.`);
    }
    downloadedBytes += bytes.length;
    filesByPath.set(relative.toLowerCase(), { relative, bytes });
  }

  let overrideBytes = 0;
  for (const entry of entries) {
    if (entry.isDirectory || entry.entryName === 'modrinth.index.json') continue;
    let archivePath = entry.entryName.replace(/\\/g, '/');
    if (archivePath.startsWith('overrides/')) archivePath = archivePath.slice('overrides/'.length);
    else if (archivePath.startsWith('client-overrides/')) archivePath = archivePath.slice('client-overrides/'.length);
    else continue; // Ignore server-only and unrelated metadata.
    const relative = validateArchivePath(archivePath, MODPACK_CONTENT_ROOTS);
    if (!relative) continue; // Device-local files such as options.txt are intentionally not imported.
    overrideBytes += Number(entry.header?.size || 0);
    if (overrideBytes + downloadedBytes > 1024 * 1024 * 1024 || Number(entry.header?.size || 0) > 256 * 1024 * 1024) {
      return { ok: false, error: 'Modrinth modpack’in overrides boyutu izin verilen sınırı aşıyor.' };
    }
    filesByPath.set(relative.toLowerCase(), { relative, bytes: entry.getData() });
  }

  const pack = { id: crypto.randomUUID(), name, gameVersion, loader, loaderVersion, createdAt: new Date().toISOString(), imported: 'mrpack' };
  const identity = String(store.get('profile')?.uuid || store.get('profile')?.name || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const root = path.join(app.getPath('userData'), 'instances', identity, 'modpacks', pack.id, `${gameVersion}-${loader}`);
  const staging = `${root}.import-${crypto.randomUUID()}`;
  try {
    if (fs.existsSync(root)) throw new Error('Yeni modpack klasörü zaten mevcut.');
    fs.mkdirSync(path.join(staging, 'mods'), { recursive: true });
    for (const { relative, bytes } of filesByPath.values()) writeArchiveEntry(staging, relative, bytes);
    fs.writeFileSync(path.join(staging, 'modpack.json'), JSON.stringify(pack, null, 2), { flag: 'wx' });
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(staging, root);
    store.set('modpacks', [...getModpacks(), pack]);
    store.set('activeModpackId', pack.id);
    return { ok: true, modpack: pack, importedFiles: filesByPath.size, manualFiles, activeId: pack.id };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_cleanupError) { /* Ignore cleanup failure. */ }
    return { ok: false, error: `Modrinth modpack içe aktarılamadı: ${error.message}` };
  }
}

ipcMain.handle('modpacks:exportMrpack', async (_event, id) => {
  const pack = getModpacks().find(item => item.id === String(id || ''));
  if (!pack) return { ok: false, error: 'Dışa aktarılacak modpack bulunamadı.' };
  const safeName = String(pack.name || 'Darkys-Modpack').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'Darkys-Modpack';
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Modrinth modpack olarak dışa aktar', defaultPath: `${safeName}.mrpack`,
    filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const dependencies = { minecraft: pack.gameVersion };
  if (pack.loader === 'fabric') dependencies['fabric-loader'] = pack.loaderVersion;
  else if (pack.loader === 'forge') dependencies.forge = pack.loaderVersion;
  else if (pack.loader === 'neoforge') dependencies.neoforge = pack.loaderVersion;
  const index = { formatVersion: 1, game: 'minecraft', versionId: crypto.randomUUID(), name: pack.name, summary: 'Darkys Launcher ile dışa aktarıldı.', files: [], dependencies };
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
  const packRoot = getGameRoot(store.get('profile'), pack.gameVersion, pack.loader, pack.id);
  for (const folder of MODPACK_CONTENT_ROOTS) addPackFolderToZip(zip, packRoot, folder, `overrides/${folder}`);
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    zip.writeZip(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
    return { ok: true, filePath };
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_cleanupError) { /* Keep the original error. */ }
    return { ok: false, error: `MRPack dışa aktarılamadı: ${error.message}` };
  }
});

ipcMain.handle('loaders:versions', async (_event, { gameVersion, loader } = {}) => {
  try {
    if (!gameVersion || !['vanilla', 'fabric', 'forge', 'neoforge'].includes(loader)) return { ok: false, error: 'Sürüm veya loader seçimi geçersiz.' };
    if (loader === 'vanilla') return { ok: true, versions: [{ id: 'release', stable: true }] };
    if (loader === 'fabric') {
      const rows = await requestJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
      return { ok: true, versions: (rows || []).map(row => ({ id: row.loader?.version, stable: Boolean(row.loader?.stable) })).filter(row => row.id) };
    }
    if (loader === 'neoforge') {
      const metadata = await requestBuffer(NEOFORGE_METADATA);
      const versions = [...metadata.toString('utf8').matchAll(/<version>([^<]+)<\/version>/g)]
        .map(match => match[1].trim())
        .filter(version => isNeoForgeVersionForMinecraft(version, gameVersion));
      const rows = [...new Set(versions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      return { ok: true, versions: rows.map((id, index) => ({ id, stable: index === 0 })) };
    }
    const promotions = await requestJson(FORGE_PROMOTIONS);
    const prefix = `${gameVersion}-`;
    const byId = new Map();
    for (const [key, value] of Object.entries(promotions.promos || {})) {
      if (!key.startsWith(prefix) || !value) continue;
      const row = byId.get(value) || { id: value, stable: false };
      row.stable ||= key.endsWith('-recommended');
      byId.set(value, row);
    }
    const versions = [...byId.values()]
      .sort((a, b) => Number(b.stable) - Number(a.stable) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    return { ok: true, versions };
  } catch (error) { return { ok: false, error: error.message }; }
});

function isNeoForgeVersionForMinecraft(loaderVersion, gameVersion) {
  if (gameVersion === '1.20.1') return String(loaderVersion).startsWith('1.20.1-');
  const match = String(gameVersion).match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const versionPrefix = `${match[1]}.${match[2] || '0'}.`;
  return String(loaderVersion).startsWith(versionPrefix);
}

function createWindow() {
  writeStartupLog(`Creating window from ${path.join(__dirname, 'src', 'index.html')}`);
  mainWindow = new BrowserWindow({
    title: 'Darkys Launcher',
    icon: path.join(__dirname, 'src', 'assets', 'logo.ico'),
    width: 1000,
    height: 650,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    resizable: true,
    backgroundColor: '#0e1410',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    writeStartupLog(`did-fail-load ${code}: ${description} (${url})`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeStartupLog(`render-process-gone: ${JSON.stringify(details)}`);
  });
  mainWindow.on('closed', () => writeStartupLog('Main window closed.'));
  return mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
    .then(() => writeStartupLog('Main page loaded.'))
    .catch(error => {
      writeStartupLog(`loadFile failed: ${error?.stack || error}`);
      dialog.showErrorBox('Darkys Launcher açılamadı', `Arayüz dosyası yüklenemedi. Ayrıntılar: ${error.message}`);
    });
}

app.whenReady()
  .then(createWindow)
  .catch(error => {
    writeStartupLog(`startup failed: ${error?.stack || error}`);
    dialog.showErrorBox('Darkys Launcher başlatılamadı', error?.message || String(error));
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:close', () => mainWindow?.close());

// ---------------------------------------------------------
// PROFİL
// ---------------------------------------------------------

ipcMain.handle('profile:get', () => {
  const profile = store.get('profile');
  if (!profile) return null;
  if (profile.type !== 'msa') {
    const versionId = store.get('activeInstance')?.versionId || '26.3';
    const model = defaultSkinChoice(profile.uuid, versionId).model;
    return { ...profile, skinVariant: model === 'slim' ? 'SLIM' : 'CLASSIC' };
  }
  return profile;
});

function saveRefreshToken(refreshToken) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows güvenli token kasası kullanılamıyor. Microsoft hesabı bu cihazda güvenli biçimde saklanamadı.');
  const encrypted = safeStorage.encryptString(refreshToken).toString('base64');
  store.set('accountRefreshToken', encrypted);
}

function readRefreshToken() {
  const encrypted = store.get('accountRefreshToken');
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  catch (_error) { return null; }
}

async function getMicrosoftMinecraftToken() {
  const refreshToken = readRefreshToken();
  if (!refreshToken) throw new Error('Önce Microsoft hesabınla giriş yap. Çevrimdışı kullanıcı adı resmi Minecraft hesabı yerine geçmez.');
  const auth = new Auth('select_account');
  const xbox = await auth.refresh(refreshToken);
  const minecraft = await xbox.getMinecraft();
  const entitlements = await minecraft.entitlements();
  if (!entitlements.some(item => ['game_minecraft', 'product_minecraft'].includes(item))) {
    throw new Error('Bu Microsoft hesabında Minecraft Java Edition lisansı bulunamadı.');
  }
  if (xbox.msToken?.refresh_token) saveRefreshToken(xbox.msToken.refresh_token);
  return { minecraft, xbox };
}

ipcMain.handle('profile:loginMicrosoft', async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Bu Windows oturumunda güvenli token kasası kullanılamıyor.');
    const auth = new Auth('select_account');
    auth.on('load', (_code, message) => sendToRenderer('auth:status', message));
    const xbox = await auth.launch('electron', {
      parent: mainWindow,
      modal: true,
      show: true,
      width: 520,
      height: 720,
      title: 'Microsoft hesabıyla giriş'
    });
    const minecraft = await xbox.getMinecraft();
    const entitlements = await minecraft.entitlements();
    if (!entitlements.some(item => ['game_minecraft', 'product_minecraft'].includes(item))) {
      throw new Error('Bu Microsoft hesabında Minecraft Java Edition lisansı bulunamadı.');
    }
    const profile = minecraft.profile;
    if (!profile?.id || !profile?.name) throw new Error('Microsoft hesabından Minecraft oyuncu profili alınamadı.');
    saveRefreshToken(xbox.msToken.refresh_token);
    const skin = (profile.skins || []).find(item => item.state === 'ACTIVE') || (profile.skins || [])[0];
    const savedProfile = {
      name: profile.name,
      uuid: profile.id,
      type: 'msa',
      skinUrl: skin?.url || null,
      skinVariant: skin?.variant || 'CLASSIC'
    };
    store.set('profile', savedProfile);
    return { ok: true, profile: savedProfile };
  } catch (error) {
    console.error('Microsoft sign-in error:', error);
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('profile:save', (_event, username) => {
  username = String(username || '').trim();

  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    return {
      ok: false,
      error: 'Kullanıcı adı 3-16 karakter olmalı ve sadece harf, rakam veya _ içermeli.'
    };
  }

  const uuid = createOfflineUUID(username);
  const profile = {
    name: username,
    uuid,
    type: 'offline',
    skinVariant: defaultSkinChoice(uuid, '26.3').model === 'slim' ? 'SLIM' : 'CLASSIC'
  };

  store.set('profile', profile);
  return { ok: true, profile };
});

ipcMain.handle('profile:logout', () => {
  store.delete('profile');
  store.delete('accountRefreshToken');
  return true;
});

// ---------------------------------------------------------
// AYARLAR
// ---------------------------------------------------------

ipcMain.handle('settings:get', () => ({ ...getSettings(), curseForgeConfigured: Boolean(getCurseForgeApiKey()) }));

ipcMain.handle('settings:save', (_event, settings) => {
  const current = getSettings();
  const next = {
    ...current,
    ramMin: Math.max(1, Number(settings?.ramMin) || 2),
    ramMax: Math.max(1, Number(settings?.ramMax) || 4),
    javaPath: String(settings?.javaPath || '').trim(),
    autoServerEnabled: Boolean(settings?.autoServerEnabled),
    autoServerAddress: String(settings?.autoServerAddress || '').trim()
  };

  if (next.ramMax < next.ramMin) next.ramMax = next.ramMin;
  store.set('settings', next);
  const submittedKey = String(settings?.curseForgeApiKey || '').trim();
  if (settings?.clearCurseForgeApiKey) store.delete('curseForgeApiKey');
  else if (submittedKey) {
    if (!safeStorage.isEncryptionAvailable()) return { ...next, curseForgeConfigured: Boolean(getCurseForgeApiKey()), error: 'Windows güvenli anahtar kasası kullanılamıyor; CurseForge anahtarı saklanmadı.' };
    store.set('curseForgeApiKey', safeStorage.encryptString(submittedKey).toString('base64'));
  }
  return { ...next, curseForgeConfigured: Boolean(getCurseForgeApiKey()) };
});

// ---------------------------------------------------------
// SKIN - PC'DEN SEÇ
// ---------------------------------------------------------

ipcMain.handle('skin:choose', async (_event, options = {}) => {
  const currentProfile = store.get('profile');
  const requestedVariant = typeof options === 'string' ? options : options.variant;
  const gameVersion = String(options.gameVersion || store.get('activeInstance')?.versionId || 'default');
  const loader = String(options.loader || store.get('activeInstance')?.loader || 'vanilla').toLowerCase();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Skin seç',
    properties: ['openFile'],
    filters: [
      { name: 'Minecraft Skin', extensions: ['png'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, canceled: true };
  }

  const source = result.filePaths[0];
  const image = fs.readFileSync(source);
  if (image.length > 1024 * 1024 || image.length < 24 || image.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    return { ok: false, error: 'Geçerli, 1 MB altında bir PNG skin dosyası seç.' };
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width !== 64 || ![64, 32].includes(height)) {
    return { ok: false, error: 'Skin görseli 64×64 veya eski 64×32 PNG boyutunda olmalı.' };
  }
  const variant = currentProfile?.type === 'msa'
    ? (String(requestedVariant || '').toLowerCase() === 'slim' ? 'SLIM' : 'CLASSIC')
    : (defaultSkinChoice(currentProfile?.uuid, gameVersion).model === 'slim' ? 'SLIM' : 'CLASSIC');
  const skinDirectory = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(skinDirectory, { recursive: true });
  const localSkinPath = path.join(skinDirectory, `${String(currentProfile?.uuid || 'local').replace(/[^A-Za-z0-9._-]/g, '_')}.png`);
  fs.writeFileSync(localSkinPath, image);

  // Keep a local copy for the launcher-managed skin resource pack. Uploading
  // is optional and only available to a licensed Microsoft account.
  if (currentProfile?.type !== 'msa') {
    const profile = { ...currentProfile, localSkinPath, skinVariant: variant, skinSystem: 'launcher-resource-pack' };
    store.set('profile', profile);
    store.set('skinPath', localSkinPath);
    return { ok: true, path: localSkinPath, localOnly: true, launcherManaged: true, variant };
  }
  let account;
  try { account = await getMicrosoftMinecraftToken(); }
  catch (error) { return { ok: false, error: error.message }; }

  try {
    const form = new FormData();
    form.append('variant', variant.toLowerCase());
    form.append('file', new Blob([image], { type: 'image/png' }), path.basename(source));
    const response = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.minecraft.mcToken}` },
      body: form
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Skin yüklenemedi (HTTP ${response.status}). ${detail.slice(0, 180)}`);
    }
    const updated = await response.json();
    const activeSkin = (updated.skins || []).find(item => item.state === 'ACTIVE');
    const profile = {
      ...currentProfile,
      skinUrl: activeSkin?.url || currentProfile.skinUrl,
      localSkinPath,
      skinVariant: activeSkin?.variant || variant,
      skinSystem: 'launcher-resource-pack'
    };
    store.set('profile', profile);
    return { ok: true, path: localSkinPath, launcherManaged: true, variant };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

ipcMain.handle('skin:get', () => {
  const profile = store.get('profile') || {};
  if (profile.localSkinPath && fs.existsSync(profile.localSkinPath)) return profile.localSkinPath;
  return profile.skinUrl || store.get('skinPath') || null;
});

// ---------------------------------------------------------
// RESOURCE PACK / SHADER
// ---------------------------------------------------------

function getResourcePacksRoot(options = {}) {
  const active = store.get('activeInstance') || {};
  const versionId = options.versionId || active.versionId;
  const loader = options.loader || active.loader;
  return path.join(instanceRootFor(versionId, loader), 'resourcepacks');
}

function getShaderPacksRoot(options = {}) {
  const active = store.get('activeInstance') || {};
  const versionId = options.versionId || active.versionId;
  const loader = options.loader || active.loader;
  return path.join(instanceRootFor(versionId, loader), 'shaderpacks');
}

function getContentRoot(type, options = {}) {
  if (type === 'resourcepack') return getResourcePacksRoot(options);
  if (type === 'shader') return getShaderPacksRoot(options);
  throw new Error('Geçersiz içerik türü.');
}

function listZipLikeFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => {
      const lower = entry.name.toLowerCase();
      return lower.endsWith('.zip');
    })
    .map(entry => ({
      filename: entry.name,
      path: path.join(directory, entry.name)
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename, 'tr'));
}

async function chooseAndInstallPack({ type, title, directory, label }) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters: [{ name: label, extensions: ['zip'] }]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, canceled: true };
  }

  const source = result.filePaths[0];
  const filename = path.basename(source);

  if (!filename.toLowerCase().endsWith('.zip')) {
    return { ok: false, error: `${type} dosyası ZIP olmalı.` };
  }

  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, filename);
  fs.copyFileSync(source, destination);

  return { ok: true, type, filename, path: destination };
}

ipcMain.handle('resourcepacks:chooseInstall', async (_event, options = {}) => {
  try {
    return await chooseAndInstallPack({
      type: 'Kaynak paketi',
      title: 'Kaynak paketi seç',
      directory: getResourcePacksRoot(options),
      label: 'Minecraft Kaynak Paketi'
    });
  } catch (err) {
    console.error('Resource pack install error:', err);
    return { ok: false, error: `Kaynak paketi kurulamadı: ${err.message}` };
  }
});

ipcMain.handle('resourcepacks:list', (_event, options = {}) => ({
  ok: true,
  packs: listZipLikeFiles(getResourcePacksRoot(options)),
  directory: getResourcePacksRoot(options)
}));

ipcMain.handle('resourcepacks:remove', (_event, filename, options = {}) => {
  const safeFilename = path.basename(String(filename || '').trim());
  if (!safeFilename || !safeFilename.toLowerCase().endsWith('.zip')) {
    return { ok: false, error: 'Geçersiz kaynak paketi.' };
  }

  const target = path.join(getResourcePacksRoot(options), safeFilename);
  if (!fs.existsSync(target)) return { ok: false, error: 'Kaynak paketi bulunamadı.' };

  fs.unlinkSync(target);
  return { ok: true };
});

ipcMain.handle('shaders:chooseInstall', async (_event, options = {}) => {
  try {
    return await chooseAndInstallPack({
      type: 'Shader',
      title: 'Shader paketi seç',
      directory: getShaderPacksRoot(options),
      label: 'Minecraft Shader Paketi'
    });
  } catch (err) {
    console.error('Shader install error:', err);
    return { ok: false, error: `Shader kurulamadı: ${err.message}` };
  }
});

ipcMain.handle('shaders:list', (_event, options = {}) => ({
  ok: true,
  shaders: listZipLikeFiles(getShaderPacksRoot(options)),
  directory: getShaderPacksRoot(options)
}));

ipcMain.handle('shaders:remove', (_event, filename, options = {}) => {
  const safeFilename = path.basename(String(filename || '').trim());
  if (!safeFilename || !safeFilename.toLowerCase().endsWith('.zip')) {
    return { ok: false, error: 'Geçersiz shader paketi.' };
  }

  const target = path.join(getShaderPacksRoot(options), safeFilename);
  if (!fs.existsSync(target)) return { ok: false, error: 'Shader paketi bulunamadı.' };

  fs.unlinkSync(target);
  return { ok: true };
});

// ---------------------------------------------------------
// MINECRAFT SÜRÜMLERİ
// ---------------------------------------------------------

ipcMain.handle('versions:get', async () => {
  const cacheDirectory = path.join(app.getPath('userData'), 'metadata');
  const cachePath = path.join(cacheDirectory, 'version_manifest_v2.json');
  try {
    const manifest = await requestJson(MOJANG_MANIFEST);
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(manifest));

    return {
      ok: true,
      latest: manifest.latest || {},
      versions: (manifest.versions || []).map(version => ({
        id: version.id,
        type: version.type,
        releaseTime: version.releaseTime,
        url: version.url
      }))
    };
  } catch (err) {
    console.error('Version manifest error:', err);
    try {
      const manifest = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : null;
      if (manifest?.versions?.length) {
        return {
          ok: true,
          offline: true,
          latest: manifest.latest || {},
          versions: manifest.versions.map(version => ({ id: version.id, type: version.type, releaseTime: version.releaseTime, url: version.url }))
        };
      }
    } catch (cacheError) { writeStartupLog(`Version manifest cache is invalid: ${cacheError.message}`); }

    // If this install predates the manifest cache, expose versions already
    // present in its instance folders so an offline user can still play them.
    const discovered = new Map();
    const instancesRoot = path.join(app.getPath('userData'), 'instances');
    if (fs.existsSync(instancesRoot)) {
      for (const entry of fs.readdirSync(instancesRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
        const possibleRoots = [path.join(instancesRoot, entry.name)];
        try {
          for (const child of fs.readdirSync(path.join(instancesRoot, entry.name), { withFileTypes: true }).filter(item => item.isDirectory())) {
            possibleRoots.push(path.join(instancesRoot, entry.name, child.name));
          }
        } catch (_error) { /* This is a legacy instance root. */ }
        for (const root of possibleRoots) {
          try {
            const metadataPath = path.join(root, 'loader-profile.json');
            if (!fs.existsSync(metadataPath)) continue;
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            if (metadata.gameVersion) discovered.set(metadata.gameVersion, { id: metadata.gameVersion, type: 'release', releaseTime: '', url: '' });
          } catch (_error) { /* Ignore incomplete old instance metadata. */ }
        }
      }
    }
    if (discovered.size) return { ok: true, offline: true, latest: {}, versions: [...discovered.values()] };
    return {
      ok: false,
      error: `Sürüm listesi alınamadı: ${err.message}`
    };
  }
});



// ---------------------------------------------------------
// MODRINTH
// ---------------------------------------------------------

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';

function curseForgeLoaderType(loader) {
  return ({ forge: 1, fabric: 4, neoforge: 6 })[String(loader || '').toLowerCase()] || 0;
}

async function curseForgeRequest(endpoint, keyOverride = '') {
  const apiKey = String(keyOverride || getCurseForgeApiKey()).trim();
  if (!apiKey) throw new Error('CurseForge API anahtarı gerekli. Ayarlar bölümüne ekle; Modrinth anahtarsız kullanılabilir.');
  const response = await fetch(`${CURSEFORGE_API}${endpoint}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': 'DarkysLauncher/1.3' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403 ? 'API anahtarı geçersiz veya erişim reddedildi.' : `CurseForge API HTTP ${response.status}`;
    throw new Error(detail);
  }
  const body = await response.json();
  if (body?.data === undefined) throw new Error('CurseForge yanıtında veri bulunamadı.');
  return body;
}

ipcMain.handle('curseforge:test', async (_event, suppliedKey = '') => {
  const apiKey = String(suppliedKey || getCurseForgeApiKey()).trim();
  if (!apiKey) return { ok: false, error: 'Test için önce geçerli CurseForge API anahtarı gir.' };
  try {
    const result = await curseForgeRequest('/games/432', apiKey);
    if (Number(result.data?.id) !== 432) return { ok: false, error: 'Anahtar yanıt verdi ancak Minecraft oyun erişimi doğrulanamadı.' };
    return { ok: true, gameName: result.data.name || 'Minecraft' };
  } catch (error) {
    return { ok: false, error: `CurseForge API testi başarısız: ${error.message}` };
  }
});

function curseForgeFileUrl(file) {
  return file?.downloadUrl || '';
}

function normalizeCurseForgeFile(file) {
  return {
    id: String(file?.id || ''),
    name: file?.displayName || file?.fileName || 'CurseForge sürümü',
    versionNumber: file?.displayName || file?.fileName || String(file?.id || ''),
    versionType: file?.releaseType === 1 ? 'release' : 'beta',
    datePublished: file?.fileDate || '',
    downloads: file?.downloadCount || 0,
    dependencies: file?.dependencies || [],
    fileName: file?.fileName || '',
    downloadUrl: curseForgeFileUrl(file),
    hashes: file?.hashes || []
  };
}

async function curseForgeFiles(modId, gameVersion, loader) {
  const query = new URLSearchParams({ gameVersion, modLoaderType: String(curseForgeLoaderType(loader)), pageSize: '50', index: '0' });
  const response = await curseForgeRequest(`/mods/${encodeURIComponent(modId)}/files?${query.toString()}`);
  return (response.data || []).map(row => ({ ...normalizeCurseForgeFile(row), modId: String(modId) })).filter(file => file.id && file.fileName);
}

async function installCurseForgeFile(file, gameVersion, loader, modsDirectory, visited = new Set()) {
  const visitKey = `${file.modId || ''}:${file.id}`;
  if (!file.id || visited.has(visitKey)) return [];
  visited.add(visitKey);
  const installed = [];
  for (const dependency of file.dependencies || []) {
    if (dependency.relationType !== 3 || !dependency.modId) continue;
    let dependencyFile;
    if (dependency.fileId) {
      try {
        const detail = await curseForgeRequest(`/mods/${encodeURIComponent(dependency.modId)}/files/${encodeURIComponent(dependency.fileId)}`);
        dependencyFile = normalizeCurseForgeFile(detail.data);
        dependencyFile.modId = String(dependency.modId);
      } catch (_error) { /* Resolve a compatible current version below. */ }
    }
    if (!dependencyFile?.id || !dependencyFile.fileName) {
      const candidates = await curseForgeFiles(dependency.modId, gameVersion, loader);
      dependencyFile = candidates.find(candidate => candidate.versionType === 'release') || candidates[0];
      if (dependencyFile) dependencyFile.modId = String(dependency.modId);
    }
    if (!dependencyFile) throw new Error(`CurseForge zorunlu bağımlılığı bulunamadı (mod ${dependency.modId}).`);
    installed.push(...await installCurseForgeFile(dependencyFile, gameVersion, loader, modsDirectory, visited));
  }

  const fileName = path.basename(String(file.fileName || '')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  if (!fileName.toLowerCase().endsWith('.jar')) throw new Error(`CurseForge dosyası geçerli bir mod JAR'ı değil: ${fileName}`);
  const destination = path.join(modsDirectory, fileName);
  if (!fs.existsSync(destination)) {
    let downloadUrl = file.downloadUrl;
    if (!downloadUrl) {
      const result = await curseForgeRequest(`/mods/${encodeURIComponent(file.modId)}/files/${encodeURIComponent(file.id)}/download-url`);
      downloadUrl = typeof result.data === 'string' ? result.data : '';
    }
    if (!downloadUrl) throw new Error(`${fileName} için CurseForge indirme izni veya bağlantısı bulunamadı.`);
    const bytes = await requestBuffer(downloadUrl);
    for (const hash of file.hashes || []) {
      const algorithm = hash.algo === 1 ? 'sha1' : hash.algo === 2 ? 'md5' : null;
      if (!algorithm || !hash.value) continue;
      if (crypto.createHash(algorithm).update(bytes).digest('hex').toLowerCase() !== String(hash.value).toLowerCase()) {
        throw new Error(`${fileName} ${algorithm.toUpperCase()} doğrulamasından geçmedi.`);
      }
    }
    fs.mkdirSync(modsDirectory, { recursive: true });
    const temporaryPath = `${destination}.download`;
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, destination);
  }
  installed.push(fileName);
  return installed;
}

function requestBuffer(downloadUrl) {
  return fetch(downloadUrl, {
    headers: { 'User-Agent': 'DarkysLauncher/1.0 (Modrinth mod manager)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000)
  }).then(async response => {
    if (!response.ok) {
      throw new Error(`İndirme HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  });
}

function findJavaExecutable(directory) {
  if (!fs.existsSync(directory)) return null;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'java.exe') return target;
      if (entry.isDirectory()) pending.push(target);
    }
  }
  return null;
}

async function installJavaRuntime(majorVersion) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Otomatik Java kurulumu ${process.platform}/${process.arch} için desteklenmiyor.`);
  }
  const major = Math.max(8, Math.min(27, Number(majorVersion) || 21));
  const runtimeRoot = path.join(app.getPath('userData'), 'runtimes', `temurin-${major}`);
  const marker = path.join(runtimeRoot, '.complete');
  const existing = findJavaExecutable(runtimeRoot);
  if (existing && fs.existsSync(marker)) return existing;

  sendToRenderer('game:log', `Minecraft Java ${major} çalışma ortamı indiriliyor (Eclipse Temurin)...`);
  const params = new URLSearchParams({ architecture: process.arch, image_type: 'jre', os: 'windows', vendor: 'eclipse' });
  const releases = await requestJson(`${ADOPTIUM_API}/${major}/hotspot?${params.toString()}`);
  const archive = releases?.[0]?.binary?.package;
  if (!archive?.link || !archive?.checksum) throw new Error(`Java ${major} için Windows çalışma ortamı bulunamadı.`);
  const zipBytes = await requestBuffer(archive.link);
  const actualChecksum = crypto.createHash('sha256').update(zipBytes).digest('hex');
  if (actualChecksum.toLowerCase() !== archive.checksum.toLowerCase()) throw new Error('Java paketi doğrulaması başarısız oldu (SHA-256 uyuşmuyor).');

  const runtimeParent = path.dirname(runtimeRoot);
  const staging = `${runtimeRoot}.installing-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    const zipPath = path.join(staging, 'runtime.zip');
    fs.writeFileSync(zipPath, zipBytes);
    new AdmZip(zipPath).extractAllTo(staging, true);
    fs.unlinkSync(zipPath);
    const javaPath = findJavaExecutable(staging);
    if (!javaPath) throw new Error('İndirilen Java arşivinde java.exe bulunamadı.');
    fs.writeFileSync(path.join(staging, '.complete'), JSON.stringify({ major, checksum: actualChecksum, downloadedAt: new Date().toISOString() }));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.renameSync(staging, runtimeRoot);
    const installed = findJavaExecutable(runtimeRoot);
    if (!installed || !fs.existsSync(installed)) throw new Error('Java kurulumu doğrulanamadı.');
    sendToRenderer('game:log', `Java ${major} kuruldu: ${installed}`);
    return installed;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function findSystemJava(majorVersion) {
  const candidates = [];
  if (process.platform === 'win32') {
    const found = spawnSync('where.exe', ['java.exe'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (found.status === 0) candidates.push(...String(found.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const result = spawnSync(candidate, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      const text = `${result.stdout || ''}\n${result.stderr || ''}`;
      const match = text.match(/version\s+"(?:1\.)?(\d+)/i) || text.match(/openjdk\s+(\d+)/i);
      if (match && Number(match[1]) === Number(majorVersion)) return candidate;
    } catch (_error) { /* Skip broken PATH entries. */ }
  }
  return null;
}

function modrinthRequest(endpoint) {
  return requestJson(`${MODRINTH_API}${endpoint}`);
}

async function installModrinthVersionFile(version, gameVersion, loader, modsDirectory, visited = new Set()) {
  if (!version?.id || visited.has(version.id)) return [];
  visited.add(version.id);
  const installed = [];
  for (const dependency of version.dependencies || []) {
    if (dependency.dependency_type !== 'required') continue;
    let dependencyVersion = dependency.version_id
      ? await modrinthRequest(`/version/${encodeURIComponent(dependency.version_id)}`)
      : null;
    if (!dependencyVersion && dependency.project_id) {
      const params = new URLSearchParams({
        loaders: JSON.stringify([loader]),
        game_versions: JSON.stringify([gameVersion]),
        include_changelog: 'false'
      });
      const candidates = await modrinthRequest(`/project/${encodeURIComponent(dependency.project_id)}/version?${params.toString()}`);
      dependencyVersion = (candidates || []).find(item => item.status === 'listed' && item.version_type === 'release')
        || (candidates || []).find(item => item.status === 'listed');
    }
    if (!dependencyVersion) {
      const label = dependency.project_id || dependency.version_id || 'bilinmeyen mod';
      throw new Error(`Zorunlu bağımlılık bulunamadı: ${label}`);
    }
    if (!(dependencyVersion.game_versions || []).includes(gameVersion) || !(dependencyVersion.loaders || []).includes(loader)) {
      throw new Error(`Zorunlu bağımlılık ${dependencyVersion.name || dependency.project_id || dependency.version_id} seçili Minecraft sürümü ve loader ile uyumlu değil.`);
    }
    installed.push(...await installModrinthVersionFile(dependencyVersion, gameVersion, loader, modsDirectory, visited));
  }

  if (!(version.game_versions || []).includes(gameVersion) || !(version.loaders || []).includes(loader)) {
    throw new Error(`${version.name || version.id} seçilen sürümle uyumlu değil.`);
  }
  const file = choosePrimaryFile(version);
  if (!file?.url || !file.filename) throw new Error(`${version.name || version.id} için indirme dosyası bulunamadı.`);
  const destination = path.join(modsDirectory, path.basename(file.filename));
  if (fs.existsSync(destination)) return installed;
  const data = await requestBuffer(file.url);
  if (file.hashes?.sha512 && crypto.createHash('sha512').update(data).digest('hex').toLowerCase() !== file.hashes.sha512.toLowerCase()) {
    throw new Error(`${file.filename} SHA-512 doğrulaması başarısız.`);
  }
  if (file.hashes?.sha1 && crypto.createHash('sha1').update(data).digest('hex').toLowerCase() !== file.hashes.sha1.toLowerCase()) {
    throw new Error(`${file.filename} SHA-1 doğrulaması başarısız.`);
  }
  fs.mkdirSync(modsDirectory, { recursive: true });
  const temporaryPath = `${destination}.download`;
  fs.writeFileSync(temporaryPath, data);
  fs.renameSync(temporaryPath, destination);
  installed.push(file.filename);
  return installed;
}

function getModsRoot(versionId, loader) {
  return path.join(getInstanceRoot(versionId, loader), 'mods');
}

function quarantineLegacySkinLoader(instanceRoot) {
  const modsDirectory = path.join(instanceRoot, 'mods');
  if (!fs.existsSync(modsDirectory)) return [];
  const legacyFiles = fs.readdirSync(modsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar') && /customskinloader/i.test(entry.name));
  if (!legacyFiles.length) return [];

  const disabledDirectory = path.join(instanceRoot, 'launcher-disabled-mods');
  fs.mkdirSync(disabledDirectory, { recursive: true });
  const moved = [];
  for (const entry of legacyFiles) {
    let destination = path.join(disabledDirectory, entry.name);
    if (fs.existsSync(destination)) destination = path.join(disabledDirectory, `${Date.now()}-${entry.name}`);
    fs.renameSync(path.join(modsDirectory, entry.name), destination);
    moved.push(entry.name);
  }
  return moved;
}

function getInstanceRoot(versionId, loader) {
  const safeVersion = String(versionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  const validLoaders = ['vanilla', 'fabric', 'forge', 'neoforge'];
  const requestedLoader = String(loader || 'fabric').toLowerCase();
  const safeLoader = validLoaders.includes(requestedLoader) ? requestedLoader : 'vanilla';
  return instanceRootFor(safeVersion, safeLoader);
}

async function getVanillaVersion(versionId, instanceRoot) {
  try {
    const manifest = await requestJson(MOJANG_MANIFEST);
    const entry = (manifest.versions || []).find(version => version.id === versionId);
    if (!entry) throw new Error(`${versionId} için resmi Minecraft sürüm kaydı bulunamadı.`);
    return await requestJson(entry.url);
  } catch (networkError) {
    const candidates = [];
    if (instanceRoot) {
      candidates.push(path.join(instanceRoot, 'versions', versionId, `${versionId}.json`));
      try {
        const profilePath = path.join(instanceRoot, 'loader-profile.json');
        if (fs.existsSync(profilePath)) {
          const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
          if (profile.custom) candidates.push(path.join(instanceRoot, 'versions', profile.custom, `${versionId}.json`));
        }
      } catch (_error) { /* Try the vanilla cache path. */ }
    }
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); }
      catch (_error) { /* Ignore corrupt cached metadata. */ }
    }
    throw new Error(`Sürüm bilgisi indirilemedi ve çevrimdışı kurulumda önbellek bulunamadı. ${networkError.message}`);
  }
}

async function prepareFabric(instanceRoot, gameVersion, selectedPack = getActiveModpack()) {
  const metadataPath = path.join(instanceRoot, 'loader-profile.json');
  let profile;
  let loaderVersion;
  try {
    const available = await requestJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
    const requestedVersion = selectedPack?.gameVersion === gameVersion && selectedPack.loader === 'fabric' ? selectedPack.loaderVersion : '';
    const chosen = (available || []).find(item => item.loader?.version === requestedVersion)
      || (!requestedVersion && (available || []).find(item => item.loader?.stable))
      || (!requestedVersion && available?.[0]);
    if (!chosen?.loader?.version) throw new Error(`Fabric ${gameVersion} sürümünü desteklemiyor.`);
    loaderVersion = chosen.loader.version;
    profile = await requestJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`);
  } catch (error) {
    if (!fs.existsSync(metadataPath)) throw error;
    const cached = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return { custom: cached.custom, loaderVersion: cached.loaderVersion, customArgs: cached.customArgs || [] };
  }

  const vanilla = await getVanillaVersion(gameVersion);
  const custom = `darkys-fabric-${gameVersion}-${loaderVersion}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const merged = {
    ...vanilla,
    ...profile,
    id: gameVersion,
    downloads: vanilla.downloads,
    assetIndex: vanilla.assetIndex,
    assets: vanilla.assets,
    logging: vanilla.logging,
    libraries: [...(vanilla.libraries || []), ...(profile.libraries || [])],
    arguments: {
      game: [...(vanilla.arguments?.game || []), ...(profile.arguments?.game || [])],
      jvm: [...(vanilla.arguments?.jvm || []), ...(profile.arguments?.jvm || [])]
    }
  };
  const versionDirectory = path.join(instanceRoot, 'versions', custom);
  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(path.join(versionDirectory, `${gameVersion}.json`), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(versionDirectory, `${custom}.json`), JSON.stringify(merged, null, 2));
  const customArgs = (profile.arguments?.jvm || []).filter(argument => typeof argument === 'string');
  fs.writeFileSync(metadataPath, JSON.stringify({ loader: 'fabric', gameVersion, loaderVersion, custom, customArgs }, null, 2));
  return { custom, loaderVersion, customArgs };
}

async function prepareForge(instanceRoot, gameVersion, selectedPack = getActiveModpack()) {
  const markerPath = path.join(instanceRoot, 'loader-profile.json');
  const cacheDirectory = path.join(instanceRoot, 'cache', 'forge');
  let forgeVersion;
  let installerPath;
  try {
    const promotions = await requestJson(FORGE_PROMOTIONS);
    const requestedVersion = selectedPack?.gameVersion === gameVersion && selectedPack.loader === 'forge' ? selectedPack.loaderVersion : '';
    forgeVersion = requestedVersion || promotions.promos?.[`${gameVersion}-recommended`] || promotions.promos?.[`${gameVersion}-latest`];
    if (!forgeVersion) throw new Error(`Forge ${gameVersion} için yayımlanmış bir kurulum bulunamadı.`);
    const id = `${gameVersion}-${forgeVersion}`;
    installerPath = path.join(cacheDirectory, `forge-${id}-installer.jar`);
    if (!fs.existsSync(installerPath) || fs.statSync(installerPath).size < 100000) {
      const bytes = await requestBuffer(`${FORGE_MAVEN}/${id}/forge-${id}-installer.jar`);
      if (bytes.length < 100000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Forge resmi installer dosyası geçersiz.');
      fs.mkdirSync(cacheDirectory, { recursive: true });
      fs.writeFileSync(installerPath, bytes);
    }
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ loader: 'forge', gameVersion, loaderVersion: forgeVersion }, null, 2));
  } catch (error) {
    if (!fs.existsSync(markerPath)) throw error;
    const cached = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    installerPath = path.join(cacheDirectory, `forge-${cached.gameVersion}-${cached.loaderVersion}-installer.jar`);
    if (!fs.existsSync(installerPath)) throw error;
    forgeVersion = cached.loaderVersion;
  }
  return { forge: installerPath, loaderVersion: forgeVersion };
}

async function prepareNeoForge(instanceRoot, gameVersion, selectedPack, javaPath, vanillaMetadata) {
  const markerPath = path.join(instanceRoot, 'loader-profile.json');
  const cacheDirectory = path.join(instanceRoot, 'cache', 'neoforge');
  const marker = fs.existsSync(markerPath) ? (() => { try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch (_error) { return null; } })() : null;
  const requestedVersion = selectedPack?.gameVersion === gameVersion && selectedPack.loader === 'neoforge' ? selectedPack.loaderVersion : '';
  let loaderVersion = requestedVersion || (marker?.loader === 'neoforge' && marker.gameVersion === gameVersion ? marker.loaderVersion : '');
  if (!loaderVersion) {
    const metadata = (await requestBuffer(NEOFORGE_METADATA)).toString('utf8');
    loaderVersion = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)]
      .map(match => match[1].trim()).filter(version => isNeoForgeVersionForMinecraft(version, gameVersion))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || '';
  }
  if (!loaderVersion || !isNeoForgeVersionForMinecraft(loaderVersion, gameVersion)) {
    throw new Error(`NeoForge için ${gameVersion} ile uyumlu sürüm bulunamadı.`);
  }
  const custom = `darkys-neoforge-${gameVersion}-${loaderVersion}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const versionDirectory = path.join(instanceRoot, 'versions', custom);
  const customJson = path.join(versionDirectory, `${custom}.json`);
  if (marker?.loader === 'neoforge' && marker.gameVersion === gameVersion && marker.loaderVersion === loaderVersion && fs.existsSync(customJson)) {
    return { custom, loaderVersion, customArgs: marker.customArgs || [] };
  }

  const installerPath = path.join(cacheDirectory, `neoforge-${loaderVersion}-installer.jar`);
  if (!fs.existsSync(installerPath) || fs.statSync(installerPath).size < 100000) {
    const bytes = await requestBuffer(`${NEOFORGE_MAVEN}/${encodeURIComponent(loaderVersion)}/neoforge-${encodeURIComponent(loaderVersion)}-installer.jar`);
    if (bytes.length < 100000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('NeoForge installer dosyası geçersiz.');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    fs.writeFileSync(installerPath, bytes);
  }

  // NeoForge's official installer requires an existing vanilla client and a launcher profile,
  // even though Darkys keeps both inside this isolated modpack directory.
  const vanillaDirectory = path.join(instanceRoot, 'versions', gameVersion);
  const vanillaJsonPath = path.join(vanillaDirectory, `${gameVersion}.json`);
  const vanillaJarPath = path.join(vanillaDirectory, `${gameVersion}.jar`);
  fs.mkdirSync(vanillaDirectory, { recursive: true });
  if (!fs.existsSync(vanillaJsonPath)) fs.writeFileSync(vanillaJsonPath, JSON.stringify(vanillaMetadata, null, 2));
  const clientInfo = vanillaMetadata.downloads?.client;
  if (!clientInfo?.url) throw new Error(`Minecraft ${gameVersion} istemci indirme adresi yok.`);
  let clientIsValid = fs.existsSync(vanillaJarPath);
  if (clientIsValid && clientInfo.sha1) {
    clientIsValid = crypto.createHash('sha1').update(fs.readFileSync(vanillaJarPath)).digest('hex').toLowerCase() === String(clientInfo.sha1).toLowerCase();
  }
  if (!clientIsValid) {
    const clientBytes = await requestBuffer(clientInfo.url);
    if (clientInfo.size && clientBytes.length !== Number(clientInfo.size)) throw new Error('Minecraft istemci JAR boyutu doğrulanamadı.');
    if (clientInfo.sha1 && crypto.createHash('sha1').update(clientBytes).digest('hex').toLowerCase() !== String(clientInfo.sha1).toLowerCase()) {
      throw new Error('Minecraft istemci JAR SHA-1 doğrulaması başarısız.');
    }
    const temporaryJar = `${vanillaJarPath}.download`;
    fs.writeFileSync(temporaryJar, clientBytes);
    fs.renameSync(temporaryJar, vanillaJarPath);
  }
  const launcherProfiles = path.join(instanceRoot, 'launcher_profiles.json');
  if (!fs.existsSync(launcherProfiles)) {
    fs.writeFileSync(launcherProfiles, JSON.stringify({
      profiles: { Darkys: { name: 'Darkys', lastVersionId: gameVersion, gameDir: instanceRoot } },
      selectedProfile: 'Darkys', clientToken: crypto.randomUUID()
    }, null, 2));
  }

  sendToRenderer('game:log', `NeoForge ${loaderVersion} izole profil için kuruluyor...`);
  const install = spawnSync(javaPath, ['-jar', installerPath, '--installClient', instanceRoot], {
    cwd: instanceRoot, encoding: 'utf8', timeout: 240000, windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  if (install.error) throw new Error(`NeoForge kurulumu başlatılamadı: ${install.error.message}`);
  if (install.status !== 0) {
    const detail = String(install.stderr || install.stdout || '').trim().split(/\r?\n/).slice(-6).join(' | ');
    throw new Error(`NeoForge yükleyicisi hata kodu ${install.status ?? 'bilinmiyor'} verdi.${detail ? ` ${detail}` : ''}`);
  }

  const versionsRoot = path.join(instanceRoot, 'versions');
  const profiles = [];
  if (fs.existsSync(versionsRoot)) {
    for (const entry of fs.readdirSync(versionsRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const candidate = path.join(versionsRoot, entry.name, `${entry.name}.json`);
      if (!fs.existsSync(candidate)) continue;
      try {
        const profile = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const profileLibraries = (profile.libraries || []).map(library => String(library.name || '')).join('\n');
        if ((profile.inheritsFrom === gameVersion || profile.id?.includes(loaderVersion))
            && /neoforge|bootstraplauncher/i.test(`${profile.id || ''}\n${profile.mainClass || ''}\n${profileLibraries}`)) {
          profiles.push({ profile, candidate });
        }
      } catch (_error) { /* Ignore unrelated/broken installed versions. */ }
    }
  }
  const installedProfile = profiles.sort((a, b) => b.candidate.localeCompare(a.candidate))[0]?.profile;
  if (!installedProfile?.mainClass || !installedProfile.libraries?.length) {
    throw new Error('NeoForge kuruldu ancak kullanılabilir NeoForge sürüm profili oluşturulmadı.');
  }

  const profileArgs = installedProfile.arguments || {};
  const merged = {
    ...vanillaMetadata,
    ...installedProfile,
    id: gameVersion,
    inheritsFrom: gameVersion,
    downloads: vanillaMetadata.downloads,
    assetIndex: vanillaMetadata.assetIndex,
    assets: vanillaMetadata.assets,
    logging: vanillaMetadata.logging,
    libraries: [...(vanillaMetadata.libraries || []), ...(installedProfile.libraries || [])],
    arguments: {
      game: [...(vanillaMetadata.arguments?.game || []), ...(profileArgs.game || [])],
      jvm: [...(vanillaMetadata.arguments?.jvm || []), ...(profileArgs.jvm || [])]
    }
  };
  fs.mkdirSync(versionDirectory, { recursive: true });
  fs.writeFileSync(path.join(versionDirectory, `${gameVersion}.json`), JSON.stringify(merged, null, 2));
  fs.writeFileSync(customJson, JSON.stringify(merged, null, 2));
  const customArgs = (profileArgs.jvm || []).filter(argument => typeof argument === 'string');
  fs.writeFileSync(markerPath, JSON.stringify({ loader: 'neoforge', gameVersion, loaderVersion, custom, customArgs }, null, 2));
  return { custom, loaderVersion, customArgs };
}

async function prepareLoader(gameVersion, loader, selectedPack = getActiveModpack(), javaPath, vanillaMetadata) {
  const instanceRoot = instanceRootFor(gameVersion, loader, selectedPack);
  fs.mkdirSync(instanceRoot, { recursive: true });
  if (loader === 'vanilla') return { root: instanceRoot };
  if (loader === 'fabric') return { root: instanceRoot, ...(await prepareFabric(instanceRoot, gameVersion, selectedPack)) };
  if (loader === 'forge') return { root: instanceRoot, ...(await prepareForge(instanceRoot, gameVersion, selectedPack)) };
  if (loader === 'neoforge') return { root: instanceRoot, ...(await prepareNeoForge(instanceRoot, gameVersion, selectedPack, javaPath, vanillaMetadata)) };
  throw new Error('Desteklenmeyen mod loader.');
}

function choosePrimaryFile(version) {
  if (!version?.files?.length) return null;
  return version.files.find(file => file.primary) || version.files[0];
}

ipcMain.handle('logs:analyze', async () => {
  const pack = getActiveModpack();
  const active = store.get('activeInstance') || {};
  const versionId = pack?.gameVersion || active.versionId || 'default';
  const loader = pack?.loader || active.loader || 'vanilla';
  const root = pack
    ? getGameRoot(store.get('profile'), pack.gameVersion, pack.loader, pack.id)
    : getGameRoot(store.get('profile'), versionId, loader);
  let logPath = path.join(root, 'logs', 'latest.log');
  let content = '';
  const crashDirectory = path.join(root, 'crash-reports');
  try {
    if (fs.existsSync(crashDirectory)) {
      const latestCrash = fs.readdirSync(crashDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
        .map(entry => ({ file: path.join(crashDirectory, entry.name), time: fs.statSync(path.join(crashDirectory, entry.name)).mtimeMs }))
        .sort((a, b) => b.time - a.time)[0];
      if (latestCrash) logPath = latestCrash.file;
    }
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      const bytes = fs.readFileSync(logPath);
      content = bytes.subarray(Math.max(0, bytes.length - 1024 * 1024)).toString('utf8').split(/\r?\n/).slice(-700).join('\n');
      if (stat.size > 1024 * 1024) content = `[Son bölüm gösteriliyor; log ${Math.round(stat.size / 1024)} KB]\n${content}`;
    }
  } catch (error) {
    writeStartupLog(`Log analysis read failed: ${error.message}`);
  }
  if (!content && recentGameLog.length) content = recentGameLog.slice(-700).join('\n');
  if (!content) return { title: 'Oyun günlüğü bulunamadı', summary: 'Bu modpack için Minecraft logu veya crash raporu henüz oluşturulmamış.', evidence: [], logPath: '' };

  const rules = [
    { pattern: /OutOfMemoryError|GC overhead limit exceeded/i, title: 'Bellek yetersizliği olası', summary: 'Minecraft Java belleği tükenmiş. Ayarlardaki RAM üst sınırını artır; sistem belleğinin tamamını oyuna ayırma.', match: /OutOfMemoryError|GC overhead limit exceeded/i },
    { pattern: /UnsupportedClassVersionError|class file version \d+\.\d+/i, title: 'Java sürümü uyumsuz', summary: 'Bir mod veya oyun bileşeni kullanılan Java sürümüyle uyumlu değil. Minecraft sürümüne uygun Java 17/21 kullan ve özel Java yolunu kontrol et.', match: /UnsupportedClassVersionError|class file version \d+\.\d+/i },
    { pattern: /ModLoadingException|Failed to load.*mod|Missing or unsupported mandatory dependencies|Mod File .* needs language provider/i, title: 'Mod yükleme hatası', summary: 'Bir mod eksik bağımlılık, yanlış loader veya Minecraft sürüm uyumsuzluğu nedeniyle yüklenememiş. Son eklenen modu/bağımlılıklarını kontrol et.', match: /ModLoadingException|Failed to load.*mod|Missing or unsupported mandatory dependencies|Mod File .* needs language provider/i },
    { pattern: /Mixin apply failed|MixinApplyError|NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException/i, title: 'Mod sürümü veya çakışma hatası', summary: 'Günlükte bir modun başka bir mod/oyun sürümüyle uyumsuz olabileceğini gösteren kayıt var. Kanıttaki modları tek tek devre dışı bırakıp uyumlu sürümleri dene.', match: /Mixin apply failed|MixinApplyError|NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException/i },
    { pattern: /Could not download|Failed to download|HTTP 404|ECONNRESET|ETIMEDOUT|UnknownHostException/i, title: 'İndirme veya ağ hatası', summary: 'Oyun dosyası ya da kütüphane indirilememiş. İnternet bağlantısını kontrol edip launcher’ı yeniden çalıştır; bozuk indirme otomatik doğrulanıp yenilenir.', match: /Could not download|Failed to download|HTTP 404|ECONNRESET|ETIMEDOUT|UnknownHostException/i },
    { pattern: /EXCEPTION_ACCESS_VIOLATION|0xc0000005|A fatal error has been detected by the Java Runtime Environment/i, title: 'Java veya grafik sürücüsü çökmesi', summary: 'Native Java/GPU bileşeni çökmüş olabilir. Grafik sürücüsünü güncelle, shaderları kapat ve özel JVM argümanlarını kaldırarak tekrar dene.', match: /EXCEPTION_ACCESS_VIOLATION|0xc0000005|A fatal error has been detected by the Java Runtime Environment/i }
  ];
  const matchingRule = rules.find(rule => rule.pattern.test(content));
  const evidence = [...new Set(content.split(/\r?\n/).filter(line => rules.some(rule => rule.match.test(line)) || /\b(ERROR|FATAL)\b/i.test(line)))].slice(-6).map(line => line.trim().slice(0, 240));
  if (matchingRule) return { title: matchingRule.title, summary: matchingRule.summary, evidence, logPath };
  if (/Stopping!/.test(content)) return { title: 'Belirgin çökme imzası yok', summary: 'Günlük normal kapanış işareti içeriyor; bu kayıt tek başına çökme göstermiyor. Sorun oyun içindeyse kapanmadan hemen önceki ayrıntıları incele.', evidence, logPath };
  if (/401|InvalidCredentialsException|Realms authentication error/i.test(content)) return { title: 'Çevrimdışı kimlik doğrulama uyarısı', summary: 'Yerel profil Mojang/Realms hesabına giriş yapmadığı için kimlik doğrulama reddedilmiş. Bu uyarı tek başına çevrimdışı tek oyunculu açılışın çöktüğü anlamına gelmez.', evidence, logPath };
  return { title: 'Belirgin çökme nedeni bulunamadı', summary: 'Bilinen hata imzaları bulunmadı. Günlük yolu aşağıda; hata tekrar oluştuğunda bu raporu oyunun kapanmasından hemen sonra çalıştır.', evidence, logPath };
});

ipcMain.handle('curseforge:search', async (_event, options = {}) => {
  try {
    const query = String(options.query || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || '').toLowerCase();
    const modLoaderType = curseForgeLoaderType(loader);
    if (!gameVersion || !modLoaderType) return { ok: false, error: 'CurseForge modları için desteklenen loader ile bir Minecraft modpack’i seç.' };
    const sortField = ({ downloads: 6, updated: 3, newest: 11, relevance: 2, follows: 2 })[options.index] || 2;
    const params = new URLSearchParams({ gameId: '432', classId: '6', gameVersion, modLoaderType: String(modLoaderType), pageSize: '30', index: '0', sortField: String(sortField), sortOrder: 'desc' });
    if (query) params.set('searchFilter', query);
    const response = await curseForgeRequest(`/mods/search?${params.toString()}`);
    return {
      ok: true,
      total: response.pagination?.totalCount || (response.data || []).length,
      hits: (response.data || []).map(mod => ({
        projectId: String(mod.id), provider: 'curseforge', title: mod.name || mod.slug || `Mod ${mod.id}`,
        description: mod.summary || '', author: mod.authors?.[0]?.name || 'CurseForge', downloads: mod.downloadCount || 0,
        iconUrl: mod.logo?.url || '', projectType: 'mod'
      }))
    };
  } catch (error) {
    console.error('CurseForge search error:', error);
    return { ok: false, error: `CurseForge araması başarısız: ${error.message}` };
  }
});

ipcMain.handle('curseforge:getVersions', async (_event, options = {}) => {
  try {
    const modId = String(options.projectId || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || '').toLowerCase();
    if (!/^\d+$/.test(modId) || !gameVersion || !curseForgeLoaderType(loader)) return { ok: false, error: 'CurseForge mod sürümü için geçerli proje, oyun sürümü ve loader gerekli.' };
    return { ok: true, versions: await curseForgeFiles(modId, gameVersion, loader) };
  } catch (error) {
    console.error('CurseForge versions error:', error);
    return { ok: false, error: `CurseForge sürümleri alınamadı: ${error.message}` };
  }
});

ipcMain.handle('curseforge:install', async (_event, options = {}) => {
  try {
    const modId = String(options.projectId || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || '').toLowerCase();
    const requestedVersionId = String(options.versionId || '').trim();
    if (!/^\d+$/.test(modId) || !gameVersion || !curseForgeLoaderType(loader)) return { ok: false, error: 'CurseForge mod kurulumu için geçerli proje, oyun sürümü ve loader gerekli.' };
    const files = await curseForgeFiles(modId, gameVersion, loader);
    const selectedFile = files.find(file => file.id === requestedVersionId) || files.find(file => file.versionType === 'release') || files[0];
    if (!selectedFile) return { ok: false, error: 'Bu Minecraft sürümü ve loader için indirilebilir CurseForge mod sürümü bulunamadı.' };
    const modsDir = getModsRoot(gameVersion, loader);
    const installedFiles = await installCurseForgeFile(selectedFile, gameVersion, loader, modsDir);
    return {
      ok: true, filename: selectedFile.fileName, version: selectedFile.versionNumber, modsDir,
      dependencies: installedFiles.filter(filename => filename !== selectedFile.fileName)
    };
  } catch (error) {
    console.error('CurseForge install error:', error);
    return { ok: false, error: `CurseForge modu kurulamadı: ${error.message}` };
  }
});

ipcMain.handle('modrinth:search', async (_event, options = {}) => {
  try {
    const query = String(options.query || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || 'fabric').trim().toLowerCase();
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) return { ok: false, error: 'Mod aramak için Fabric, Forge veya NeoForge profili seç.' };
    const index = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(options.index)
      ? options.index
      : 'relevance';

    const facets = [
      ['project_type:mod'],
      [`versions:${gameVersion}`],
      [`categories:${loader}`]
    ];

    const params = new URLSearchParams();
    if (query) params.set('query', query);
    params.set('facets', JSON.stringify(facets));
    params.set('index', index);
    params.set('limit', '30');

    const result = await modrinthRequest(`/search?${params.toString()}`);

    return {
      ok: true,
      hits: (result.hits || []).map(hit => ({
        projectId: hit.project_id,
        provider: 'modrinth',
        title: hit.title,
        description: hit.description,
        author: hit.author,
        downloads: hit.downloads,
        follows: hit.follows,
        iconUrl: hit.icon_url,
        projectType: hit.project_type,
        versions: hit.versions || [],
        categories: hit.categories || []
      })),
      total: result.total_hits || 0
    };
  } catch (err) {
    console.error('Modrinth search error:', err);
    return { ok: false, error: `Modrinth araması başarısız: ${err.message}` };
  }
});

ipcMain.handle('modrinth:contentSearch', async (_event, options = {}) => {
  try {
    const type = options.type === 'shader' ? 'shader' : 'resourcepack';
    const gameVersion = String(options.gameVersion || '').trim();
    const query = String(options.query || '').trim();
    const index = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(options.index) ? options.index : 'relevance';
    if (!gameVersion) return { ok: false, error: 'Önce Minecraft sürümü seç.' };
    const params = new URLSearchParams();
    if (query) params.set('query', query);
    params.set('facets', JSON.stringify([[`project_type:${type}`], [`versions:${gameVersion}`]]));
    params.set('index', index);
    params.set('limit', '30');
    const result = await modrinthRequest(`/search?${params.toString()}`);
    return {
      ok: true,
      total: result.total_hits || 0,
      hits: (result.hits || []).map(hit => ({
        projectId: hit.project_id,
        title: hit.title,
        description: hit.description,
        author: hit.author,
        downloads: hit.downloads,
        iconUrl: hit.icon_url,
        projectType: hit.project_type,
        categories: hit.categories || []
      }))
    };
  } catch (error) {
    console.error('Modrinth content search error:', error);
    return { ok: false, error: `Modrinth araması başarısız: ${error.message}` };
  }
});

ipcMain.handle('modrinth:contentInstall', async (_event, options = {}) => {
  try {
    const type = options.type === 'shader' ? 'shader' : 'resourcepack';
    const projectId = String(options.projectId || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    if (!projectId || !gameVersion) return { ok: false, error: 'Proje ve Minecraft sürümü gerekli.' };
    const params = new URLSearchParams({ game_versions: JSON.stringify([gameVersion]), include_changelog: 'false' });
    const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
    const compatible = (versions || []).filter(version => version.status === 'listed' && (version.game_versions || []).includes(gameVersion));
    const version = compatible.find(item => item.version_type === 'release') || compatible[0];
    const file = choosePrimaryFile(version);
    if (!file?.url || !file.filename || path.extname(file.filename).toLowerCase() !== '.zip') {
      return { ok: false, error: 'Bu sürüm için indirilebilir ZIP dosyası bulunamadı.' };
    }
    if (file.size && file.size > 1024 * 1024 * 1024) return { ok: false, error: 'Dosya boyutu 1 GB sınırını aşıyor.' };
    const targetDirectory = getContentRoot(type, options);
    fs.mkdirSync(targetDirectory, { recursive: true });
    const filename = path.basename(file.filename);
    const destination = path.join(targetDirectory, filename);
    const data = await requestBuffer(file.url);
    if (file.hashes?.sha1) {
      const digest = crypto.createHash('sha1').update(data).digest('hex');
      if (digest.toLowerCase() !== file.hashes.sha1.toLowerCase()) throw new Error('İndirilen dosyanın SHA-1 doğrulaması başarısız.');
    }
    fs.writeFileSync(destination, data);
    return { ok: true, type, filename, version: version.version_number, directory: targetDirectory };
  } catch (error) {
    console.error('Modrinth content install error:', error);
    return { ok: false, error: `İçerik kurulamadı: ${error.message}` };
  }
});

ipcMain.handle('modrinth:getVersions', async (_event, options = {}) => {
  try {
    const projectId = String(options.projectId || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || 'fabric').trim().toLowerCase();
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) return { ok: false, error: 'Mod aramak için Fabric, Forge veya NeoForge profili seç.' };

    if (!projectId || !gameVersion || !loader) {
      return { ok: false, error: 'Mod sürümü için proje, Minecraft sürümü ve loader gerekli.' };
    }

    const params = new URLSearchParams({
      loaders: JSON.stringify([loader]),
      game_versions: JSON.stringify([gameVersion]),
      include_changelog: 'false'
    });

    const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);

    return {
      ok: true,
      versions: (versions || []).map(version => ({
        id: version.id,
        name: version.name,
        versionNumber: version.version_number,
        versionType: version.version_type,
        datePublished: version.date_published,
        downloads: version.downloads,
        dependencies: version.dependencies || [],
        file: choosePrimaryFile(version)
          ? {
              url: choosePrimaryFile(version).url,
              filename: choosePrimaryFile(version).filename,
              size: choosePrimaryFile(version).size,
              sha1: choosePrimaryFile(version).hashes?.sha1 || null
            }
          : null
      }))
    };
  } catch (err) {
    console.error('Modrinth versions error:', err);
    return { ok: false, error: `Mod sürümleri alınamadı: ${err.message}` };
  }
});

ipcMain.handle('modrinth:install', async (_event, options = {}) => {
  try {
    const projectId = String(options.projectId || '').trim();
    const gameVersion = String(options.gameVersion || '').trim();
    const loader = String(options.loader || 'fabric').trim().toLowerCase();
    const requestedVersionId = String(options.versionId || '').trim();
    if (!['fabric', 'forge', 'neoforge'].includes(loader)) return { ok: false, error: 'Mod kurmak için Fabric, Forge veya NeoForge profili seç.' };

    if (!projectId || !gameVersion || !loader) {
      return { ok: false, error: 'Eksik mod bilgisi.' };
    }

    let version;

    if (requestedVersionId) {
      version = await modrinthRequest(`/version/${encodeURIComponent(requestedVersionId)}`);
    } else {
      const params = new URLSearchParams({
        loaders: JSON.stringify([loader]),
        game_versions: JSON.stringify([gameVersion]),
        include_changelog: 'false'
      });
      const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${params.toString()}`);
      version = (versions || []).find(v => v.status === 'listed') || versions?.[0];
    }

    if (!version) return { ok: false, error: 'Bu Minecraft sürümü/loader için uygun mod sürümü bulunamadı.' };
    if (!(version.game_versions || []).includes(gameVersion) || !(version.loaders || []).includes(loader)) {
      return { ok: false, error: 'Mod sürümü seçilen Minecraft sürümü ve loader ile uyumlu değil.' };
    }

    const modsDir = getModsRoot(gameVersion, loader);
    fs.mkdirSync(modsDir, { recursive: true });
    const installedFiles = await installModrinthVersionFile(version, gameVersion, loader, modsDir);
    const file = choosePrimaryFile(version);

    return {
      ok: true,
      filename: file.filename,
      version: version.version_number,
      modsDir,
      dependencies: installedFiles.filter(filename => filename !== file.filename)
    };
  } catch (err) {
    console.error('Modrinth install error:', err);
    return { ok: false, error: `Mod kurulamadı: ${err.message}` };
  }
});

ipcMain.handle('mods:list', async (_event, options = {}) => {
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || 'fabric').trim().toLowerCase();
  const modsDir = getModsRoot(gameVersion, loader);

  if (!fs.existsSync(modsDir)) return { ok: true, mods: [] };

  const mods = fs.readdirSync(modsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar') && !/customskinloader/i.test(entry.name))
    .map(entry => ({
      filename: entry.name,
      path: path.join(modsDir, entry.name)
    }));

  return { ok: true, mods, modsDir };
});

ipcMain.handle('mods:remove', async (_event, options = {}) => {
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || 'fabric').trim().toLowerCase();
  const filename = path.basename(String(options.filename || '').trim());

  if (!gameVersion || !filename || !filename.toLowerCase().endsWith('.jar')) {
    return { ok: false, error: 'Geçersiz mod dosyası.' };
  }
  if (/customskinloader/i.test(filename)) return { ok: false, error: 'Skin desteği artık launcher içinde çalışır; bu skin modu kaldırıldı.' };

  const target = path.join(getModsRoot(gameVersion, loader), filename);
  if (!fs.existsSync(target)) return { ok: false, error: 'Mod bulunamadı.' };

  fs.unlinkSync(target);
  return { ok: true };
});

// ---------------------------------------------------------
// MINECRAFT BAŞLAT
// ---------------------------------------------------------

ipcMain.handle('game:launch', async (_event, { versionId, versionType, loader }) => {
  let profile = store.get('profile');
  const settings = getSettings();

  if (!profile) {
    return { ok: false, error: 'Önce kullanıcı adı belirlemelisin.' };
  }

  if (!versionId) {
    return { ok: false, error: 'Minecraft sürümü seçilmedi.' };
  }

  const selectedModpack = getActiveModpack();
  if (!selectedModpack) return { ok: false, error: 'Önce Modlar bölümünden bir modpack oluştur veya seç.' };
  if (selectedModpack.gameVersion !== String(versionId) || selectedModpack.loader !== String(loader || '').toLowerCase()) {
    return { ok: false, error: 'Aktif modpack seçimi değişmiş. Modpack’i yeniden seçip tekrar başlat.' };
  }

  const requestedLoader = String(loader || '').toLowerCase();
  loader = ['vanilla', 'fabric', 'forge', 'neoforge'].includes(requestedLoader) ? requestedLoader : 'vanilla';

  recentGameLog = [];

  launcher.removeAllListeners('debug');
  launcher.removeAllListeners('data');
  launcher.removeAllListeners('progress');
  launcher.removeAllListeners('close');

  launcher.on('debug', message => sendToRenderer('game:log', String(message)));
  launcher.on('data', message => sendToRenderer('game:log', String(message)));
  launcher.on('progress', data => sendToRenderer('game:progress', data));
  launcher.on('close', code => sendToRenderer('game:closed', code));

  try {
    const loaderName = loader === 'vanilla' ? 'Vanilla' : loader[0].toUpperCase() + loader.slice(1);
    sendToRenderer('game:log', `${loaderName} profili hazırlanıyor...`);
    let authorization;
    if (profile.type === 'msa') {
      sendToRenderer('game:log', 'Microsoft oturumu ve Minecraft lisansı doğrulanıyor...');
      const account = await getMicrosoftMinecraftToken();
      authorization = account.minecraft.mclc(true);
      const activeSkin = (account.minecraft.profile?.skins || []).find(item => item.state === 'ACTIVE');
      profile = {
        ...profile,
        name: account.minecraft.profile.name,
        uuid: account.minecraft.profile.id,
        skinUrl: activeSkin?.url || profile.skinUrl,
        skinVariant: activeSkin?.variant || profile.skinVariant
      };
      store.set('profile', profile);
    } else {
      // Offline identity is for local/offline play only. It does not authenticate
      // the player with Mojang/Microsoft services or grant multiplayer access.
      authorization = {
        access_token: profile.uuid,
        client_token: profile.uuid,
        uuid: profile.uuid,
        name: profile.name,
        user_properties: '{}',
        meta: { type: 'legacy', demo: false }
      };
      sendToRenderer('game:log', `Yerel çevrimdışı profil: ${profile.name}`);
    }
    const vanillaRoot = instanceRootFor(versionId, loader, selectedModpack);
    const gameMetadata = await getVanillaVersion(versionId, vanillaRoot);
    let javaPath = settings.javaPath;
    if (javaPath && (!fs.existsSync(javaPath) || !fs.statSync(javaPath).isFile())) {
      throw new Error(`Seçilen Java dosyası bulunamadı: ${javaPath}`);
    }
    if (!javaPath) {
      const requiredJava = gameMetadata.javaVersion?.majorVersion || 21;
      javaPath = findSystemJava(requiredJava) || await installJavaRuntime(requiredJava);
    }
    const loaderSetup = await prepareLoader(versionId, loader, selectedModpack, javaPath, gameMetadata);
    store.set('activeInstance', { versionId, loader });
    try {
      const disabledSkinMods = quarantineLegacySkinLoader(loaderSetup.root);
      if (disabledSkinMods.length) {
        sendToRenderer('game:log', `Eski skin modu geri alınabilir klasöre taşındı: ${disabledSkinMods.join(', ')}`);
      }
    } catch (migrationError) {
      sendToRenderer('game:log', `Eski skin modu taşınamadı; oyun başlatılmaya devam ediyor: ${migrationError.message}`);
    }
    if (profile.localSkinPath && fs.existsSync(profile.localSkinPath)) {
      try {
        const skinPack = ensureLauncherSkinPack(loaderSetup.root, profile, versionId);
        if (skinPack && profile.type !== 'msa') {
          profile = { ...profile, skinVariant: skinPack.model === 'slim' ? 'SLIM' : 'CLASSIC' };
          store.set('profile', profile);
        }
        sendToRenderer('game:log', 'Darkys skin özelliği launcher tarafından kaynak paketi özelliğiyle uygulandı; mod gerekmez.');
      } catch (skinError) {
        sendToRenderer('game:log', `Skin uygulanamadı; oyun yine de başlatılıyor: ${skinError.message}`);
      }
    }
    const opts = {
      authorization,
      root: loaderSetup.root,
      version: {
        number: versionId,
        type: versionType || 'release',
        ...(loaderSetup.custom ? { custom: loaderSetup.custom } : {})
      },
      memory: {
        min: `${settings.ramMin}G`,
        max: `${settings.ramMax}G`
      },
      overrides: { gameDirectory: loaderSetup.root }
    };

    if (loaderSetup.forge) opts.forge = loaderSetup.forge;
    if (loaderSetup.customArgs?.length) opts.customArgs = loaderSetup.customArgs;
    opts.javaPath = javaPath;
    if (settings.autoServerEnabled && settings.autoServerAddress) {
      const parsed = parseServerAddress(settings.autoServerAddress);
      if (parsed) opts.quickPlay = { type: 'multiplayer', identifier: parsed.port === 25565 ? parsed.host : `${parsed.host}:${parsed.port}` };
    }

    const process = await launcher.launch(opts);
    if (!process) return { ok: false, error: `${loader} başlatıcısı oyunu başlatamadı. Oyun günlüğünü kontrol et.` };
    return { ok: true };
  } catch (err) {
    console.error('Minecraft launch error:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

function parseServerAddress(value) {
  let address = String(value || '').trim();
  if (!address) return null;

  let host = address;
  let port = 25565;

  // IPv6: [::1]:25565
  const ipv6 = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    host = ipv6[1];
    if (ipv6[2]) port = Number(ipv6[2]);
    return { host, port };
  }

  const colon = address.lastIndexOf(':');
  if (colon > -1 && address.indexOf(':') === colon) {
    const possiblePort = Number(address.slice(colon + 1));
    if (Number.isInteger(possiblePort) && possiblePort >= 1 && possiblePort <= 65535) {
      host = address.slice(0, colon);
      port = possiblePort;
    }
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function sendToRenderer(channel, data) {
  if (channel === 'game:log') {
    const line = String(data);
    recentGameLog.push(line);
    if (recentGameLog.length > 3000) recentGameLog.splice(0, recentGameLog.length - 3000);
    writeStartupLog(`game: ${line}`);
  }
  if (channel === 'game:closed') writeStartupLog(`game closed with exit code ${data}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
