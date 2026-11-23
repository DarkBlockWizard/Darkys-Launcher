const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darkys', {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),

  getProfile: () => ipcRenderer.invoke('profile:get'),
  loginMicrosoft: () => ipcRenderer.invoke('profile:loginMicrosoft'),
  saveProfile: (username) => ipcRenderer.invoke('profile:save', username),
  logout: () => ipcRenderer.invoke('profile:logout'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  chooseSkin: (options) => ipcRenderer.invoke('skin:choose', options),
  getSkin: () => ipcRenderer.invoke('skin:get'),

  chooseResourcePack: (options) => ipcRenderer.invoke('resourcepacks:chooseInstall', options),
  listResourcePacks: (options) => ipcRenderer.invoke('resourcepacks:list', options),
  removeResourcePack: (filename, options) => ipcRenderer.invoke('resourcepacks:remove', filename, options),

  chooseShader: (options) => ipcRenderer.invoke('shaders:chooseInstall', options),
  listShaders: (options) => ipcRenderer.invoke('shaders:list', options),
  removeShader: (filename, options) => ipcRenderer.invoke('shaders:remove', filename, options),

  getVersions: () => ipcRenderer.invoke('versions:get'),
  getLoaderVersions: (options) => ipcRenderer.invoke('loaders:versions', options),
  listModpacks: () => ipcRenderer.invoke('modpacks:list'),
  createModpack: (options) => ipcRenderer.invoke('modpacks:create', options),
  selectModpack: (id) => ipcRenderer.invoke('modpacks:select', id),
  deleteModpack: (id) => ipcRenderer.invoke('modpacks:delete', id),
  exportModpack: (id) => ipcRenderer.invoke('modpacks:export', id),
  exportMrpack: (id) => ipcRenderer.invoke('modpacks:exportMrpack', id),
  importModpack: () => ipcRenderer.invoke('modpacks:import'),
  testCurseForgeApi: (key) => ipcRenderer.invoke('curseforge:test', key),
  analyzeCrashLog: () => ipcRenderer.invoke('logs:analyze'),

  searchMods: (options) => ipcRenderer.invoke(options?.source === 'curseforge' ? 'curseforge:search' : 'modrinth:search', options),
  searchContent: (options) => ipcRenderer.invoke('modrinth:contentSearch', options),
  installContent: (options) => ipcRenderer.invoke('modrinth:contentInstall', options),
  getModVersions: (options) => ipcRenderer.invoke(options?.source === 'curseforge' ? 'curseforge:getVersions' : 'modrinth:getVersions', options),
  installMod: (options) => ipcRenderer.invoke(options?.source === 'curseforge' ? 'curseforge:install' : 'modrinth:install', options),
  listMods: (options) => ipcRenderer.invoke('mods:list', options),
  removeMod: (options) => ipcRenderer.invoke('mods:remove', options),
  launchGame: (versionId, versionType, loader) => ipcRenderer.invoke('game:launch', {
    versionId,
    versionType,
    loader
  }),

  onLog: (callback) => ipcRenderer.on('game:log', (_event, message) => callback(message)),
  onProgress: (callback) => ipcRenderer.on('game:progress', (_event, data) => callback(data)),
  onClosed: (callback) => ipcRenderer.on('game:closed', (_event, code) => callback(code)),
  onAuthStatus: (callback) => ipcRenderer.on('auth:status', (_event, message) => callback(message))
});
