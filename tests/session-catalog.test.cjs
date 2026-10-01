'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { DocumentSession } = require('../src/core/session.cjs');
const { readCatalog } = require('../src/core/catalog.cjs');
const { writeNBT } = require('../src/core/document.cjs');
const { parseNBT, parseLitematic } = require('../src/core/litematic.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const tag = (type, value) => ({ value, types: { type } });
const int = value => tag('int', value), str = value => tag('string', value);
const compound = children => ({ value: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.value])),
  types: { type: 'compound', children: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.types])) } });
const list = (type, items) => ({ value: items.map(item => item.value), types: { type: 'list', elementType: type, items: items.map(item => item.types) } });
const vec = (x, y, z) => compound({ x: int(x), y: int(y), z: int(z) });
const state = (id, properties = {}) => compound({ Name: str(id), Properties: compound(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, str(value)]))) });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jarPath = path.join(root, 'game.jar'), filePath = path.join(root, 'original.litematic'), zip = new AdmZip();
  const add = (name, value) => zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  add('version.json', { id: 'fixture-1' });
  add('assets/minecraft/models/block/fixture.json', { textures: { all: 'minecraft:block/stone' }, elements: [
    { from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all', cullface: 'north' } } },
  ] });
  add('assets/minecraft/textures/block/stone.png', PNG);
  add('assets/minecraft/textures/block/birch_planks.png', PNG);
  add('assets/minecraft/textures/block/oak_planks.png', PNG);
  const model = { model: 'minecraft:block/fixture' }, variants = {};
  for (const facing of ['north', 'east', 'south', 'west']) for (const half of ['bottom', 'top']) for (const shape of ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']) variants[`facing=${facing},half=${half},shape=${shape}`] = model;
  for (const name of ['oak_stairs', 'stone_stairs']) add(`assets/minecraft/blockstates/${name}.json`, { variants });
  add('assets/minecraft/blockstates/stone_slab.json', { variants: { 'type=bottom': model, 'type=top': model, 'type=double': model } });
  add('assets/minecraft/blockstates/stone.json', { variants: { '': model } });
  add('assets/minecraft/blockstates/chest.json', { variants: Object.fromEntries(['north', 'east', 'south', 'west'].map(facing => [`facing=${facing},type=single`, model])) });
  add('assets/minecraft/blockstates/test_wall.json', { multipart: [{ when: { OR: [{ north: 'low|tall' }, { AND: [{ east: 'low' }, { up: 'true' }] }] }, apply: model }] });
  add('assets/minecraft/blockstates/oak_fence_gate.json', { variants: { 'open=false,powered=false': model, 'open=true,powered=true': model } });
  zip.writeZip(jarPath);
  const chest = (x, count) => compound({ x: int(x), y: int(0), z: int(0), id: str('minecraft:chest'),
    Items: list('compound', count ? [compound({ Slot: tag('byte', 0), id: str('minecraft:diamond'), Count: tag('byte', count) })] : []), CustomName: str(`Chest ${x}`) });
  const document = compound({ Version: int(6), MinecraftDataVersion: int(3700),
    Metadata: compound({ Name: str('Session fixture'), TotalBlocks: int(4), TimeModified: tag('long', '123'), Author: str('Test') }),
    UnknownRoot: tag('long_array', ['-9223372036854775808', '9223372036854775807']),
    Regions: compound({ main: compound({ Position: vec(0, 0, 0), Size: vec(4, 1, 1), BlockStatePalette: list('compound', [
      state('minecraft:oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'true' }),
      state('minecraft:chest', { facing: 'north', type: 'single', waterlogged: 'false' }), state('minecraft:stone'),
    ]), BlockStates: tag('long_array', ['148']), // [0, 1, 1, 2] at 2 bits each
    TileEntities: list('compound', [chest(1, 64), chest(2, 0)]),
    Entities: list('compound', [compound({ id: str('minecraft:item_frame'), Pos: list('double', [1.5, 1, 0.5].map(n => tag('double', n))), Rotation: list('float', [tag('float', 90), tag('float', 0)]), UnknownEntity: tag('short', 42) })]),
    PendingBlockTicks: list('compound', [compound({ x: int(3), y: int(0), z: int(0), Block: str('minecraft:stone'), Time: int(10) })]),
    }) }),
  });
  const original = writeNBT({ name: 'Fixture', ...document }, 'gzip');
  fs.writeFileSync(filePath, original);
  const progress = [], session = new DocumentSession(() => ({ jarPath }), message => progress.push(message));
  t.after(() => session.dispose());
  return { root, jarPath, filePath, original, session, progress };
}

test('catalog builds complete unseen stair/slab defaults and extracts multipart property alternatives', t => {
  const { jarPath } = fixture(t), catalog = readCatalog(jarPath), get = id => catalog.find(entry => entry.id === `minecraft:${id}`);
  assert.deepEqual(get('stone_stairs').defaults, { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
  assert.deepEqual(get('stone_slab').defaults, { type: 'bottom', waterlogged: 'false' });
  assert.deepEqual(get('stone_slab').properties.type, ['bottom', 'double', 'top']);
  assert.deepEqual(get('stone_stairs').properties.waterlogged, ['false', 'true']);
  assert.deepEqual(get('test_wall').properties.north, ['low', 'tall']);
  assert.deepEqual(get('test_wall').properties.east, ['low']);
  assert.equal(get('oak_fence_gate').properties.waterlogged, undefined);
  assert.deepEqual(get('stone').defaults, {});
});

test('catalog incorporates existing states and resource-pack-only blocks without requiring private paths', t => {
  const { jarPath, root } = fixture(t), zip = new AdmZip(), packPath = path.join(root, 'pack.zip');
  zip.addFile('assets/example/blockstates/special.json', Buffer.from(JSON.stringify({ variants: { 'mode=on': { model: 'minecraft:block/fixture' }, 'mode=off': { model: 'minecraft:block/fixture' } } })));
  zip.writeZip(packPath);
  const catalog = readCatalog(jarPath, [{ Name: 'minecraft:oak_stairs', Properties: { facing: 'west', waterlogged: 'true', half: 'top', shape: 'straight' } }, { Name: 'mod:existing', Properties: { axis: 'z' } }], packPath);
  assert.equal(catalog.find(entry => entry.id === 'minecraft:oak_stairs').defaults.waterlogged, 'true');
  assert.deepEqual(catalog.find(entry => entry.id === 'example:special').properties.mode, ['off', 'on']);
  assert.deepEqual(catalog.find(entry => entry.id === 'mod:existing').defaults, { axis: 'z' });
});

test('session scoped replacement, undo/redo and save preserve original, entities and typed unknown NBT', async t => {
  const { session, original, filePath, root, progress } = fixture(t);
  const loaded = await session.load(filePath);
  assert.equal(loaded.document.dirty, false); assert.equal(loaded.document.canUndo, false);
  assert.equal(loaded.schematic.blocks.length, 4); assert.equal(loaded.schematic.entities.length, 1); assert.ok(progress.length >= 2);
  const edited = await session.replace({ fromNames: ['minecraft:chest'], to: { Name: 'minecraft:stone' }, scope: [{ region: 'main', localIndex: 1 }] });
  assert.equal(edited.editSummary.changed, 1); assert.equal(edited.editSummary.removedBlockEntities, 1);
  assert.equal(edited.document.dirty, true); assert.equal(edited.document.canUndo, true);
  assert.equal(edited.schematic.counts.byName['minecraft:chest'], 1);
  const before = parseNBT(original), after = parseNBT(session.current.buffer);
  for (const key of ['Entities', 'PendingBlockTicks']) assert.deepEqual(after.value.Regions.main[key], before.value.Regions.main[key]);
  assert.deepEqual(after.value.UnknownRoot, before.value.UnknownRoot);
  assert.deepEqual(after.types.children.UnknownRoot, before.types.children.UnknownRoot);
  assert.deepEqual(fs.readFileSync(filePath), original);
  const editedBytes = Buffer.from(session.current.buffer), savedPath = path.join(root, 'edited.litematic');
  const saved = await session.save(savedPath);
  assert.equal(saved.dirty, false); assert.deepEqual(fs.readFileSync(savedPath), editedBytes);
  assert.deepEqual(fs.readFileSync(filePath), original);
  const undo = await session.history('undo');
  assert.deepEqual(session.current.buffer, original); assert.equal(undo.document.dirty, true); assert.equal(undo.document.canRedo, true);
  const redo = await session.history('redo');
  assert.deepEqual(session.current.buffer, editedBytes); assert.equal(redo.document.dirty, false);
  assert.equal(parseLitematic(fs.readFileSync(savedPath)).counts.byName['minecraft:chest'], 1);
});

test('session rejects failed load, replacement and save without altering document or history', async t => {
  const { session, filePath, root } = fixture(t);
  await session.load(filePath);
  await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone_slab' } });
  const currentBytes = Buffer.from(session.current.buffer), info = session.info();
  const assertUnchanged = () => { assert.deepEqual(session.current.buffer, currentBytes); assert.deepEqual(session.info(), info); };
  await assert.rejects(session.replace({ fromNames: ['minecraft:stone_slab'], to: { Name: 'minecraft:missing_block' } }), /没有该目标/); assertUnchanged();
  await assert.rejects(session.replace({ fromNames: ['minecraft:stone_slab'], to: { Name: 'minecraft:stone_stairs', Properties: { facing: 'diagonal' } } }), /目标状态无效/); assertUnchanged();
  await assert.rejects(session.replace({ fromNames: ['minecraft:stone_slab'], to: { Name: 'minecraft:stone' }, scope: [{ region: 'gone', localIndex: 0 }] }), /已失效/); assertUnchanged();
  const corrupt = path.join(root, 'corrupt.litematic'); fs.writeFileSync(corrupt, Buffer.from('Invalid NBT'));
  await assert.rejects(session.load(corrupt), /NBT/); assertUnchanged();
  await assert.rejects(session.save(path.join(root, 'missing-directory', 'out.litematic'))); assertUnchanged();
  assert.equal(session.active, null);
});

test('session supplies complete target defaults, retains allowed waterlogged state and preserves same-ID NBT', async t => {
  const { session, filePath } = fixture(t);
  await session.load(filePath);
  const stairs = await session.replace({ fromNames: ['minecraft:oak_stairs'], to: { Name: 'minecraft:stone_stairs' }, preserveProperties: true });
  const stairsBlock = stairs.schematic.blocks.find(b => b.localIndex === 0), stairsState = stairs.schematic.palette[stairsBlock.state];
  assert.deepEqual(stairsState.Properties, { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'true' });
  const slab = await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone_slab' } });
  const slabState = slab.schematic.palette[slab.schematic.blocks.find(b => b.localIndex === 3).state];
  assert.deepEqual(slabState.Properties, { type: 'bottom', waterlogged: 'false' });
  const chest = await session.replace({ fromNames: ['minecraft:chest'], to: { Name: 'minecraft:chest', Properties: { facing: 'east' } }, scope: [{ region: 'main', localIndex: 1 }] });
  assert.equal(chest.editSummary.changed, 1); assert.equal(chest.editSummary.removedBlockEntities, 0); assert.equal(chest.editSummary.preservedBlockEntities, 1);
  const modified = chest.schematic.blocks.find(b => b.localIndex === 1);
  assert.equal(chest.schematic.palette[modified.state].Properties.facing, 'east');
  assert.equal(modified.container.itemCount, 64); assert.equal(modified.nbt.CustomName, 'Chest 1');
  assert.equal(chest.schematic.palette[chest.schematic.blocks.find(b => b.localIndex === 2).state].Properties.facing, 'north');
});

test('no-op replacement keeps redo history and loading another valid document resets history', async t => {
  const { session, filePath, root, original } = fixture(t);
  await session.load(filePath);
  await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone_slab' } });
  await session.history('undo');
  assert.equal(session.info().canRedo, true); assert.equal(session.info().dirty, false);
  const noop = await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone' }, scope: [] });
  assert.equal(noop.editSummary.changed, 0); assert.equal(session.info().canRedo, true);
  const second = path.join(root, 'second.litematic'); fs.writeFileSync(second, original);
  await session.load(second);
  assert.deepEqual(session.info(), { dirty: false, canUndo: false, canRedo: false, filePath: second });
  assert.equal(await session.history('undo'), null);
});

test('save locks load, reload, replacement, history and another save until its captured bytes reach disk', async t => {
  const { session, filePath, root, original } = fixture(t);
  await session.load(filePath);
  await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone_slab' } });
  const captured = Buffer.from(session.current.buffer), before = session.info(), historyLength = session.undoStack.length;
  const savedPath = path.join(root, 'delayed-save.litematic');
  const originalWrite = fs.promises.writeFile;
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  fs.promises.writeFile = async function(filename, bytes, options) {
    if (filename.startsWith(savedPath + '.')) {
      assert.deepEqual(bytes, captured);
      started(); await new Promise(resolve => { release = resolve; });
    }
    return originalWrite.call(this, filename, bytes, options);
  };
  let saving;
  try {
    saving = session.save(savedPath); await entered;
    assert.equal(session.saving, true);
    const blocked = /正在处理投影/;
    await assert.rejects(session.load(filePath), blocked);
    await assert.rejects(session.reload(), blocked);
    await assert.rejects(session.replace({ fromNames: ['minecraft:stone_slab'], to: { Name: 'minecraft:stone' } }), blocked);
    await assert.rejects(session.history('undo'), blocked);
    await assert.rejects(session.save(savedPath), blocked);
    assert.deepEqual(session.info(), before); assert.equal(session.undoStack.length, historyLength);
    assert.deepEqual(session.current.buffer, captured);
    assert.equal(fs.existsSync(savedPath), false);
    release(); await saving;
  } finally {
    if (release) release();
    fs.promises.writeFile = originalWrite;
    if (saving) await saving.catch(() => {});
  }
  assert.equal(session.saving, false); assert.equal(session.info().dirty, false);
  assert.deepEqual(fs.readFileSync(savedPath), captured);
  assert.deepEqual(session.savedBuffer, captured); assert.notEqual(session.savedBuffer, session.current.buffer, 'Saved bytes are an independent snapshot');
  assert.deepEqual(fs.readFileSync(filePath), original);
  const undo = await session.history('undo'); assert.equal(undo.document.dirty, true);
  const redo = await session.history('redo'); assert.equal(redo.document.dirty, false);
});

test('failed delayed save releases its lock and leaves current file, saved snapshot and history intact', async t => {
  const { session, filePath, root } = fixture(t);
  await session.load(filePath);
  await session.replace({ fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone_slab' } });
  const info = session.info(), current = Buffer.from(session.current.buffer), saved = Buffer.from(session.savedBuffer), undoLength = session.undoStack.length;
  const originalRename = fs.promises.rename;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  fs.promises.rename = async function() {
    entered(); await new Promise(resolve => { release = resolve; });
    throw new Error('Simulated disk rename failure');
  };
  let pending;
  const destination = path.join(root, 'failed-save.litematic');
  try {
    pending = session.save(destination); const rejection = assert.rejects(pending, /Simulated disk rename failure/);
    await waiting; assert.equal(session.saving, true);
    await assert.rejects(session.load(filePath), /正在处理投影/);
    release(); await rejection;
  } finally {
    if (release) release();
    fs.promises.rename = originalRename;
    if (pending) await pending.catch(() => {});
  }
  assert.equal(session.saving, false); assert.deepEqual(session.info(), info);
  assert.deepEqual(session.current.buffer, current); assert.deepEqual(session.savedBuffer, saved);
  assert.equal(session.undoStack.length, undoLength);
  assert.equal(fs.readdirSync(root).filter(name => name.startsWith('failed-save.litematic.')).length, 0);
  await session.save(destination); assert.equal(session.info().dirty, false);
  assert.deepEqual(fs.readFileSync(destination), current);
});

test('optional installed Minecraft catalog exposes waterlogged stairs and slabs', { skip: !process.env.MINECRAFT_JAR }, () => {
  const catalog = readCatalog(process.env.MINECRAFT_JAR);
  for (const id of ['minecraft:stone_stairs', 'minecraft:stone_slab']) {
    const entry = catalog.find(item => item.id === id);
    assert.ok(entry, id); assert.deepEqual(entry.properties.waterlogged, ['false', 'true']);
    assert.equal(entry.defaults.waterlogged, 'false');
  }
});
