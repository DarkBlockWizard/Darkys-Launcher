const api = window.darkys;
const $ = id => document.getElementById(id);

const viewLogin = $('view-login');
const viewMain = $('view-main');
const usernameInput = $('username-input');
const loginStatus = $('login-status');
const btnLogin = $('btn-login');
const btnPlay = $('btn-play');
const versionSelect = $('version-select');
const logBox = $('log-box');
const progressWrap = $('progress-wrap');
const progressBar = $('progress-bar');
const progressText = $('progress-text');

function getSelectedInstanceOptions() {
  return { versionId: versionSelect.value || 'default', loader: $('mod-loader')?.value || 'vanilla' };
}

let versions = [];
let modpacks = [];
let activeModpackId = null;
let modSearchResults = [];
let modSearchBusy = false;
let versionsRefreshBusy = false;

$('btn-min').onclick = api.minimize;
$('btn-close').onclick = api.close;

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.onclick = () => switchTab(btn.dataset.tab);
});

function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.id === `tab-${name}`);
  });
  if (name === 'mods') loadInstalledMods();
  if (name === 'resourcepacks') { loadResourcePacks(); searchContent('resourcepack'); }
  if (name === 'shaders') { loadShaders(); searchContent('shader'); }
}

function showMain(profile) {
  viewLogin.classList.add('hidden');
  viewMain.classList.remove('hidden');
  $('profile-name').textContent = profile.name;
  $('skin-variant').value = String(profile.skinVariant || 'CLASSIC').toLowerCase() === 'slim' ? 'slim' : 'classic';
  $('skin-variant').disabled = profile.type !== 'msa';
  document.querySelector('.skin-variant-label').textContent = profile.type === 'msa' ? 'Model' : 'Model (UUID ile sabit)';
  const accountStatus = $('account-status');
  accountStatus.textContent = profile.type === 'msa'
    ? 'Microsoft hesabı • Lisans doğrulanıyor'
    : 'Yerel profil • Tek oyunculu / çevrimdışı oyun';
  accountStatus.classList.toggle('account-status-offline', profile.type !== 'msa');
  $('btn-account').textContent = profile.type === 'msa' ? 'Hesap bağlı' : 'Microsoft hesabını bağla';
  $('btn-account').disabled = profile.type === 'msa';
  loadSkin();
}

async function loadSkin() {
  const skinPath = await api.getSkin();
  if (skinPath) {
    $('skin-avatar').src = /^(https?:|data:|file:)/i.test(skinPath)
      ? skinPath
      : `file://${skinPath.replace(/\\/g, '/')}`;
  } else {
    $('skin-avatar').removeAttribute('src');
  }
}

async function loadProfile() {
  const profile = await api.getProfile();
  if (profile) {
    showMain(profile);
  } else {
    viewLogin.classList.remove('hidden');
    viewMain.classList.add('hidden');
  }
}

btnLogin.onclick = async () => {
  const username = usernameInput.value.trim();
  loginStatus.textContent = '';

  if (!username) {
    loginStatus.textContent = 'Kullanıcı adını gir.';
    usernameInput.focus();
    return;
  }

  btnLogin.disabled = true;
  btnLogin.textContent = 'KAYDEDİLİYOR...';

  const result = await api.saveProfile(username);

  if (!result.ok) {
    loginStatus.textContent = result.error;
    btnLogin.disabled = false;
    btnLogin.textContent = 'DEVAM ET';
    return;
  }

  btnLogin.disabled = false;
  btnLogin.textContent = 'DEVAM ET';
  showMain(result.profile);
};

usernameInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') btnLogin.click();
});

$('btn-logout').onclick = async () => {
  await api.logout();
  location.reload();
};

$('btn-skin').onclick = async () => {
  const result = await api.chooseSkin({ ...getSelectedInstanceOptions(), variant: $('skin-variant').value });
  if (result.ok) {
    await loadSkin();
    $('account-status').textContent = 'Skin kaydedildi. Oyun açılırken launcher tarafından uygulanacak; mod gerekmez.';
  }
  else $('account-status').textContent = result.error || 'Skin yüklenemedi.';
};

async function connectMicrosoft(button, statusElement) {
  let connected = false;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'MICROSOFT AÇILIYOR...';
  statusElement.textContent = 'Güvenli Microsoft giriş penceresinde hesabını doğrula.';
  try {
    const result = await api.loginMicrosoft();
    if (!result.ok) {
      statusElement.textContent = result.error || 'Microsoft girişi tamamlanamadı.';
      return;
    }
    showMain(result.profile);
    connected = true;
    $('account-status').textContent = 'Microsoft hesabı bağlı • Minecraft Java lisansı doğrulandı';
    $('account-status').classList.remove('account-status-offline');
    if (statusElement.id === 'account-status-login') statusElement.textContent = '';
  } catch (error) {
    statusElement.textContent = error.message || 'Microsoft girişi tamamlanamadı.';
  } finally {
    button.disabled = button.id === 'btn-account' && connected;
    button.textContent = button.id === 'btn-account' && connected ? 'Hesap bağlı' : label;
  }
}

$('btn-login-microsoft').onclick = () => connectMicrosoft($('btn-login-microsoft'), $('account-status-login'));
$('btn-account').onclick = () => connectMicrosoft($('btn-account'), $('account-status'));
api.onAuthStatus(message => {
  const status = viewMain.classList.contains('hidden') ? $('account-status-login') : $('account-status');
  status.textContent = message || 'Microsoft hesabı doğrulanıyor...';
});

