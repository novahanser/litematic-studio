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

function chainEntries(id, textureId = id) {
  return {
    [`assets/minecraft/blockstates/${id}.json`]: { variants: {
      'axis=x': { model: `minecraft:block/${id}`, x: 90, y: 90 },
      'axis=y': { model: `minecraft:block/${id}` },
      'axis=z': { model: `minecraft:block/${id}`, x: 90 },
    } },
    [`assets/minecraft/models/block/${id}.json`]: { textures: { chain: `minecraft:block/${textureId}` },
      elements: [{ from: [7, 0, 7], to: [9, 16, 9], faces: { north: { texture: '#chain', uv: [0, 0, 2, 16] } } }] },
    [texturePath(id)]: PNG,
  };
}

test('renamed chain resources preserve schematic IDs, properties, orientation and local labels', t => {
  const { jar, game } = createFixture(t, { ...chainEntries('iron_chain'),
    'assets/minecraft/lang/zh_cn.json': { 'block.minecraft.iron_chain': '铁链', 'item.minecraft.iron_chain': '铁链物品' },
  });
  // Isolate translation fallback from any language indexes installed on this PC.
  const hash = '1'.repeat(40);
  fs.mkdirSync(path.join(game, 'assets', 'indexes'), { recursive: true });
  fs.mkdirSync(path.join(game, 'assets', 'objects', '11'), { recursive: true });
  fs.writeFileSync(path.join(game, 'assets', 'indexes', 'fixture.json'), JSON.stringify({ objects: { 'minecraft/lang/zh_cn.json': { hash } } }));
  fs.writeFileSync(path.join(game, 'assets', 'objects', '11', hash), JSON.stringify({ 'block.minecraft.iron_chain': '铁链' }));
  const palette = ['x', 'y', 'z'].map(axis => ({ Name: 'minecraft:chain', Properties: { axis, waterlogged: 'false' } }));
  const unchanged = JSON.stringify(palette);
  const assets = loadAssets(jar, palette);
  assert.equal(JSON.stringify(palette), unchanged, 'resource compatibility must not migrate the editable/exported palette');
  assets.blocks.forEach((block, index) => {
    assert.equal(block.name, 'minecraft:chain');
    assert.deepEqual({ ...block.properties }, palette[index].Properties);
    assert.equal(block.resourceName, 'minecraft:iron_chain');
    assert.equal(block.label, '铁链');
    assert.equal(block.fallback, undefined);
    assert.deepEqual(block.parts[0].elements[0].from, [7, 0, 7]);
    assert.equal(block.parts[0].elements[0].faces.north.texture, 'minecraft:block/iron_chain');
  });
  assert.deepEqual(assets.blocks.map(block => [block.parts[0].x, block.parts[0].y]), [[90, 90], [0, 0], [90, 0]]);
  assert.equal(assets.lang['block.minecraft.chain'], '铁链');
  assert.equal(assets.lang['item.minecraft.chain'], '铁链物品');
  assert.equal(assets.textures['viewer:missing'], undefined);
  assert(assets.warnings.some(w => w.includes('版本改名兼容')));
});

test('resource rename lookup works with older jars and never replaces an existing exact resource', t => {
  const old = createFixture(t, chainEntries('chain'));
  const reverse = loadAssets(old.jar, ['minecraft:iron_chain[axis=z]']).blocks[0];
  assert.equal(reverse.name, 'minecraft:iron_chain');
  assert.equal(reverse.resourceName, 'minecraft:chain');
  assert.equal(reverse.parts[0].elements[0].faces.north.texture, 'minecraft:block/chain');
  const both = createFixture(t, { ...chainEntries('chain'), ...chainEntries('iron_chain'),
    'assets/minecraft/lang/zh_cn.json': { 'block.minecraft.chain': '资源包指定名称', 'block.minecraft.iron_chain': '铁链' },
  });
  const exact = loadAssets(both.jar, ['minecraft:chain[axis=y]']).blocks[0];
  assert.equal(exact.resourceName, undefined);
  assert.equal(exact.parts[0].elements[0].faces.north.texture, 'minecraft:block/chain');
  assert.equal(exact.label, '资源包指定名称');
});

