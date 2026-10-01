'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { loadAssets, _test } = require('../src/core/assets.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const texturePath = id => `assets/minecraft/textures/block/${id}.png`;
const oneFace = { from: [1, 2, 3], to: [15, 14, 13], faces: { north: { texture: '#side', cullface: 'north', tintindex: 0 }, up: { texture: '#top', uv: [1, 2, 3, 4], rotation: 90 } } };

function createFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, '.minecraft');
  const versionDir = path.join(game, 'versions', 'fixture');
  fs.mkdirSync(versionDir, { recursive: true });
  const jar = path.join(versionDir, 'fixture.jar');
  const entries = {
    'version.json': { id: 'fixture-1' },
    'assets/minecraft/lang/en_us.json': { 'block.minecraft.stone': 'Stone', 'block.minecraft.child': 'Child' },
    'assets/minecraft/lang/zh_cn.json': { 'block.minecraft.child': '测试方块' },
    'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'minecraft:block/stone' } } },
    'assets/minecraft/models/block/stone.json': { textures: { side: 'minecraft:block/stone', top: '#side' }, elements: [oneFace] },
    'assets/minecraft/models/block/base.json': { textures: { side: 'minecraft:block/stone', top: '#side' }, elements: [oneFace] },
    'assets/minecraft/models/block/child.json': { parent: 'minecraft:block/base', textures: { side: 'minecraft:block/child' } },
    'assets/minecraft/blockstates/child.json': { variants: { 'axis=x': { model: 'minecraft:block/stone' }, 'axis=y': { model: 'minecraft:block/child', x: 90, y: 180, uvlock: true } } },
    [texturePath('stone')]: PNG,
    [texturePath('child')]: PNG,
    ...overrides,
  };
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  zip.writeZip(jar);
  return { root, game, jar };
}

test('inherits geometry and texture variables, resolves variants and preserves rotations', t => {
  const { jar } = createFixture(t);
  const assets = loadAssets(jar, [{ Name: 'minecraft:air' }, { Name: 'minecraft:child', Properties: { axis: 'y' } }]);
  assert.equal(assets.source.version, 'fixture-1');
  assert.equal(assets.blocks[0].parts.length, 0);
  const block = assets.blocks[1];
  assert.equal(block.label, '测试方块');
  assert.equal(block.fallback, undefined);
  const part = block.parts[0];
  assert.equal(part.x, 90); assert.equal(part.y, 180); assert.equal(part.uvlock, true);
  const faces = part.elements[0].faces;
  assert.equal(faces.north.texture, 'minecraft:block/child');
  assert.equal(faces.up.texture, 'minecraft:block/child');
  assert.equal(faces.north.tintindex, 0); assert.equal(faces.north.cullface, 'north');
  assert.deepEqual(faces.north.uv, [1, 2, 15, 14]);
  assert.deepEqual(faces.up.uv, [1, 2, 3, 4]); assert.equal(faces.up.rotation, 90);
  assert.equal(assets.textures['minecraft:block/child'], `data:image/png;base64,${PNG.toString('base64')}`);
});

test('multipart AND / OR / pipes combine matching parts and retain empty geometry', t => {
  assert.equal(_test.variantMatches('bottom=false,,distance=0', { bottom: 'false', distance: '0' }), true);
  const { jar } = createFixture(t, {
    'assets/minecraft/blockstates/fence.json': { multipart: [
      { when: { AND: [{ OR: [{ north: 'low|tall' }, { east: 'true' }] }, { waterlogged: 'false' }] }, apply: [{ model: 'minecraft:block/stone', y: 90 }, { model: 'minecraft:block/child' }] },
      { when: { south: 'true' }, apply: { model: 'minecraft:block/child', y: 270 } },
    ] },
  });
  const assets = loadAssets(jar, ['minecraft:fence[north=tall,waterlogged=false,south=true]', 'minecraft:fence[north=none,waterlogged=true]']);
  assert.equal(assets.blocks[0].parts.length, 2);
  assert.deepEqual(assets.blocks[0].parts.map(part => part.y), [90, 270]);
  assert.equal(assets.blocks[1].parts.length, 0);
  assert.equal(assets.blocks[1].fallback, undefined);
});

test('resource pack overrides game textures without changing transparent PNG bytes', t => {
  const { jar, root } = createFixture(t);
  const pack = new AdmZip();
  const override = Buffer.from(PNG); override[override.length - 1] ^= 1;
  pack.addFile(texturePath('stone'), override);
  pack.addFile('assets/minecraft/lang/zh_cn.json', Buffer.from(JSON.stringify({ 'block.minecraft.stone': '覆盖石头' })));
  const packPath = path.join(root, 'pack.zip'); pack.writeZip(packPath);
  const assets = loadAssets(jar, ['minecraft:stone'], { resourcePackPath: packPath });
  assert.equal(assets.textures['minecraft:block/stone'], `data:image/png;base64,${override.toString('base64')}`);
  assert.equal(assets.blocks[0].label, '覆盖石头');
  assert.equal(assets.source.resourcePackPath, packPath);
});