async function loadSettings() {
  const settings = await api.getSettings();

  $('ram-min').value = settings.ramMin;
  $('ram-max').value = settings.ramMax;
  $('ram-min-val').textContent = settings.ramMin;
  $('ram-max-val').textContent = settings.ramMax;
  $('java-path').value = settings.javaPath || '';
  $('auto-server-enabled').checked = Boolean(settings.autoServerEnabled);
  $('auto-server-address').value = settings.autoServerAddress || '';
  $('curseforge-api-key').value = '';
  $('curseforge-api-key').dataset.clear = 'false';
  $('curseforge-key-status').textContent = settings.curseForgeConfigured
    ? 'CurseForge anahtarı bu cihazda şifreli kayıtlı.'
    : 'Modrinth anahtarsız çalışır. CurseForge için geliştirici panelinden API anahtarı ekle.';
}

// ---------- Launcher Theme System ----------

const LAUNCHER_THEMES = [
  {
    id: 'night',
    name: 'Gece',
    description: 'Minecraft gece manzarası',
    file: 'night.jpg'
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Nostaljik Minecraft görünümü',
    file: 'Classic.jpg'
  },
  {
    id: 'snowy1',
    name: 'Karlı Dağlar',
    description: 'Karlı Minecraft manzarası',
    file: 'snowy-mountains.jpg'
  },
  {
    id: 'snowy2',
    name: 'Karlı Dağlar 2',
    description: 'Alternatif kış manzarası',
    file: 'snowy-mountains2.jpg'
  },
  {
    id: 'snowy3',
    name: 'Karlı Dağlar 3',
    description: 'Alternatif kış manzarası',
    file: 'snowy-mountains3.jpg'
  },
  {
    id: 'cherry1',
    name: 'Kiraz Korusu',
    description: 'Cherry Grove',
    file: 'cherry-grove.jpg'
  },
  {
    id: 'cherry2',
    name: 'Kiraz Korusu 2',
    description: 'Alternatif Cherry Grove',
    file: 'cherry-grove2.jpg'
  }
];

function getThemeImageUrl(file) {
  return new URL(`./assets/backgrounds/${file}`, document.baseURI).href;
}

function applyLauncherTheme(themeId, save = true) {
  const theme = LAUNCHER_THEMES.find(item => item.id === themeId)
    || LAUNCHER_THEMES[0];

  const imageUrl = getThemeImageUrl(theme.file);

  viewMain.style.backgroundImage = `
    linear-gradient(
      rgba(8, 13, 10, .55),
      rgba(8, 13, 10, .65)
    ),
    url("${imageUrl}")
  `;

  document.querySelectorAll('.theme-card').forEach(card => {
    const selected = card.dataset.themeId === theme.id;

    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });

  if (save) {
    localStorage.setItem('darkysLauncherTheme', theme.id);
  }

  const status = $('theme-selected-status');

  if (status) {
    status.textContent = `${theme.name} teması seçildi ✓`;
  }
}

function renderThemeCards() {
  const container = $('theme-grid');
  container.innerHTML = '';

  for (const theme of LAUNCHER_THEMES) {
    const card = document.createElement('button');

    card.type = 'button';
    card.className = 'theme-card';
    card.dataset.themeId = theme.id;

    const preview = document.createElement('div');
    preview.className = 'theme-preview';

    const image = document.createElement('img');
    image.src = getThemeImageUrl(theme.file);
    image.alt = theme.name;
    image.draggable = false;

    image.onerror = () => {
      preview.classList.add('theme-preview-missing');
      preview.textContent = 'Görsel yüklenemedi';
    };

    preview.appendChild(image);

    const info = document.createElement('div');
    info.className = 'theme-card-info';

    const title = document.createElement('strong');
    title.className = 'theme-card-title';
    title.textContent = theme.name;

    const description = document.createElement('small');
    description.className = 'theme-card-description';
    description.textContent = theme.description;

    info.append(title, description);
    card.append(preview, info);

    card.onclick = () => applyLauncherTheme(theme.id);

    container.appendChild(card);
  }
}

function initLauncherThemes() {
  renderThemeCards();

  const savedTheme = localStorage.getItem('darkysLauncherTheme');

  const validTheme = LAUNCHER_THEMES.some(theme => theme.id === savedTheme)
    ? savedTheme
    : LAUNCHER_THEMES[0].id;

  applyLauncherTheme(validTheme, true);
}

$('ram-min').oninput = function () {
  $('ram-min-val').textContent = this.value;
  if (Number($('ram-max').value) < Number(this.value)) {
    $('ram-max').value = this.value;
    $('ram-max-val').textContent = this.value;
  }
};

$('ram-max').oninput = function () {
  if (Number(this.value) < Number($('ram-min').value)) {
    this.value = $('ram-min').value;
  }
  $('ram-max-val').textContent = this.value;
};

