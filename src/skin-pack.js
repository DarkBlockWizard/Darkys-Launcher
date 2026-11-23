const fs = require('fs');
const path = require('path');

const SKIN_PACK_FOLDER = 'darkys-skin';
const PLAYER_SKINS = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

function defaultSkinChoice(uuid, gameVersion) {
  const compact = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error('Yerel profil UUID değeri geçersiz.');
  const most = BigInt(`0x${compact.slice(0, 16)}`);
  const least = BigInt(`0x${compact.slice(16)}`);
  const hash = Number(BigInt.asIntN(32, most ^ (most >> 32n) ^ least ^ (least >> 32n)));
  const version = String(gameVersion || '');
  const parsed = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const isYearVersion = parsed && Number(parsed[1]) >= 25;
  const hasSkinSet = isYearVersion || Boolean(parsed && Number(parsed[1]) === 1 && Number(parsed[2]) === 21 && Number(parsed[3] || 0) >= 9)
    || /^\d{2}w\d{2}[a-z]$/i.test(version);
  if (hasSkinSet) {
    const index = ((hash % (PLAYER_SKINS.length * 2)) + PLAYER_SKINS.length * 2) % (PLAYER_SKINS.length * 2);
    return { model: index < PLAYER_SKINS.length ? 'slim' : 'wide', name: PLAYER_SKINS[index % PLAYER_SKINS.length] };
  }
  return Math.abs(hash % 2) === 1 ? { model: 'slim', name: 'alex' } : { model: 'wide', name: 'steve' };
}

function resourcePackMetadata(gameVersion) {
  const version = String(gameVersion || '');
  const parsed = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const isYearVersion = parsed && Number(parsed[1]) >= 25;
  const isModernFormat = isYearVersion || Boolean(parsed && Number(parsed[1]) === 1 && Number(parsed[2]) === 21 && Number(parsed[3] || 0) >= 9);
  if (isModernFormat || /^\d{2}w\d{2}[a-z]$/i.test(version)) {
    return {
      pack: {
        description: 'Darkys launcher-managed local skin',
        min_format: [65, 0],
        max_format: [1000, 2147483647]
      }
    };
  }

  let packFormat = 1;
  if (parsed && Number(parsed[1]) === 1) {
    const minor = Number(parsed[2]);
    const patch = Number(parsed[3] || 0);
    if (minor === 21) packFormat = patch >= 5 ? 55 : patch >= 4 ? 46 : patch >= 2 ? 42 : 34;
    else if (minor === 20) packFormat = patch >= 5 ? 32 : patch >= 3 ? 22 : patch >= 2 ? 18 : 15;
    else if (minor === 19) packFormat = patch >= 4 ? 13 : patch >= 3 ? 12 : 9;
    else if (minor === 18) packFormat = 8;
    else if (minor === 17) packFormat = 7;
    else if (minor === 16) packFormat = patch >= 2 ? 6 : 5;
    else if (minor === 15) packFormat = 5;
    else if (minor >= 13) packFormat = 4;
    else if (minor >= 8) packFormat = 3;
  }
  return {
    pack: {
      pack_format: packFormat,
      supported_formats: { min_inclusive: 1, max_inclusive: Math.max(1000, packFormat) },
      description: 'Darkys launcher-managed local skin'
    }
  };
}

function ensurePackEnabled(optionsPath) {
  let lines = [];
  if (fs.existsSync(optionsPath)) {
    lines = fs.readFileSync(optionsPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  }

  const packId = `file/${SKIN_PACK_FOLDER}`;
  const updateList = (key, defaults) => {
    const prefix = `${key}:`;
    const index = lines.findIndex(line => line.startsWith(prefix));
    let current = defaults;
    if (index >= 0) {
      try {
        const parsed = JSON.parse(lines[index].slice(prefix.length));
        if (Array.isArray(parsed)) current = parsed.filter(item => typeof item === 'string');
      } catch (_error) { /* Replace a malformed list with a safe default. */ }
    }
    current = current.filter(item => item !== packId);
    if (key === 'resourcePacks') {
      if (!current.includes('vanilla')) current.unshift('vanilla');
      current.push(packId);
    }
    const value = `${prefix}${JSON.stringify(current)}`;
    if (index >= 0) lines[index] = value;
    else lines.push(value);
  };

  updateList('resourcePacks', ['vanilla']);
  updateList('incompatibleResourcePacks', []);
  fs.mkdirSync(path.dirname(optionsPath), { recursive: true });
  const temporary = `${optionsPath}.darkys.tmp`;
  const content = `${lines.filter(Boolean).join('\n')}\n`;
  fs.writeFileSync(temporary, content, 'utf8');
  try {
    fs.renameSync(temporary, optionsPath);
  } catch (_error) {
    // Some Windows-protected folders disallow replacing a destination through
    // MoveFileEx; the game is closed here, so write the small file directly.
    fs.writeFileSync(optionsPath, content, 'utf8');
    fs.rmSync(temporary, { force: true });
  }
}

function ensureLauncherSkinPack(instanceRoot, profile, gameVersion) {
  const skinPath = profile?.localSkinPath;
  if (!skinPath || !fs.existsSync(skinPath)) return null;

  const packRoot = path.join(instanceRoot, 'resourcepacks', SKIN_PACK_FOLDER);
  const textureRoot = path.join(packRoot, 'assets', 'minecraft', 'textures', 'entity');
  const texture = fs.readFileSync(skinPath);
  const choice = defaultSkinChoice(profile.uuid, gameVersion);
  fs.mkdirSync(packRoot, { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'pack.mcmeta'), JSON.stringify(resourcePackMetadata(gameVersion), null, 2));

  if (Number(String(gameVersion).split('.')[0]) >= 25 || /^1\.21\.(?:9|[1-9]\d+)\b/.test(String(gameVersion))) {
    const directory = path.join(textureRoot, 'player', choice.model);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${choice.name}.png`), texture);
  } else {
    fs.mkdirSync(textureRoot, { recursive: true });
    fs.writeFileSync(path.join(textureRoot, `${choice.name}.png`), texture);
  }

  ensurePackEnabled(path.join(instanceRoot, 'options.txt'));
  return { path: packRoot, ...choice };
}

module.exports = { ensureLauncherSkinPack, ensurePackEnabled, resourcePackMetadata, defaultSkinChoice, SKIN_PACK_FOLDER };
