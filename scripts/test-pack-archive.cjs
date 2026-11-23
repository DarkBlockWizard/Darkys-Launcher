const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const { addPackFolderToZip, validateArchivePath, writeArchiveEntry, parseMrpackManifest } = require('../src/modpack-archive');

test('Darkys pack export/import round trip keeps mods and configuration', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'darkys-pack-test-'));
  try {
    const source = path.join(temporary, 'source');
    fs.mkdirSync(path.join(source, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.writeFileSync(path.join(source, 'mods', 'example.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x44]));
    fs.writeFileSync(path.join(source, 'config', 'example.json'), '{"enabled":true}');
    const zip = new AdmZip();
    zip.addFile('darkys-pack.json', Buffer.from('{"format":"darkys-modpack","formatVersion":1}'));
    addPackFolderToZip(zip, source, 'mods');
    addPackFolderToZip(zip, source, 'config');
    const archive = path.join(temporary, 'roundtrip.darkyspack');
    zip.writeZip(archive);

    const opened = new AdmZip(archive);
    const entries = opened.getEntries();
    assert.equal(entries.length, 3);
    const staging = path.join(temporary, 'imported');
    fs.mkdirSync(staging);
    for (const entry of entries.filter(item => !item.isDirectory && item.entryName !== 'darkys-pack.json')) {
      const relative = validateArchivePath(entry.entryName, ['mods', 'config']);
      assert.ok(relative);
      writeArchiveEntry(staging, relative, entry.getData());
    }
    assert.deepEqual(fs.readFileSync(path.join(staging, 'mods', 'example.jar')), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x44]));
    assert.equal(fs.readFileSync(path.join(staging, 'config', 'example.json'), 'utf8'), '{"enabled":true}');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('archive paths reject traversal, absolute paths, and unrelated folders', () => {
  for (const entry of ['../outside.txt', 'mods/../../outside.jar', 'C:/Windows/file', '/mods/file.jar', 'saves/world/level.dat']) {
    assert.equal(validateArchivePath(entry, ['mods', 'config']), null, entry);
  }
  assert.throws(() => writeArchiveEntry(os.tmpdir(), '../outside.txt', Buffer.from('blocked')));
  assert.equal(validateArchivePath('mods\\safe.jar', ['mods']), 'mods/safe.jar');
});

test('MRPack metadata selects NeoForge and its loader version', () => {
  assert.deepEqual(parseMrpackManifest({
    formatVersion: 1, game: 'minecraft', name: 'Neo pack',
    dependencies: { minecraft: '1.21.1', neoforge: '21.1.172' }
  }), { gameVersion: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.172', name: 'Neo pack' });
  assert.throws(() => parseMrpackManifest({ formatVersion: 1, game: 'minecraft', dependencies: { minecraft: '../bad', forge: '47.2.0' } }));
});

test('MRPack export writes standard index metadata and portable overrides', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'darkys-mrpack-test-'));
  try {
    const source = path.join(temporary, 'source');
    fs.mkdirSync(path.join(source, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.writeFileSync(path.join(source, 'mods', 'example.jar'), 'mod-bytes');
    fs.writeFileSync(path.join(source, 'config', 'example.json'), '{"ok":true}');
    const index = { formatVersion: 1, game: 'minecraft', versionId: 'test-version', name: 'Test pack', files: [], dependencies: { minecraft: '1.20.1', forge: '47.4.28' } };
    const zip = new AdmZip();
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index)));
    addPackFolderToZip(zip, source, 'mods', 'overrides/mods');
    addPackFolderToZip(zip, source, 'config', 'overrides/config');
    const archive = path.join(temporary, 'portable.mrpack');
    zip.writeZip(archive);
    const imported = new AdmZip(archive);
    const parsed = parseMrpackManifest(JSON.parse(imported.readAsText('modrinth.index.json')));
    assert.equal(parsed.loader, 'forge');
    assert.equal(imported.readFile('overrides/mods/example.jar').toString(), 'mod-bytes');
    assert.equal(imported.readFile('overrides/config/example.json').toString(), '{"ok":true}');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