test('legacy resource-pack model and sprite references resolve only known missing renamed IDs', t => {
  const { jar } = createFixture(t, {
    ...chainEntries('iron_chain', 'chain'),
    'assets/minecraft/blockstates/chain.json': { variants: { 'axis=y': { model: 'minecraft:block/chain' } } },
  });
  const assets = loadAssets(jar, ['minecraft:chain[axis=y]', 'example:chain[axis=y]']);
  assert.equal(assets.blocks[0].resourceName, undefined, 'the original blockstate still wins');
  assert.equal(assets.blocks[0].fallback, undefined);
  assert.equal(assets.blocks[0].parts[0].elements[0].faces.north.texture, 'minecraft:block/iron_chain');
  assert.equal(assets.blocks[1].resourceName, undefined, 'mod IDs must not be redirected to vanilla chains');
  assert.equal(assets.blocks[1].fallback, true);
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
  assert.equal(assets.blocks[0].parts[0].elements[1].faces.up.texture, 'minecraft:entity/chest/normal');
  assert.equal(assets.blocks[1].parts[0].elements[0].faces.up.texture, 'minecraft:entity/shulker/shulker_white');
  assert.equal(assets.blocks[1].parts[0].x, 180);
  assert.equal(assets.blocks[2].fluid, true);
  assert(assets.blocks[2].parts[0].elements[0].to[1] < 16);
  assert.equal(assets.blocks[2].parts[0].elements[0].faces.north.texture, 'minecraft:block/water_flow');
  assert.equal(assets.textureMeta['minecraft:block/water_still'].animated, true);
  assert(assets.warnings.some(w => w.includes('静态近似模型')));
});

function specialFixture(t, extra = {}) {
  const resources = { 'assets/minecraft/models/block/empty.json': {},
    'assets/minecraft/textures/entity/chest/normal.png': PNG,
    'assets/minecraft/textures/entity/shulker/shulker_white.png': PNG,
    'assets/minecraft/textures/entity/bed/red.png': PNG,
    'assets/minecraft/textures/entity/signs/oak.png': PNG,
    'assets/minecraft/textures/entity/signs/hanging/oak.png': PNG,
    [texturePath('water_still')]: PNG, [texturePath('water_flow')]: PNG,
    [`${texturePath('water_still')}.mcmeta`]: { animation: { frames: [0] } } };
  for (const name of ['chest', 'white_shulker_box', 'red_bed', 'oak_sign', 'oak_wall_sign', 'oak_hanging_sign', 'oak_wall_hanging_sign']) resources[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: 'minecraft:block/empty' } } };
  return createFixture(t, { ...resources, ...extra });
}

function transformedAxis(part, axis) {
  const x = -(part.x || 0) * Math.PI / 180, y = -(part.y || 0) * Math.PI / 180;
  const [a, b, c] = axis, by = b * Math.cos(x) - c * Math.sin(x), cz = b * Math.sin(x) + c * Math.cos(x);
  return [a * Math.cos(y) + cz * Math.sin(y), by, -a * Math.sin(y) + cz * Math.cos(y)].map(n => Math.round(n * 1e6) / 1e6 || 0);
}