test('reads local indexed Chinese language resources from the selected game root', t => {
  const { jar, game } = createFixture(t);
  const hash = '0123456789abcdef0123456789abcdef01234567';
  fs.mkdirSync(path.join(game, 'assets', 'indexes'), { recursive: true });
  fs.mkdirSync(path.join(game, 'assets', 'objects', '01'), { recursive: true });
  fs.writeFileSync(path.join(game, 'assets', 'indexes', '42.json'), JSON.stringify({ objects: { 'minecraft/lang/zh_cn.json': { hash } } }));
  fs.writeFileSync(path.join(game, 'assets', 'objects', '01', hash), JSON.stringify({ 'block.minecraft.stone': '索引石头' }));
  assert.equal(loadAssets(jar, ['minecraft:stone']).blocks[0].label, '索引石头');
});

test('handles parent cycles, invalid resource paths, and unknown blocks without reading outside archives', t => {
  const { jar } = createFixture(t, {
    'assets/minecraft/models/block/cycle_a.json': { parent: 'minecraft:block/cycle_b' },
    'assets/minecraft/models/block/cycle_b.json': { parent: 'minecraft:block/cycle_a' },
    'assets/minecraft/blockstates/cycle.json': { variants: { '': { model: 'minecraft:block/cycle_a' } } },
  });
  const assets = loadAssets(jar, ['minecraft:cycle', 'example:missing', 'minecraft:../../bad']);
  assert.equal(assets.blocks[0].fallback, true);
  assert.equal(assets.blocks[1].fallback, true);
  assert.equal(assets.blocks[2].parts.length, 0);
  assert(assets.warnings.some(w => w.includes('循环')));
  assert(assets.textures['viewer:missing']);
  for (const invalid of ['../outside', 'a/../outside', '/absolute', 'C:/outside', 'a\\b', 'a\0b']) assert.throws(() => _test.cleanZipPath(invalid));
  for (const invalid of ['minecraft:../outside', 'a:b:c', 'minecraft:/absolute']) assert.throws(() => _test.resourceId(invalid));
});

test('uses explicit local entity textures and fluid textures with truthful fallback warnings', t => {
  const { jar } = createFixture(t, {
    'assets/minecraft/blockstates/chest.json': { variants: { '': { model: 'minecraft:block/chest' } } },
    'assets/minecraft/models/block/chest.json': { textures: { particle: 'minecraft:block/stone' } },
    'assets/minecraft/blockstates/white_shulker_box.json': { variants: { '': { model: 'minecraft:block/empty' } } },
    'assets/minecraft/models/block/empty.json': {},
    'assets/minecraft/textures/entity/chest/normal.png': PNG,
    'assets/minecraft/textures/entity/shulker/shulker_white.png': PNG,
    [texturePath('water_still')]: PNG,
    [texturePath('water_flow')]: PNG,
    [`${texturePath('water_still')}.mcmeta`]: { animation: { frames: [0], frametime: 2 } },
  });
  const assets = loadAssets(jar, ['minecraft:chest[facing=east]', 'minecraft:white_shulker_box[facing=down]', 'minecraft:water[level=3]']);
  assert.equal(assets.blocks[0].parts[0].elements.length, 3);
  assert.equal(assets.blocks[0].parts[0].y, 90);
  assert.equal(assets.blocks[0].parts[0].elements[0].faces.up.texture, 'minecraft:entity/chest/normal');
  assert.equal(assets.blocks[1].parts[0].elements[0].faces.up.texture, 'minecraft:entity/shulker/shulker_white');
  assert.equal(assets.blocks[1].parts[0].x, 180);
  assert.equal(assets.blocks[2].fluid, true);
  assert(assets.blocks[2].parts[0].elements[0].to[1] < 16);
  assert.equal(assets.blocks[2].parts[0].elements[0].faces.north.texture, 'minecraft:block/water_flow');
  assert.equal(assets.textureMeta['minecraft:block/water_still'].animated, true);
  assert(assets.warnings.some(w => w.includes('静态近似模型')));
});

const localJar = process.env.MINECRAFT_JAR;
test('optional local Minecraft client resources cover common technical block models', { skip: !localJar || !fs.existsSync(localJar) }, () => {
  const assets = loadAssets(localJar, [
    'minecraft:quartz_block',
    'minecraft:white_stained_glass_pane[north=true,east=false,south=true,west=false,waterlogged=false]',
    'minecraft:cobblestone_wall[up=true,north=low,east=tall,south=none,west=none,waterlogged=false]',
    'minecraft:hopper[facing=down,enabled=true]',
    'minecraft:chest[facing=north,type=single,waterlogged=false]',
    'minecraft:water[level=0]', 'minecraft:white_shulker_box[facing=up]',
  ]);
  assert.ok(assets.source.version);
  assert.equal(typeof assets.blocks[0].label, 'string');
  assert.ok(assets.blocks[0].label.length > 0);
  assert.equal(assets.blocks[0].fallback, undefined);
  assert.equal(assets.blocks[1].parts.length, 5);
  assert.equal(assets.blocks[2].parts.length, 3);
  assert.equal(assets.blocks[3].fallback, undefined);
  assert.equal(assets.blocks[4].fallback, true);
  assert.equal(assets.blocks[6].fallback, true);
  assert(assets.textureMeta['minecraft:block/water_still'].height > assets.textureMeta['minecraft:block/water_still'].frameHeight);
  assert(!assets.warnings.some(w => w.includes('缺失')));
});