$('btn-save-settings').onclick = async () => {
  const settings = await api.saveSettings({
    ramMin: Number($('ram-min').value),
    ramMax: Number($('ram-max').value),
    javaPath: $('java-path').value.trim(),
    autoServerEnabled: $('auto-server-enabled').checked,
    autoServerAddress: $('auto-server-address').value.trim(),
    curseForgeApiKey: $('curseforge-api-key').value.trim(),
    clearCurseForgeApiKey: $('curseforge-api-key').dataset.clear === 'true'
  });

  $('ram-min').value = settings.ramMin;
  $('ram-max').value = settings.ramMax;
  $('ram-min-val').textContent = settings.ramMin;
  $('ram-max-val').textContent = settings.ramMax;
  $('settings-saved').textContent = 'Kaydedildi ✓';
  $('curseforge-api-key').value = '';
  $('curseforge-api-key').dataset.clear = 'false';
  $('curseforge-key-status').textContent = settings.error || (settings.curseForgeConfigured
    ? 'CurseForge anahtarı bu cihazda şifreli kayıtlı.'
    : 'CurseForge anahtarı kayıtlı değil; Modrinth kullanılabilir.');
  if (settings.error) $('settings-saved').textContent = settings.error;
  setTimeout(() => { $('settings-saved').textContent = ''; }, 2000);
};

$('curseforge-api-key').oninput = () => { $('curseforge-api-key').dataset.clear = 'false'; };
$('btn-test-curseforge').onclick = async () => {
  const button = $('btn-test-curseforge');
  const status = $('curseforge-test-status');
  button.disabled = true;
  button.textContent = 'TEST EDİLİYOR...';
  status.textContent = 'CurseForge API bağlantısı deneniyor...';
  try {
    const result = await api.testCurseForgeApi($('curseforge-api-key').value.trim());
    status.textContent = result.ok ? `Bağlantı doğrulandı • ${result.gameName || 'Minecraft'} API erişimi açık.` : result.error;
    status.style.color = result.ok ? '#72d58e' : '#ff7676';
  } catch (error) {
    status.textContent = error.message || 'CurseForge API testi başarısız.';
    status.style.color = '#ff7676';
  } finally {
    button.disabled = false;
    button.textContent = 'API ANAHTARINI TEST ET';
  }
};
$('btn-clear-curseforge-key').onclick = () => {
  $('curseforge-api-key').value = '';
  $('curseforge-api-key').dataset.clear = 'true';
  $('btn-save-settings').click();
};