test('waterlogged solids load local fluid resources without making the solid model translucent', t => {
  const { jar, root } = specialFixture(t, {
    'assets/minecraft/blockstates/oak_leaves.json': { variants: { '': { model: 'minecraft:block/stone' } } },
    'assets/minecraft/blockstates/waxed_oxidized_copper_grate.json': { variants: { '': { model: 'minecraft:block/stone' } } },
    'assets/minecraft/blockstates/mangrove_roots.json': { variants: { '': { model: 'minecraft:block/stone' } } },
  });
  const pack = new AdmZip(), override = Buffer.from(PNG); override[override.length - 1] ^= 1;
  pack.addFile(texturePath('water_still'), override);
  const resourcePackPath = path.join(root, 'water-pack.zip'); pack.writeZip(resourcePackPath);
  const assets = loadAssets(jar, ['minecraft:child[axis=y,waterlogged=true]', 'minecraft:child[axis=y,waterlogged=false]',
    'minecraft:oak_leaves[waterlogged=true]', 'minecraft:oak_leaves[waterlogged=false]',
    'minecraft:waxed_oxidized_copper_grate[waterlogged=true]', 'minecraft:mangrove_roots[waterlogged=true]'], { resourcePackPath });
  assert.deepEqual({ ...assets.fluids.water }, { still: 'minecraft:block/water_still', flow: 'minecraft:block/water_flow', tint: 0x3f76e4 });
  assert.equal(assets.blocks[0].waterlogged, true); assert.equal(assets.blocks[1].waterlogged, undefined);
  assert.equal(assets.blocks[0].transparent, undefined);
  assert.equal(assets.blocks[0].fallback, undefined);
  assert.deepEqual(assets.blocks[0].parts, assets.blocks[1].parts);
  assert.equal(assets.blocks[0].fluidPorous, undefined);
  assert.equal(assets.blocks[2].fluidPorous, true); assert.equal(assets.blocks[3].fluidPorous, undefined);
  assert.equal(assets.blocks[4].fluidPorous, true);
  assert.equal(assets.blocks[5].fluidPorous, true);
  assert.equal(assets.textures['minecraft:block/water_still'], `data:image/png;base64,${override.toString('base64')}`);
  assert.equal(assets.textureMeta['minecraft:block/water_still'].animated, true);
  const dry = loadAssets(jar, ['minecraft:child[waterlogged=false]']);
  assert.equal(dry.fluids.water, undefined); assert.equal(dry.textures['minecraft:block/water_still'], undefined);
  assert.equal(loadAssets(jar, ['minecraft:water[level=0]']).fluids.water.flow, 'minecraft:block/water_flow');
});

test('shulker lid and base use distinct sheet rows and all six facings retain vanilla opening and roll', t => {
  const { jar } = specialFixture(t), facings = ['up', 'down', 'north', 'south', 'west', 'east'];
  const assets = loadAssets(jar, facings.map(facing => `minecraft:white_shulker_box[facing=${facing}]`));
  // Reference directions from the local client's Direction.getRotation():
  // north = Rx(+90) Rz(180), south = Rx(+90), west/east add Rz(+/-90).
  const expectedUp = [[0,1,0],[0,-1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]];
  const expectedNorth = [[0,0,-1],[0,0,1],[0,1,0],[0,1,0],[0,1,0],[0,1,0]];
  assets.blocks.forEach((asset, i) => {
    const part = asset.parts[0], [lid, base] = part.elements;
    assert.deepEqual(transformedAxis(part, [0,1,0]), expectedUp[i]);
    assert.deepEqual(transformedAxis(part, [0,0,-1]), expectedNorth[i], `${facings[i]} texture roll`);
    assert.deepEqual(lid.from, [0,4,0]); assert.deepEqual(lid.to, [16,16,16]);
    assert.deepEqual(base.from, [0,0,0]); assert.deepEqual(base.to, [16,4,16]);
    assert.equal(lid.faces.down, undefined); assert.equal(base.faces.up, undefined);
    assert.deepEqual(lid.faces.north.uv, [12,4,16,7]);
    assert.deepEqual(lid.faces.south.uv, [4,4,8,7]);
    assert.deepEqual(base.faces.south.uv, [4,12,8,13]);
    assert.deepEqual(base.faces.down.uv, [8,11,12,7]);
  });
});

