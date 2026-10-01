'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseNBT, parseLitematic } = require('../src/core/litematic.cjs');
const { writeNBT, createDocument, replaceBlocks, stateKey } = require('../src/core/document.cjs');

const tag = (type, value) => ({ value, types: { type } });
const int = value => tag('int', value), string = value => tag('string', value);
const compound = children => ({ value: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.value])),
  types: { type: 'compound', children: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.types])) } });
const list = (type, items) => ({ value: items.map(item => item.value), types: { type: 'list', elementType: type, items: items.map(item => item.types) } });
const vector = (x, y, z) => compound({ x: int(x), y: int(y), z: int(z) });
const state = (name, properties = {}) => compound({ Name: string(`minecraft:${name}`), Properties: compound(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, string(value)]))) });
function packed(indices, paletteSize) {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize))), words = Array(Math.ceil(indices.length * bits / 64)).fill(0n);
  indices.forEach((index, i) => {
    const bit = i * bits, word = Math.floor(bit / 64), shift = bit % 64;
    words[word] |= BigInt(index) << BigInt(shift);
    if (shift + bits > 64) words[word + 1] |= BigInt(index) >> BigInt(64 - shift);
  });
  return tag('long_array', words.map(word => BigInt.asIntN(64, word).toString()));
}
function region({ position = [0, 0, 0], size = [1, 1, 1], palette = [state('stone')], indices = [0], tiles = [], entities = [], extra = {} } = {}) {
  return compound({ Position: vector(...position), Size: vector(...size), BlockStatePalette: list('compound', palette), BlockStates: packed(indices, palette.length),
    TileEntities: list('compound', tiles), Entities: list('compound', entities), ...extra });
}
function fixture(regions, extra = {}, version = 6, compression = 'gzip') {
  const root = compound({ Version: int(version), MinecraftDataVersion: int(3700),
    Metadata: compound({ Name: string('测试\0😀'), Author: string('Keep me'), TotalBlocks: int(1), TimeModified: tag('long', '123') }),
    Regions: compound(regions), ...extra });
  return writeNBT({ name: '投影\0😀', ...root }, compression);
}
const tile = (x, id, extra = {}) => compound({ x: int(x), y: int(0), z: int(0), id: string(id), ...extra });
const entity = (id, pos) => compound({ id: string(id), Pos: list('double', pos.map(n => tag('double', n))), Rotation: list('float', [tag('float', 90), tag('float', -10)]),
  UnknownEntityTag: tag('long_array', ['-9223372036854775808', '9223372036854775807']) });

test('typed NBT writing roundtrips every type, UTF-16 surrogates, extreme longs and non-finite floats', () => {
  const tree = compound({ byte: tag('byte', -128), short: tag('short', -32768), int: int(-2147483648),
    long: tag('long', '-9223372036854775808'), float: tag('float', -0), double: tag('double', Number.MAX_VALUE),
    nan: tag('float', 'NaN'), inf: tag('double', 'Infinity'), neginf: tag('double', '-Infinity'),
    bytes: tag('byte_array', [-128, 0, 127]), ints: tag('int_array', [-2147483648, 2147483647]),
    longs: tag('long_array', ['-9223372036854775808', '9223372036854775807']),
    text: string('文字\0😀\ud800'), empty: list('end', []), emptyCompoundList: list('compound', []),
    nested: list('list', [list('string', [string('A'), string('B')])]),
    ['__proto__']: compound({ safe: int(1) }),
  });
  for (const compression of ['none', 'gzip', 'zlib']) {
    const first = parseNBT(writeNBT({ name: 'ROOT\0😀', ...tree }, compression));
    const roundtrip = parseNBT(writeNBT(first));
    assert.deepEqual(roundtrip.value, first.value);
    assert.deepEqual(roundtrip.types, first.types);
    assert.equal(roundtrip.name, 'ROOT\0😀'); assert.equal(roundtrip.compression, compression);
    assert.equal(roundtrip.value.text, '文字\0😀\ud800');
    assert.equal(roundtrip.value.__proto__.safe, 1); assert.equal({}.safe, undefined);
    assert.ok(Object.is(roundtrip.value.float, -0));
  }
  assert.throws(() => writeNBT({ name: '', ...compound({ a: string('a'.repeat(65536)) }) }), /65535/);
  assert.throws(() => writeNBT({ name: '', ...compound({ a: tag('long', '9223372036854775808') }) }), /64 位/);
  assert.throws(() => writeNBT({ name: '', value: { a: 1 }, types: { type: 'compound', children: {} } }), /类型信息/);
});

test('entities use pos1 rather than minimum corner, and block localIndex stays stable through air', () => {
  const input = fixture({ negative: region({ position: [10, 8, -2], size: [-2, -2, -2], palette: [state('air'), state('stone')],
    indices: [0, 1, 0, 0, 0, 0, 0, 1], entities: [entity('minecraft:item_frame', [-0.5, -0.75, -0.25])] }) });
  const parsed = parseLitematic(input);
  assert.deepEqual(parsed.blocks.map(b => b.localIndex), [1, 7]);
  assert.deepEqual(parsed.entities[0].position, { x: 9.5, y: 7.25, z: -2.25 });
  assert.deepEqual(parsed.entities[0].rotation, [90, -10]);
  assert.equal(parsed.entities[0].nbtTypes.children.UnknownEntityTag.type, 'long_array');
  assert.equal(parsed.counts.entities, 1);
});