async function loadVersions() {
  if (versionsRefreshBusy) return;
  versionsRefreshBusy = true;
  const refreshButton = $('btn-refresh-versions');
  if (refreshButton) refreshButton.disabled = true;
  const previousSelection = versionSelect.value || localStorage.getItem('selectedVersion');
  if (!versions.length) {
    versionSelect.innerHTML = '<option>Yükleniyor...</option>';
    versionSelect.disabled = true;
  }
  try {
    const result = await api.getVersions();
    if (!result.ok) throw new Error(result.error || 'Sürümler alınamadı.');

    versions = result.versions || [];
    versionSelect.innerHTML = '';

    for (const version of versions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.dataset.type = version.type;
      option.textContent = `${version.id}${version.type !== 'release' ? ` (${version.type})` : ''}`;
      versionSelect.appendChild(option);
    }

    versionSelect.disabled = versions.length === 0;
    if (previousSelection && versions.some(v => v.id === previousSelection)) {
      versionSelect.value = previousSelection;
    } else if (result.latest?.release && versions.some(v => v.id === result.latest.release)) {
      versionSelect.value = result.latest.release;
    }

    $('version-update-status').textContent = result.offline
      ? 'Çevrimdışı • Önbellekteki sürüm listesi kullanılıyor'
      : `Güncel • Son resmi sürüm ${result.latest?.release || 'bilinmiyor'}`;
    updateSelectedVersion();
  } catch (error) {
    if (!versions.length) {
      versionSelect.innerHTML = '<option>Sürümler alınamadı</option>';
      progressText.textContent = error.message;
    } else {
      versionSelect.innerHTML = '';
      for (const version of versions) {
        const option = document.createElement('option');
        option.value = version.id;
        option.dataset.type = version.type;
        option.textContent = `${version.id}${version.type !== 'release' ? ` (${version.type})` : ''}`;
        versionSelect.appendChild(option);
      }
      if (previousSelection && versions.some(v => v.id === previousSelection)) versionSelect.value = previousSelection;
    }
    $('version-update-status').textContent = versions.length ? `Çevrimdışı • Son liste korunuyor` : error.message;
  } finally {
    const packVersion = $('modpack-game-version');
    if (packVersion) {
      const previousPackVersion = packVersion.value;
      packVersion.innerHTML = '';
      for (const version of versions) {
        const option = document.createElement('option');
        option.value = version.id;
        option.textContent = `${version.id}${version.type !== 'release' ? ` (${version.type})` : ''}`;
        packVersion.appendChild(option);
      }
      if (versions.some(version => version.id === previousPackVersion)) packVersion.value = previousPackVersion;
      else if (versionSelect.value) packVersion.value = versionSelect.value;
      else if (versions.length) packVersion.value = versions[0].id;
    }
    versionSelect.disabled = versions.length === 0;
    versionsRefreshBusy = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

$('btn-refresh-versions').onclick = loadVersions;
// Mojang'ın resmi manifestini uygulama açıkken 6 saatte bir yenile.
setInterval(loadVersions, 6 * 60 * 60 * 1000);

function updateSelectedVersion() {
  const selected = versions.find(v => v.id === versionSelect.value);
  const text = selected ? selected.id : '-';
  $('selected-version-label').textContent = text;
  $('mods-version-label').textContent = text;
  if (selected) localStorage.setItem('selectedVersion', selected.id);
  if ($('tab-mods').classList.contains('active')) loadInstalledMods();
}

function applyActiveModpack(pack) {
  activeModpackId = pack?.id || null;
  $('active-modpack-select').value = activeModpackId || '';
  $('btn-play').disabled = !pack;
  if (!pack) {
    $('active-modpack-select').innerHTML = '<option value="">Önce Modpack Oluştur</option>';
    $('selected-version-label').textContent = 'Henüz modpack yok';
    $('loader-status').textContent = 'Modlar bölümünden Minecraft sürümü ve loader seçerek modpack oluştur.';
    $('modpack-active-badge').textContent = 'AKTİF MODPACK: YOK';
    return;
  }
  versionSelect.value = pack.gameVersion;
  $('mod-loader').value = pack.loader;
  $('selected-version-label').textContent = `${pack.name} • Minecraft ${pack.gameVersion} • ${pack.loader} ${pack.loaderVersion}`;
  $('mods-version-label').textContent = `${pack.gameVersion} • ${pack.loader} ${pack.loaderVersion}`;
  $('loader-status').textContent = `Aktif profil: ${pack.name} • modları bu modpack'e kurulacak.`;
  $('modpack-active-badge').textContent = `AKTİF MODPACK: ${pack.name.toLocaleUpperCase('tr-TR')}`;
  if ($('tab-mods').classList.contains('active')) loadInstalledMods();
}

async function loadModpacks() {
  const result = await api.listModpacks();
  if (!result.ok) return;
  modpacks = result.modpacks || [];
  activeModpackId = result.activeId;
  const homeSelect = $('active-modpack-select');
  homeSelect.innerHTML = '';
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = modpacks.length ? 'Modpack seç' : 'Önce Modpack Oluştur';
  homeSelect.appendChild(emptyOption);
  const list = $('modpack-list');
  list.innerHTML = '';
  for (const pack of modpacks) {
    const option = document.createElement('option');
    option.value = pack.id;
    option.textContent = `${pack.name} • ${pack.gameVersion} • ${pack.loader} ${pack.loaderVersion}`;
    homeSelect.appendChild(option);
    const row = document.createElement('div');
    row.className = `modpack-row${pack.id === activeModpackId ? ' active' : ''}`;
    const details = document.createElement('div');
    details.className = 'modpack-details';
    const title = document.createElement('strong');
    title.textContent = pack.name;
    const summary = document.createElement('span');
    summary.textContent = `Minecraft ${pack.gameVersion} · ${pack.loader} ${pack.loaderVersion}`;
    details.append(title, summary);
    const actions = document.createElement('div');
    actions.className = 'modpack-actions';
    const select = document.createElement('button');
    select.className = 'btn-secondary small';
    select.textContent = pack.id === activeModpackId ? 'AKTİF' : 'SEÇ';
    select.disabled = pack.id === activeModpackId;
    select.onclick = () => setActiveModpack(pack.id);
    const exportPack = document.createElement('button');
    exportPack.className = 'btn-secondary small';
    exportPack.textContent = 'DIŞA AKTAR';
    exportPack.onclick = async () => {
      exportPack.disabled = true;
      const result = await api.exportModpack(pack.id);
      exportPack.disabled = false;
      if (result.canceled) return;
      setModpackStatus(result.ok ? `${pack.name} modpack’i dışa aktarıldı.` : result.error, !result.ok);
    };
    const exportMrpack = document.createElement('button');
    exportMrpack.className = 'btn-secondary small';
    exportMrpack.textContent = 'MRPACK';
    exportMrpack.title = 'Modrinth modpack formatında dışa aktar';
    exportMrpack.onclick = async () => {
      exportMrpack.disabled = true;
      const result = await api.exportMrpack(pack.id);
      exportMrpack.disabled = false;
      if (result.canceled) return;
      setModpackStatus(result.ok ? `${pack.name} Modrinth .mrpack olarak dışa aktarıldı.` : result.error, !result.ok);
    };
    const remove = document.createElement('button');
    remove.className = 'mod-remove-btn';
    remove.textContent = 'LİSTEDEN KALDIR';
    remove.onclick = async () => {
      const deleted = await api.deleteModpack(pack.id);
      if (deleted.ok) await loadModpacks();
      else setModpackStatus(deleted.error, true);
    };
    actions.append(select, exportPack, exportMrpack, remove);
    row.append(details, actions);
    list.appendChild(row);
  }
  const active = modpacks.find(pack => pack.id === activeModpackId) || null;
  applyActiveModpack(active);
}

function setModpackStatus(message, isError = false) {
  $('modpack-status').textContent = message || '';
  $('modpack-status').style.color = isError ? '#ff7676' : '';
}

async function setActiveModpack(id) {
  if (!id) { applyActiveModpack(null); return; }
  const result = await api.selectModpack(id);
  if (!result.ok) { setModpackStatus(result.error, true); return; }
  await loadModpacks();
  modSearchResults = [];
  renderModResults();
  setModpackStatus(`${result.modpack.name} aktif edildi. Modlar bu profile kurulacak.`);
}

async function refreshLoaderVersions() {
  const gameVersion = $('modpack-game-version').value;
  const loader = $('modpack-loader').value;
  const select = $('modpack-loader-version');
  select.innerHTML = '<option value="">Yükleniyor...</option>';
  const result = await api.getLoaderVersions({ gameVersion, loader });
  select.innerHTML = '';
  if (!result.ok || !result.versions?.length) {
    select.innerHTML = '<option value="">Bu sürümde loader yok</option>';
    setModpackStatus(result.error || `${loader} için bu Minecraft sürümünde sürüm bulunamadı.`, true);
    return;
  }
  for (const version of result.versions) {
    const option = document.createElement('option');
    option.value = version.id;
    option.textContent = `${version.id}${version.stable ? ' • önerilen' : ''}`;
    select.appendChild(option);
  }
  setModpackStatus(`${result.versions.length} ${loader} sürümü bulundu.`);
}

$('modpack-game-version').onchange = refreshLoaderVersions;
$('modpack-loader').onchange = refreshLoaderVersions;
$('active-modpack-select').onchange = event => setActiveModpack(event.target.value);
$('btn-create-modpack').onclick = async () => {
  const button = $('btn-create-modpack');
  button.disabled = true;
  const result = await api.createModpack({
    name: $('modpack-name').value,
    gameVersion: $('modpack-game-version').value,
    loader: $('modpack-loader').value,
    loaderVersion: $('modpack-loader-version').value
  });
  button.disabled = false;
  if (!result.ok) { setModpackStatus(result.error, true); return; }
  $('modpack-name').value = '';
  setModpackStatus(`${result.modpack.name} oluşturuldu ve aktif edildi.`);
  await loadModpacks();
  switchTab('mods');
  loadInstalledMods();
};

$('btn-import-modpack').onclick = async () => {
  const button = $('btn-import-modpack');
  button.disabled = true;
  button.textContent = 'İÇE AKTARILIYOR...';
  try {
    const result = await api.importModpack();
    if (result.canceled) return;
    if (!result.ok) { setModpackStatus(result.error, true); return; }
    await loadModpacks();
    const manualWarning = result.manualFiles ? ` • ${result.manualFiles} dosya Modrinth’ten elle indirilmeli` : '';
    setModpackStatus(`${result.modpack.name} içe aktarıldı • ${result.importedFiles} dosya${manualWarning} • aktif modpack olarak seçildi.`, Boolean(result.manualFiles));
    loadInstalledMods();
  } catch (error) {
    setModpackStatus(`Modpack içe aktarılamadı: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'MODPACK İÇE AKTAR';
  }
};
versionSelect.onchange = updateSelectedVersion;
btnPlay.disabled = true;

versionSelect.onchange = updateSelectedVersion;

btnPlay.onclick = async () => {
  const selected = versions.find(v => v.id === versionSelect.value);
  if (!selected || !activeModpackId) return;

  btnPlay.disabled = true;
  btnPlay.textContent = 'BAŞLATILIYOR...';
  progressWrap.classList.remove('hidden');
  logBox.classList.remove('hidden');
  logBox.textContent = '';
  progressBar.style.width = '0%';
  progressText.textContent = `${selected.id} hazırlanıyor...`;

  const loader = $('mod-loader').value;
  const loaderName = loader === 'vanilla' ? 'Vanilla' : loader[0].toUpperCase() + loader.slice(1);
  $('loader-status').textContent = `${loaderName} profili hazırlanıyor...`;
  try {
    const result = await api.launchGame(selected.id, selected.type, loader);
    if (!result.ok) {
      progressText.textContent = `Hata: ${result.error}`;
      $('loader-status').textContent = result.error;
      btnPlay.disabled = false;
      btnPlay.textContent = 'OYNA';
    } else {
      $('loader-status').textContent = `${loaderName} hazır • ${selected.id}`;
    }
  } catch (error) {
    progressText.textContent = `Hata: ${error.message}`;
    $('loader-status').textContent = error.message;
    btnPlay.disabled = false;
    btnPlay.textContent = 'OYNA';
  }
};

function formatDownloads(value) {
  const number = Number(value || 0);
  if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

function getSelectedModContext() {
  const selected = versions.find(v => v.id === versionSelect.value);
  return {
    gameVersion: selected?.id || '',
    loader: $('mod-loader').value
  };
}

function setModsStatus(message, isError = false) {
  const status = $('mods-status');
  status.textContent = message || '';
  status.style.color = isError ? '#ff7676' : '';
}

function renderModResults() {
  const container = $('mods-results');
  container.innerHTML = '';

  if (!modSearchResults.length) {
    container.innerHTML = '<div class="empty-mods">Bu filtrelerle mod bulunamadı.</div>';
    return;
  }

  for (const mod of modSearchResults) {
    const card = document.createElement('article');
    card.className = 'mod-card';

    const icon = document.createElement('img');
    icon.className = 'mod-icon';
    icon.src = mod.iconUrl || '';
    icon.alt = '';
    icon.onerror = () => { icon.style.visibility = 'hidden'; };

    const body = document.createElement('div');
    body.className = 'mod-card-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'mod-title-row';

    const title = document.createElement('h3');
    title.className = 'mod-title';
    title.textContent = mod.title;

    const downloads = document.createElement('span');
    downloads.className = 'mod-downloads';
    downloads.textContent = `${formatDownloads(mod.downloads)} indirme`;

    titleRow.append(title, downloads);

    const description = document.createElement('p');
    description.className = 'mod-description';
    description.textContent = mod.description || 'Açıklama yok.';

    const footer = document.createElement('div');
    footer.className = 'mod-card-footer';

    const author = document.createElement('span');
    author.className = 'mod-author';
    author.textContent = `by ${mod.author || 'Bilinmiyor'}`;

    const install = document.createElement('button');
    install.className = 'mod-install-btn';
    install.textContent = 'KUR';
    install.onclick = () => installMod(mod, install);

    footer.append(author, install);
    body.append(titleRow, description, footer);
    card.append(icon, body);
    container.appendChild(card);
  }
}

async function searchMods() {
  if (modSearchBusy) return;

  const { gameVersion, loader } = getSelectedModContext();
  if (!gameVersion) {
    setModsStatus('Önce Minecraft sürümü seç.', true);
    return;
  }

  modSearchBusy = true;
  const source = $('mod-source').value;
  $('btn-mod-search').disabled = true;
  $('btn-mod-search').textContent = 'ARANIYOR...';
  setModsStatus(`${source === 'curseforge' ? 'CurseForge' : 'Modrinth'} aranıyor...`);

  try {
    const result = await api.searchMods({
      query: $('mod-search').value.trim(),
      gameVersion,
      loader,
      source,
      index: $('mod-sort').value
    });

    if (!result.ok) {
      modSearchResults = [];
      renderModResults();
      $('mods-result-count').textContent = 'Hata';
      setModsStatus(result.error, true);
      return;
    }

    modSearchResults = result.hits || [];
    $('mods-result-count').textContent = `${result.total || modSearchResults.length} sonuç`;
    setModsStatus(modSearchResults.length ? `${gameVersion} / ${loader} için ${source === 'curseforge' ? 'CurseForge' : 'Modrinth'} sonuçları` : 'Sonuç bulunamadı.');
    renderModResults();
  } catch (err) {
    setModsStatus(`Hata: ${err.message}`, true);
  } finally {
    modSearchBusy = false;
    $('btn-mod-search').disabled = false;
    $('btn-mod-search').textContent = 'ARA';
  }
}

async function installMod(mod, button) {
  const { gameVersion, loader } = getSelectedModContext();
  if (!gameVersion) return;
  const source = mod.provider || $('mod-source').value;

  button.disabled = true;
  button.textContent = '...';
  setModsStatus(`${mod.title} için uygun sürüm bulunuyor...`);

  try {
    const versionsResult = await api.getModVersions({
      projectId: mod.projectId,
      gameVersion,
      loader,
      source
    });

    if (!versionsResult.ok || !versionsResult.versions?.length) {
      setModsStatus(versionsResult.error || 'Bu mod için uygun sürüm bulunamadı.', true);
      return;
    }

    const selectedVersion = versionsResult.versions.find(v => v.versionType === 'release') || versionsResult.versions[0];
    const result = await api.installMod({
      projectId: mod.projectId,
      gameVersion,
      loader,
      source,
      versionId: selectedVersion.id
    });

    if (!result.ok) {
      setModsStatus(result.error, true);
      return;
    }

    const dependencyText = result.dependencies?.length
      ? ` + ${result.dependencies.length} bağımlılık`
      : '';
    setModsStatus(`${mod.title} kuruldu ✓${dependencyText}`);
    await loadInstalledMods();
  } catch (err) {
    setModsStatus(`Kurulum hatası: ${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'KUR';
  }
}

async function loadInstalledMods() {
  const { gameVersion, loader } = getSelectedModContext();
  const container = $('installed-mods');
  container.innerHTML = '';

  if (!gameVersion) return;

  const result = await api.listMods({ gameVersion, loader });
  if (!result.ok || !result.mods?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-mods';
    empty.textContent = 'Bu sürüm/loader için henüz kurulu mod yok.';
    container.appendChild(empty);
    return;
  }

  for (const mod of result.mods) {
    const row = document.createElement('div');
    row.className = 'installed-mod';

    const name = document.createElement('span');
    name.className = 'installed-mod-name';
    name.textContent = mod.filename;

    const remove = document.createElement('button');
    remove.className = 'mod-remove-btn';
    remove.textContent = 'KALDIR';
    remove.onclick = async () => {
      remove.disabled = true;
      const removed = await api.removeMod({ gameVersion, loader, filename: mod.filename });
      if (removed.ok) {
        await loadInstalledMods();
        setModsStatus(`${mod.filename} kaldırıldı.`);
      } else {
        remove.disabled = false;
        setModsStatus(removed.error, true);
      }
    };

    row.append(name, remove);
    container.appendChild(row);
  }
}

$('btn-mod-search').onclick = searchMods;
$('mod-source').onchange = () => {
  modSearchResults = [];
  renderModResults();
  $('mods-result-count').textContent = 'Hazır';
  $('mod-source-note').textContent = $('mod-source').value === 'curseforge'
    ? 'CurseForge resmi API anahtarı gerektirir; anahtar Ayarlar’da Windows’un şifreli kasasında tutulur.'
    : 'Modlar aktif modpack’e yüklenir. Modrinth için API anahtarı gerekmez.';
};
$('mod-search').addEventListener('keydown', event => {
  if (event.key === 'Enter') searchMods();
});
  $('mod-loader').onchange = () => {
  localStorage.setItem('selectedLoader', $('mod-loader').value);
  modSearchResults = [];
  renderModResults();
  loadInstalledMods();
  if ($('tab-mods').classList.contains('active') && $('mod-search').value.trim()) searchMods();
};
$('mod-loader').value = localStorage.getItem('selectedLoader') || 'fabric';
$('mod-sort').onchange = () => {
  if ($('mod-search').value.trim() || $('tab-mods').classList.contains('active')) searchMods();
};

function renderContentResults(type, hits) {
  const container = $(type === 'shader' ? 'shaders-results' : 'resourcepacks-results');
  container.innerHTML = '';
  if (!hits?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-mods';
    empty.textContent = 'Bu sürüm için sonuç bulunamadı.';
    container.appendChild(empty);
    return;
  }
  for (const item of hits) {
    const card = document.createElement('article');
    card.className = 'mod-card';
    const body = document.createElement('div');
    body.className = 'mod-card-body';
    const titleRow = document.createElement('div');
    titleRow.className = 'mod-title-row';
    const title = document.createElement('h3');
    title.className = 'mod-title';
    title.textContent = item.title;
    const downloads = document.createElement('span');
    downloads.className = 'mod-downloads';
    downloads.textContent = `${formatDownloads(item.downloads)} indirme`;
    titleRow.append(title, downloads);
    const description = document.createElement('p');
    description.className = 'mod-description';
    description.textContent = item.description || 'Açıklama yok.';
    const footer = document.createElement('div');
    footer.className = 'mod-card-footer';
    const author = document.createElement('span');
    author.className = 'mod-author';
    author.textContent = `by ${item.author || 'Bilinmiyor'}`;
    const install = document.createElement('button');
    install.className = 'mod-install-btn';
    install.textContent = 'KUR';
    install.onclick = () => installContent(type, item, install);
    footer.append(author, install);
    body.append(titleRow, description, footer);
    card.appendChild(body);
    container.appendChild(card);
  }
}

async function searchContent(type) {
  const inputId = type === 'shader' ? 'shader-search' : 'resourcepack-search';
  const statusId = type === 'shader' ? 'shaders-status' : 'resourcepacks-status';
  const buttonId = type === 'shader' ? 'btn-search-shaders' : 'btn-search-resourcepacks';
  const { gameVersion } = getSelectedModContext();
  if (!gameVersion) return setPackStatus(statusId, 'Önce Minecraft sürümü seç.', true);
  const button = $(buttonId);
  button.disabled = true;
  button.textContent = 'ARANIYOR...';
  setPackStatus(statusId, 'Modrinth kataloğu aranıyor...');
  try {
    const result = await api.searchContent({ type, gameVersion, query: $(inputId).value.trim(), index: $('mod-sort').value });
    if (!result.ok) throw new Error(result.error || 'Arama başarısız.');
    renderContentResults(type, result.hits);
    setPackStatus(statusId, `${result.total || result.hits.length} sonuç • Minecraft ${gameVersion}`);
  } catch (error) {
    setPackStatus(statusId, error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'ARA';
  }
}

async function installContent(type, item, button) {
  const statusId = type === 'shader' ? 'shaders-status' : 'resourcepacks-status';
  button.disabled = true;
  button.textContent = 'İNDİRİLİYOR...';
  try {
    const { gameVersion } = getSelectedModContext();
    const result = await api.installContent({ type, projectId: item.projectId, gameVersion, loader: $('mod-loader').value });
    if (!result.ok) throw new Error(result.error || 'Kurulum başarısız.');
    setPackStatus(statusId, `${result.filename} kuruldu ✓ (${result.version})`);
    if (type === 'shader') await loadShaders();
    else await loadResourcePacks();
  } catch (error) {
    setPackStatus(statusId, error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'KUR';
  }
}

$('btn-search-resourcepacks').onclick = () => searchContent('resourcepack');
$('resourcepack-search').addEventListener('keydown', event => { if (event.key === 'Enter') searchContent('resourcepack'); });
$('btn-search-shaders').onclick = () => searchContent('shader');
$('shader-search').addEventListener('keydown', event => { if (event.key === 'Enter') searchContent('shader'); });
$('btn-refresh-installed').onclick = loadInstalledMods;

function setPackStatus(elementId, message, isError = false) {
  const element = $(elementId);
  element.textContent = message || '';
  element.style.color = isError ? '#ff7676' : '';
}

function renderPackList(containerId, items, emptyText, removeCallback) {
  const container = $(containerId);
  container.innerHTML = '';

  if (!items?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-pack';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'pack-row';

    const name = document.createElement('span');
    name.className = 'pack-name';
    name.textContent = item.filename;

    const remove = document.createElement('button');
    remove.className = 'mod-remove-btn';
    remove.textContent = 'KALDIR';
    remove.onclick = async () => {
      remove.disabled = true;
      const result = await removeCallback(item.filename);
      if (result?.ok) {
        if (containerId === 'resourcepacks-list') {
          setPackStatus('resourcepacks-status', `${item.filename} kaldırıldı.`);
          await loadResourcePacks();
        } else {
          setPackStatus('shaders-status', `${item.filename} kaldırıldı.`);
          await loadShaders();
        }
      } else {
        remove.disabled = false;
        const statusId = containerId === 'resourcepacks-list' ? 'resourcepacks-status' : 'shaders-status';
        setPackStatus(statusId, result?.error || 'Paket kaldırılamadı.', true);
      }
    };

    row.append(name, remove);
    container.appendChild(row);
  }
}

async function loadResourcePacks() {
  const options = getSelectedInstanceOptions();
  const result = await api.listResourcePacks(options);
  if (!result.ok) {
    setPackStatus('resourcepacks-status', result.error || 'Kaynak paketleri okunamadı.', true);
    return;
  }

  renderPackList(
    'resourcepacks-list',
    result.packs,
    'Henüz kurulmuş kaynak paketi yok.',
    filename => api.removeResourcePack(filename, options)
  );
}

async function loadShaders() {
  const options = getSelectedInstanceOptions();
  const result = await api.listShaders(options);
  if (!result.ok) {
    setPackStatus('shaders-status', result.error || 'Shaderlar okunamadı.', true);
    return;
  }

  renderPackList(
    'shaders-list',
    result.shaders,
    'Henüz kurulmuş shader yok.',
    filename => api.removeShader(filename, options)
  );
}

$('btn-install-resourcepack').onclick = async () => {
  const button = $('btn-install-resourcepack');
  button.disabled = true;
  button.textContent = 'KURULUYOR...';
  setPackStatus('resourcepacks-status', 'Kaynak paketi seç...');

  try {
    const result = await api.chooseResourcePack(getSelectedInstanceOptions());
    if (result.ok) {
      setPackStatus('resourcepacks-status', `${result.filename} kuruldu ✓`);
      await loadResourcePacks();
    } else if (!result.canceled) {
      setPackStatus('resourcepacks-status', result.error || 'Kaynak paketi kurulamadı.', true);
    }
  } catch (err) {
    setPackStatus('resourcepacks-status', `Hata: ${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = '+ KAYNAK PAKETİ EKLE';
  }
};

$('btn-install-shader').onclick = async () => {
  const button = $('btn-install-shader');
  button.disabled = true;
  button.textContent = 'KURULUYOR...';
  setPackStatus('shaders-status', 'Shader paketi seç...');

  try {
    const result = await api.chooseShader(getSelectedInstanceOptions());
    if (result.ok) {
      setPackStatus('shaders-status', `${result.filename} kuruldu ✓`);
      await loadShaders();
    } else if (!result.canceled) {
      setPackStatus('shaders-status', result.error || 'Shader kurulamadı.', true);
    }
  } catch (err) {
    setPackStatus('shaders-status', `Hata: ${err.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = '+ SHADER EKLE';
  }
};

api.onLog(message => appendLog(message));

api.onProgress(data => {
  if (!data) return;

  let percentage = 0;
  if (data.total) {
    percentage = Math.min(100, Math.round((data.task / data.total) * 100));
  }

  progressBar.style.width = `${percentage}%`;
  progressText.textContent = `${data.type || 'İndiriliyor'} - %${percentage}`;
});

api.onClosed(() => {
  btnPlay.disabled = false;
  btnPlay.textContent = 'OYNA';
  progressText.textContent = 'Oyun kapatıldı.';
  $('loader-status').textContent = 'Oyundan çıkıldı.';
});

function appendLog(message) {
  logBox.textContent += `${message}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

$('btn-analyze-log').onclick = async () => {
  const button = $('btn-analyze-log');
  const output = $('log-analysis');
  button.disabled = true;
  button.textContent = 'GÜNLÜK ANALİZ EDİLİYOR...';
  output.classList.remove('hidden');
  output.textContent = 'Son oyun günlüğü okunuyor...';
  try {
    const result = await api.analyzeCrashLog();
    output.textContent = `${result.title}\n${result.summary}${result.evidence?.length ? `\n\nBulunan kayıtlar:\n• ${result.evidence.join('\n• ')}` : ''}${result.logPath ? `\n\nGünlük: ${result.logPath}` : ''}`;
  } catch (error) {
    output.textContent = `Günlük analiz edilemedi: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'SON OYUN GÜNLÜĞÜNÜ ANALİZ ET';
  }
};

// =====================================
// DARKYS UI SOUND SYSTEM
// =====================================

let uiAudioContext = null;

function playUiClickSound() {
  const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) return;

  try {
    if (!uiAudioContext) {
      uiAudioContext = new AudioContextClass();
    }

    if (uiAudioContext.state === 'suspended') {
      void uiAudioContext.resume().catch(() => {});
    }

    const oscillator = uiAudioContext.createOscillator();
    const gain = uiAudioContext.createGain();

    const now = uiAudioContext.currentTime;

    oscillator.type = 'sine';

    // Hafif dijital tıklama sesi
    oscillator.frequency.setValueAtTime(1150, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      680,
      now + 0.035
    );

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      0.018,
      now + 0.004
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + 0.045
    );

    oscillator.connect(gain);
    gain.connect(uiAudioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.05);

  } catch (error) {
    // Ses sistemi desteklenmiyorsa launcher çalışmaya devam eder.
  }
}

function initUiEffects() {
  const soundToggle = $('ui-sounds-enabled');

  if (!soundToggle) return;

  const savedSoundSetting = localStorage.getItem('darkysUiSounds');

  soundToggle.checked = savedSoundSetting === null
    ? true
    : savedSoundSetting === 'true';

  soundToggle.addEventListener('change', () => {
    localStorage.setItem(
      'darkysUiSounds',
      String(soundToggle.checked)
    );
  });

  document.addEventListener('click', event => {
    if (!soundToggle.checked) return;

    const target = event.target instanceof Element
      ? event.target
      : null;

    if (!target) return;

    const control = target.closest(
      'button, .theme-card, .nav-item, .switch'
    );

    if (!control || control.disabled) return;

    playUiClickSound();
  }, true);
}

(async function init() {
  initLauncherThemes();
  initUiEffects();
  await loadSettings();
  await loadVersions();
  await loadProfile();
  await loadModpacks();
  if ($('modpack-game-version').options.length) await refreshLoaderVersions();
})();