test('standing signs rotate their front toward south, west, north and east; wall signs stay against their supporting side', t => {
  const { jar } = specialFixture(t), facings = ['north', 'east', 'south', 'west'];
  const standing = loadAssets(jar, [0,4,8,12].map(rotation => `minecraft:oak_sign[rotation=${rotation}]`)).blocks;
  const expected = [[0,0,1],[-1,0,0],[0,0,-1],[1,0,0]];
  standing.forEach((asset, i) => {
    const part = asset.parts[0], [board, pole] = part.elements;
    assert.deepEqual(transformedAxis(part, [0,0,1]), expected[i]);
    assert.deepEqual(board.faces.south.uv, [0.5,1,6.5,7]);
    assert.deepEqual(board.faces.north.uv, [7,1,13,7]);
    assert.equal(pole.faces.south.texture, 'minecraft:entity/signs/oak');
    assert.equal(board.to[1], 52 / 3);
  });
  const wall = loadAssets(jar, facings.map(facing => `minecraft:oak_wall_sign[facing=${facing}]`)).blocks;
  const normals = [[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]];
  wall.forEach((asset, i) => {
    const part = asset.parts[0]; assert.deepEqual(transformedAxis(part, [0,0,1]), normals[i]);
    const center = transformedAxis(part, [0,0,-7]);
    assert.equal(center.reduce((sum, n, axis) => sum + n * normals[i][axis], 0), -7);
    assert.equal(part.elements.length, 1);
  });
});

test('hanging signs use their own entity texture, board UV and different chain attachment geometry', t => {
  const { jar } = specialFixture(t);
  const assets = loadAssets(jar, ['minecraft:oak_hanging_sign[rotation=4,attached=false]', 'minecraft:oak_hanging_sign[rotation=0,attached=true]', 'minecraft:oak_wall_hanging_sign[facing=north]']);
  const [free, attached, wall] = assets.blocks.map(asset => asset.parts[0]);
  assert.equal(free.elements.length, 5); assert.equal(attached.elements.length, 2); assert.equal(wall.elements.length, 6);
  assert.deepEqual(free.elements[0].faces.south.uv, [0.5,7,4,12]);
  assert.equal(free.elements[0].faces.south.texture, 'minecraft:entity/signs/hanging/oak');
  assert.deepEqual(free.elements[0].from, [1,0,7]); assert.deepEqual(free.elements[0].to, [15,10,9]);
  assert.equal(free.elements[1].rotation.angle, 45); assert.equal(free.elements[2].rotation.angle, -45);
  assert.deepEqual(attached.elements[1].faces.south.uv, [3.5,3,6.5,6]);
  assert.deepEqual(wall.elements[1].from, [0,14,6]);
  assert.deepEqual(transformedAxis(wall, [0,0,1]), [0,0,-1]);
});

test('bed head and foot select their own atlas regions and place the two legs only at the outer end', t => {
  const { jar } = specialFixture(t);
  const assets = loadAssets(jar, ['minecraft:red_bed[part=head,facing=east]', 'minecraft:red_bed[part=foot,facing=east]']);
  const [head, foot] = assets.blocks.map(asset => asset.parts[0]);
  assert.deepEqual(head.elements[0].faces.up.uv, [1.5,1.5,5.5,5.5]);
  assert.deepEqual(foot.elements[0].faces.up.uv, [1.5,7,5.5,11]);
  assert.equal(head.elements[0].faces.east.rotation, 90);
  assert.equal(head.elements[0].faces.west.rotation, 270);
  assert.deepEqual(head.elements.slice(1).map(leg => leg.from[2]), [0,0]);
  assert.deepEqual(foot.elements.slice(1).map(leg => leg.to[2]), [16,16]);
  assert.deepEqual(transformedAxis(head, [0,0,-1]), [1,0,0]);
  assert.ok(head.elements.every(element => Object.values(element.faces).every(face => face.texture === 'minecraft:entity/bed/red')));
});

