'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { loadEntityAssets, entityKind, _test } = require('../src/core/entity-assets.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

function fixture(t, entries = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-assets-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jar = path.join(directory, 'game.jar');
  const zip = new AdmZip();
  for (const [name, value] of Object.entries({
    'assets/minecraft/textures/block/birch_planks.png': PNG,
    'assets/minecraft/textures/block/oak_planks.png': PNG,
    'assets/minecraft/textures/block/ice.png': PNG,
    'assets/minecraft/textures/item/diamond_pickaxe.png': PNG,
    'assets/minecraft/items/ice.json': { model: { type: 'minecraft:model', model: 'minecraft:block/ice' } },
    'assets/minecraft/models/block/ice.json': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/ice' } },
    'assets/minecraft/items/diamond_pickaxe.json': { model: { type: 'minecraft:model', model: 'minecraft:item/diamond_pickaxe' } },
    'assets/minecraft/models/item/diamond_pickaxe.json': { parent: 'minecraft:item/handheld', textures: { layer0: 'minecraft:item/diamond_pickaxe' } },
    ...entries,
  })) zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  zip.writeZip(jar);
  return { directory, jar };
}

test('loads item frame backing and modern block/item definitions from the local archive', t => {
  const { jar } = fixture(t);
  const result = loadEntityAssets(jar, [
    { id: 'minecraft:item_frame', nbt: { Item: { id: 'minecraft:ice', Count: 1 } } },
    { id: 'minecraft:glow_item_frame', nbt: { Item: { id: 'minecraft:diamond_pickaxe', count: 1 } } },
  ]);
  assert.equal(result.entities[0].kind, 'item_frame');
  assert.equal(result.entities[0].label, '物品展示框');
  assert.deepEqual(result.entities[0].item, { id: 'minecraft:ice', texture: 'minecraft:block/ice', isBlock: true });
  assert.deepEqual(result.entities[1].item, { id: 'minecraft:diamond_pickaxe', texture: 'minecraft:item/diamond_pickaxe', isBlock: false });
  assert.equal(result.textures['minecraft:block/ice'], `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(result.textureSizes['minecraft:block/ice'], { width: 1, height: 1 });
  assert.ok(result.warnings.some(w => w.includes('静态近似')));
});

test('resource pack overrides the selected local game without extraction', t => {
  const { jar, directory } = fixture(t);
  const otherPNG = Buffer.from(PNG); otherPNG[otherPNG.length - 1] ^= 1;
  const pack = new AdmZip(); pack.addFile('assets/minecraft/textures/item/diamond_pickaxe.png', otherPNG);
  const resourcePackPath = path.join(directory, 'pack.zip'); pack.writeZip(resourcePackPath);
  const result = loadEntityAssets(jar, [{ id: 'minecraft:item', nbt: { Item: { id: 'minecraft:diamond_pickaxe' } } }], { resourcePackPath });
  assert.equal(result.textures['minecraft:item/diamond_pickaxe'], `data:image/png;base64,${otherPNG.toString('base64')}`);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['game.jar', 'pack.zip']);
});

test('known entity families are distinct and unknown mod entities remain explicit placeholders', () => {
  const kinds = ['armor_stand', 'chest_minecart', 'oak_chest_boat', 'bamboo_raft', 'zombie', 'cow', 'chicken', 'creeper', 'item_display', 'block_display', 'text_display'].map(n => entityKind(`minecraft:${n}`));
  assert.deepEqual(kinds, ['armor_stand', 'minecart', 'boat', 'boat', 'humanoid', 'quadruped', 'chicken', 'creeper', 'item_display', 'block_display', 'unknown']);
  assert.equal(entityKind('example:zombie'), 'unknown');
});

test('rejects traversal, external paths, unsafe PNG dimensions and malicious item resources', t => {
  for (const id of ['../secret', 'minecraft:../secret', 'minecraft:/secret', 'https://example.com/image.png', 'minecraft:block\\stone', 'minecraft:foo:bar']) assert.throws(() => _test.resourceId(id));
  for (const value of ['/abs.png', 'C:/secret.png', 'assets/../secret.png', 'assets\\secret.png', 'assets/./secret.png', 'nul\0.png']) assert.throws(() => _test.cleanPath(value));
  const huge = Buffer.from(PNG); huge.writeUInt32BE(8193, 16);
  const { jar } = fixture(t, { 'assets/minecraft/textures/item/unsafe.png': huge });
  const result = loadEntityAssets(jar, [
    { id: 'minecraft:item', nbt: { Item: { id: 'minecraft:../secret' } } },
    { id: 'minecraft:item', nbt: { Item: { id: 'minecraft:unsafe' } } },
  ]);
  assert.ok(result.warnings.some(w => w.includes('无效的实体资源 ID')));
  assert.ok(result.warnings.some(w => w.includes('尺寸超过限制')));
  assert.equal(Object.keys(result.textures).length, 0);
});

test('uses inherited texture references and terminates cyclic model parents', t => {
  const { jar } = fixture(t, {
    'assets/minecraft/items/child.json': { model: { model: 'minecraft:item/child' } },
    'assets/minecraft/models/item/child.json': { parent: 'minecraft:item/base', textures: { layer0: '#front' } },
    'assets/minecraft/models/item/base.json': { parent: 'minecraft:item/child', textures: { front: 'minecraft:item/diamond_pickaxe' } },
  });
  const result = loadEntityAssets(jar, [{ id: 'minecraft:item', nbt: { Item: { id: 'minecraft:child' } } }]);
  assert.equal(result.entities[0].item.texture, 'minecraft:item/diamond_pickaxe');
});

test('unknown entities and missing item textures are reported without losing source array positions', t => {
  const { jar } = fixture(t);
  const result = loadEntityAssets(jar, [{ id: 'mod:custom_mob' }, { id: 'minecraft:item', nbt: { Item: { id: 'minecraft:nonexistent' } } }]);
  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[0].kind, 'unknown');
  assert.equal(result.entities[1].item.texture, null);
  assert.ok(result.warnings.some(w => w.includes('mod:custom_mob') && w.includes('占位')));
  assert.ok(result.warnings.some(w => w.includes('minecraft:nonexistent')));
});