test('legacy wrapped entities retain raw NBT and invalid entities stay inspectable', () => {
  const input = fixture({ a: region({ entities: [compound({ x: tag('double', 1.5), y: tag('double', 0), z: tag('double', 2),
    EntityData: compound({ id: string('minecraft:armor_stand'), marker: tag('byte', 1) }) }), compound({ EntityData: compound({ id: string('mod:unknown') }) })] }) }, {}, 1);
  const parsed = parseLitematic(input);
  assert.deepEqual(parsed.entities[0].position, { x: 1.5, y: 0, z: 2 });
  assert.equal(parsed.entities[0].nbt.marker, 1); assert.equal(parsed.entities[1].position, null);
  assert.match(parsed.warnings.join(' '), /实体 2/);
  const document = createDocument(input);
  assert.deepEqual(parseNBT(document.serialize()).value, parseNBT(input).value);
});

test('scoped replacement crosses packed word boundaries while retaining entities, ticks, unknown data, and negative size', () => {
  const indices = Array.from({ length: 96 }, (_, i) => i % 4);
  const input = fixture({ negative: region({ position: [10, 4, -1], size: [-8, -3, -4],
    palette: ['stone', 'dirt', 'glass', 'sand'].map(name => state(name)), indices,
    entities: [entity('minecraft:armor_stand', [-1.25, 0, -0.5])],
    extra: { PendingBlockTicks: list('compound', [compound({ x: int(1), y: int(0), z: int(0), Block: string('minecraft:stone'), Time: int(8), SubTick: tag('long', '9223372036854775807') })]),
      PendingFluidTicks: list('compound', [compound({ Fluid: string('minecraft:water'), Time: int(5) })]),
      ModdedData: compound({ opaque: tag('byte_array', [1, -1, 127]) }) } }) }, { CustomRoot: tag('long', '9223372036854775807') });
  const before = parseNBT(input), result = replaceBlocks(input, { fromNames: ['minecraft:dirt'], to: { Name: 'minecraft:quartz_block' }, scope: [{ region: 'negative', localIndex: 21 }] });
  assert.equal(result.changed, 1); assert.equal(result.removedBlockEntities, 0);
  const after = parseNBT(result.buffer), parsed = parseLitematic(result.buffer);
  const oldRegion = before.value.Regions.negative, newRegion = after.value.Regions.negative;
  for (const key of ['Position', 'Size', 'Entities', 'PendingBlockTicks', 'PendingFluidTicks', 'ModdedData']) {
    assert.deepEqual(newRegion[key], oldRegion[key]);
    assert.deepEqual(after.types.children.Regions.children.negative.children[key], before.types.children.Regions.children.negative.children[key]);
  }
  assert.equal(after.value.CustomRoot, before.value.CustomRoot);
  assert.equal(after.value.Metadata.Author, 'Keep me'); assert.equal(after.value.Metadata.TotalBlocks, 96);
  assert.equal(parsed.palette[parsed.blocks.find(b => b.localIndex === 21).state].Name, 'minecraft:quartz_block');
  for (const block of parsed.blocks.filter(b => b.localIndex !== 21)) assert.equal(parsed.palette[block.state].Name, ['stone', 'dirt', 'glass', 'sand'].map(n => `minecraft:${n}`)[block.localIndex % 4]);
  assert.deepEqual(parseNBT(input).value, before.value, 'original buffer must remain unchanged');
});

test('empty scope and no-op return original bytes; unused palettes never change another region bit width', () => {
  const input = fixture({ unused: region({ palette: ['stone', 'dirt', 'glass', 'sand'].map(n => state(n)) }),
    changed: region({ position: [2, 0, 0], palette: [state('sand')] }) });
  const options = { fromNames: ['minecraft:sand'], to: { Name: 'minecraft:quartz_block' } };
  assert.deepEqual(replaceBlocks(input, { ...options, scope: [] }).buffer, input);
  assert.deepEqual(replaceBlocks(input, { fromNames: ['minecraft:stone'], to: { Name: 'minecraft:stone' } }).buffer, input);
  const result = replaceBlocks(input, options), parsed = parseNBT(result.buffer);
  assert.equal(result.changed, 1); assert.equal(parsed.value.Regions.unused.BlockStatePalette.length, 4);
  assert.doesNotThrow(() => parseLitematic(result.buffer));
  assert.throws(() => replaceBlocks(input, { ...options, scope: [{ region: 'gone', localIndex: 0 }] }), /已失效/);
});