test('closed chest uses the actual five-pixel lid and latch height with outward cardinal facing', t => {
  const { jar } = specialFixture(t);
  const facings = ['north','east','south','west'], expected = [[0,0,-1],[1,0,0],[0,0,1],[-1,0,0]];
  const assets = loadAssets(jar, facings.map(facing => `minecraft:chest[facing=${facing}]`));
  assets.blocks.forEach((asset, i) => {
    const part = asset.parts[0], [body,lid,latch] = part.elements;
    assert.deepEqual(transformedAxis(part, [0,0,-1]), expected[i]);
    assert.equal(body.to[1], 9); assert.equal(lid.from[1], 9); assert.equal(lid.to[1], 14);
    assert.equal(latch.from[1], 7); assert.equal(latch.to[1], 11);
    assert.equal(body.faces.up, undefined); assert.equal(lid.faces.down, undefined);
    assert.equal(lid.faces.north.uv[3] - lid.faces.north.uv[1], 5 / 4);
  });
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

test('optional real game entity sheets support oriented shulkers, beds, and both sign textures', { skip: !localJar || !fs.existsSync(localJar) }, () => {
  const facings = ['up','down','north','south','west','east'];
  const assets = loadAssets(localJar, [...facings.map(facing => `minecraft:white_shulker_box[facing=${facing}]`),
    'minecraft:red_bed[part=head,facing=north]', 'minecraft:red_bed[part=foot,facing=south]',
    'minecraft:oak_sign[rotation=3,waterlogged=true]', 'minecraft:oak_hanging_sign[rotation=0,attached=false,waterlogged=true]']);
  assert.ok(!assets.warnings.some(warning => /缺失|无效/.test(warning)), assets.warnings.join('\n'));
  for (const texture of ['entity/shulker/shulker_white','entity/bed/red','entity/signs/oak','entity/signs/hanging/oak','block/water_still','block/water_flow']) {
    assert.ok(assets.textures[`minecraft:${texture}`]); assert.ok(assets.textureMeta[`minecraft:${texture}`].width >= 16);
  }
  for (const asset of assets.blocks.slice(0,6)) assert.equal(asset.parts[0].elements.length, 2);
  assert.deepEqual(transformedAxis(assets.blocks[2].parts[0], [0,0,-1]), [0,1,0]);
  assert.deepEqual(assets.blocks[6].parts[0].elements[0].faces.up.uv, [1.5,1.5,5.5,5.5]);
  assert.equal(assets.fluids.water.still, 'minecraft:block/water_still');
});

test('optional real game legacy chains use the native iron-chain mesh and all three axis rotations', { skip: !localJar || !fs.existsSync(localJar) }, () => {
  const palette = ['chain', 'iron_chain'].flatMap(name => ['x', 'y', 'z'].map(axis => `minecraft:${name}[axis=${axis},waterlogged=false]`));
  const assets = loadAssets(localJar, palette);
  for (let axis = 0; axis < 3; axis++) {
    assert.equal(assets.blocks[axis].fallback, undefined);
    assert.deepEqual(assets.blocks[axis].parts, assets.blocks[axis + 3].parts);
    assert.equal(assets.blocks[axis].name, 'minecraft:chain');
  }
  assert.equal(assets.textures['viewer:missing'], undefined);
});

const localSample = process.env.LITEMATIC_SAMPLE;
test('optional regression sample has no missing face textures or atlas-escaping UVs', {
  skip: !localJar || !localSample || !fs.existsSync(localJar) || !fs.existsSync(localSample),
}, () => {
  const { parseLitematic } = require('../src/core/litematic.cjs');
  const schematic = parseLitematic(fs.readFileSync(localSample));
  const originalPalette = JSON.stringify(schematic.palette);
  const assets = loadAssets(localJar, schematic.palette, { resourcePackPath: process.env.MINECRAFT_RESOURCE_PACK || undefined });
  for (const [index, block] of assets.blocks.entries()) for (const part of block.parts) for (const element of part.elements) {
    for (const [direction, face] of Object.entries(element.faces)) {
      const context = `${index} ${block.name} ${direction}`;
      assert.notEqual(face.texture, 'viewer:missing', context);
      assert.ok(assets.textures[face.texture], `${context}: texture data must exist`);
      assert.ok(face.uv.every(value => Number.isFinite(value) && value >= 0 && value <= 16), `${context}: ${face.uv}`);
    }
  }
  assert.equal(JSON.stringify(schematic.palette), originalPalette);
});