test('changing block identity removes only attached incompatible NBT while preserving orphan payloads and same-family containers', () => {
  const input = fixture({ a: region({ size: [4, 1, 1], palette: [state('chest', { facing: 'north' }), state('red_shulker_box'), state('stone')], indices: [0, 0, 1, 2],
    tiles: [tile(0, 'minecraft:chest', { Items: list('compound', [compound({ id: string('minecraft:diamond'), Count: tag('byte', 64) })]) }),
      tile(1, 'minecraft:chest', { Items: list('compound', []) }), tile(2, 'minecraft:shulker_box', { Items: list('compound', []) }),
      tile(99, 'mod:orphan', { Strange: tag('short', 77) }), compound({ Unlocatable: string('Preserve') })] }) });
  const removed = replaceBlocks(input, { fromNames: ['minecraft:chest'], to: { Name: 'minecraft:stone' }, scope: [{ region: 'a', localIndex: 0 }] });
  assert.equal(removed.removedBlockEntities, 1);
  const removedRaw = parseNBT(removed.buffer);
  assert.equal(removedRaw.value.Regions.a.TileEntities.length, 4);
  assert.equal(removedRaw.value.Regions.a.TileEntities[2].Strange, 77);
  assert.equal(removedRaw.value.Regions.a.TileEntities[3].Unlocatable, 'Preserve');
  const property = replaceBlocks(input, { fromNames: ['minecraft:chest'], to: { Name: 'minecraft:chest', Properties: { facing: 'east' } } });
  assert.equal(property.removedBlockEntities, 0); assert.equal(property.preservedBlockEntities, 2);
  assert.equal(parseLitematic(property.buffer).blocks[0].container.itemCount, 64);
  const family = replaceBlocks(input, { fromNames: ['minecraft:red_shulker_box'], to: { Name: 'minecraft:blue_shulker_box' } });
  assert.equal(family.removedBlockEntities, 0); assert.equal(family.preservedBlockEntities, 1);
});

test('replacement to air updates true block count and preserveProperties copies only explicitly allowed values', () => {
  const input = fixture({ a: region({ size: [3, 1, 1], palette: [state('oak_stairs', { facing: 'north', waterlogged: 'true', type: 'left', invalid: 'x' })], indices: [0, 0, 0] }) });
  const result = replaceBlocks(input, { fromNames: ['minecraft:oak_stairs'], to: { Name: 'minecraft:stone_stairs', Properties: { facing: 'east', waterlogged: 'false', half: 'bottom' } },
    preserveProperties: true, allowedProperties: { facing: ['north', 'east'], waterlogged: ['true', 'false'], half: ['top', 'bottom'] } });
  const parsed = parseLitematic(result.buffer), target = parsed.palette[parsed.blocks[0].state];
  assert.deepEqual({ ...target.Properties }, { facing: 'north', half: 'bottom', waterlogged: 'true' });
  const removed = replaceBlocks(result.buffer, { fromNames: ['minecraft:stone_stairs'], to: { Name: 'minecraft:air' } });
  assert.equal(removed.changed, 3); assert.equal(parseLitematic(removed.buffer).counts.totalBlocks, 0);
  assert.equal(parseNBT(removed.buffer).value.Metadata.TotalBlocks, 0);
  const mapped = replaceBlocks(input, { fromNames: ['minecraft:oak_stairs'], to: { Name: 'minecraft:stone' }, stateMap: {
    [stateKey(parseNBT(input).value.Regions.a.BlockStatePalette[0])]: { Name: 'minecraft:dirt' },
  } });
  assert.equal(parseLitematic(mapped.buffer).counts.byName['minecraft:dirt'], 3);
});

const userFixture = process.env.LITEMATIC_SAMPLE;
test('optional local schematic replacement preserves unrelated block entities, entities, and unknown data', { skip: !userFixture || !fs.existsSync(userFixture) }, t => {
  const input = fs.readFileSync(userFixture), before = parseNBT(input), source = parseLitematic(input);
  const namesWithNBT = new Set(source.blocks.filter(block => block.nbt).map(block => source.palette[block.state].Name));
  const sourceName = Object.keys(source.counts.byName).find(name => name !== 'minecraft:stone' && !namesWithNBT.has(name));
  if (!sourceName) { t.skip('No non-stone block type without attached NBT in the optional schematic'); return; }
  const result = replaceBlocks(input, { fromNames: [sourceName], to: { Name: 'minecraft:stone' } });
  assert.equal(result.changed, source.counts.byName[sourceName]); assert.equal(result.removedBlockEntities, 0);
  const after = parseNBT(result.buffer), parsed = parseLitematic(result.buffer);
  assert.equal(parsed.counts.byName[sourceName], undefined);
  assert.equal(parsed.counts.totalBlocks, source.counts.totalBlocks);
  assert.equal(parsed.counts.tileEntities, source.counts.tileEntities);
  assert.equal(parsed.counts.entities, source.counts.entities);
  for (const name of Object.keys(before.value.Regions)) {
    for (const key of Object.keys(before.value.Regions[name]).filter(key => !['BlockStatePalette', 'BlockStates'].includes(key))) {
      assert.deepEqual(after.value.Regions[name][key], before.value.Regions[name][key]);
      assert.deepEqual(after.types.children.Regions.children[name].children[key], before.types.children.Regions.children[name].children[key]);
    }
  }
});
