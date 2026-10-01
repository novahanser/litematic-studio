'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { parseNBT, parseLitematic, containerInfo } = require('../src/core/litematic.cjs');

const tag = (type, value, elementType) => ({ type, value, elementType });
const int = n => tag(3, n), str = s => tag(8, s), compound = o => tag(10, o);
const list = (type, values) => tag(9, values, type);
const vec = (x, y, z) => compound({ x: int(x), y: int(y), z: int(z) });
function scalar(method, n, bytes) { const b = Buffer.alloc(bytes); b[method](n); return b; }
function utf(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0 && c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Buffer.concat([scalar('writeUInt16BE', bytes.length, 2), Buffer.from(bytes)]);
}
function payload(t) {
  const methods = { 1: ['writeInt8', 1], 2: ['writeInt16BE', 2], 3: ['writeInt32BE', 4], 4: ['writeBigInt64BE', 8], 5: ['writeFloatBE', 4], 6: ['writeDoubleBE', 8] };
  if (methods[t.type]) { const [method, size] = methods[t.type]; return scalar(method, t.value, size); }
  if (t.type === 8) return utf(t.value);
  if (t.type === 10) return Buffer.concat([...Object.entries(t.value).map(([key, item]) => Buffer.concat([Buffer.from([item.type]), utf(key), payload(item)])), Buffer.from([0])]);
  if (t.type === 9) return Buffer.concat([Buffer.from([t.elementType]), scalar('writeInt32BE', t.value.length, 4), ...t.value.map(value => payload(tag(t.elementType, value)))]);
  const elementType = { 7: 1, 11: 3, 12: 4 }[t.type];
  if (elementType) return Buffer.concat([scalar('writeInt32BE', t.value.length, 4), ...t.value.map(value => payload(tag(elementType, value)))]);
  throw new Error(`Test encoder type ${t.type}`);
}
function encode(root, name = '') { return Buffer.concat([Buffer.from([10]), utf(name), payload(compound(root))]); }
function packed(states, paletteSize) {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize))), words = new Array(Math.ceil(states.length * bits / 64)).fill(0n);
  states.forEach((state, index) => {
    const bit = index * bits, word = Math.floor(bit / 64), shift = bit % 64;
    words[word] |= BigInt(state) << BigInt(shift);
    if (shift + bits > 64) words[word + 1] |= BigInt(state) >> BigInt(64 - shift);
  });
  return tag(12, words.map(n => BigInt.asIntN(64, n)));
}
const state = (name, properties) => ({ Name: str(name), ...(properties ? { Properties: compound(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, str(value)]))) } : {}) });
function region({ position = [0, 0, 0], size = [1, 1, 1], palette = [state('minecraft:stone')], states = [0], tiles = [] } = {}) {
  return compound({ Position: vec(...position), Size: vec(...size), BlockStatePalette: list(10, palette), BlockStates: packed(states, palette.length), TileEntities: list(10, tiles) });
}
function schematic(regions, version = 6) { return encode({ Version: int(version), MinecraftDataVersion: int(3700), Metadata: compound({ Name: str('Fixture') }), Regions: compound(regions) }); }

test('all Java NBT types, modified UTF-8, signed 64-bit values and type trees survive JSON', () => {
  const bytes = encode({
    byte: tag(1, -128), short: tag(2, -32768), int: int(2147483647), long: tag(4, -9223372036854775808n),
    float: tag(5, 1.25), double: tag(6, 2.5), string: str('投影\0😀'),
    bytes: tag(7, [-128, 0, 127]), ints: tag(11, [-2147483648, 4]), longs: tag(12, [9223372036854775807n]),
    nested: compound({ array: list(10, [{ a: int(9) }]), empty: list(0, []) }),
    ['__proto__']: compound({ malicious: int(1) }),
  }, 'Root');
  const result = parseNBT(bytes), json = JSON.parse(JSON.stringify(result));
  assert.equal(result.name, 'Root');
  assert.equal(result.bytesRead, bytes.length);
  assert.equal(json.value.string, '投影\0😀');
  assert.equal(json.value.long, '-9223372036854775808');
  assert.deepEqual(json.value.longs, ['9223372036854775807']);
  assert.deepEqual(json.value.bytes, [-128, 0, 127]);
  assert.equal(json.types.children.longs.type, 'long_array');
  assert.equal(json.types.children.nested.children.empty.elementType, 'end');
  assert.equal(json.types.children.nested.children.array.items[0].children.a.type, 'int');
  assert.equal(json.value.__proto__.malicious, 1);
  assert.equal({}.malicious, undefined);
});

test('gzip and zlib compression produce identical plain NBT', () => {
  const raw = encode({ value: str('测试') });
  assert.deepEqual(parseNBT(zlib.gzipSync(raw)).value, parseNBT(raw).value);
  assert.deepEqual(parseNBT(zlib.deflateSync(raw)).value, parseNBT(raw).value);
  assert.equal(parseNBT(zlib.gzipSync(raw)).compression, 'gzip');
});

test('truncated, corrupt, excessive array lengths and wrong root types are rejected', () => {
  assert.throws(() => parseNBT(Buffer.alloc(0)), /文件为空/);
  assert.throws(() => parseNBT(Buffer.from([3, 0, 0])), /根标签/);
  assert.throws(() => parseNBT(encode({ x: int(10) }).subarray(0, -3)), /截断/);
  assert.throws(() => parseNBT(Buffer.from([0x1f, 0x8b, 0, 0])), /解压失败/);
  assert.throws(() => parseNBT(Buffer.from([10, 0, 0, 7, 0, 1, 120, 0xff, 0xff, 0xff, 0xff, 0])), /长度无效/);
  assert.throws(() => parseLitematic(encode({})), /缺少 Regions/);
});

test('non-finite floating point NBT stays JSON-safe instead of silently becoming null', () => {
  const result = parseNBT(encode({ nan: tag(5, NaN), inf: tag(6, Infinity) }));
  assert.equal(result.value.nan, 'NaN');
  assert.equal(JSON.parse(JSON.stringify(result)).value.inf, 'Infinity');
});

test('three-bit palette entries cross 64-bit boundaries and use X then Z then Y order', () => {
  const palette = [state('minecraft:air'), ...['stone', 'dirt', 'glass', 'sand', 'ice'].map(n => state(`minecraft:${n}`))];
  const states = Array.from({ length: 96 }, (_, i) => i % 6);
  const r = parseLitematic(schematic({ main: region({ size: [8, 3, 4], palette, states }) }));
  assert.equal(r.blocks.length, 80);
  for (const b of r.blocks) {
    const index = b.y * 32 + b.z * 8 + b.x;
    assert.equal(r.palette[b.state].Name, `minecraft:${['air', 'stone', 'dirt', 'glass', 'sand', 'ice'][index % 6]}`);
  }
  const crossWord = r.blocks.find(b => b.x === 5 && b.y === 0 && b.z === 2); // index 21, bit 63
  assert.equal(r.palette[crossWord.state].Name, 'minecraft:glass');
});

test('negative sizes and positions translate blocks AND NBT from the minimum corner', () => {
  const r = parseLitematic(schematic({ negative: region({ position: [-3, 8, -2], size: [-2, -2, -2],
    palette: [state('minecraft:air'), state('minecraft:chest')], states: [1, 0, 0, 0, 0, 0, 0, 1],
    tiles: [{ x: int(0), y: int(0), z: int(0), id: str('minecraft:chest'), Items: list(10, [{ Slot: tag(1, 3), id: str('minecraft:ice'), Count: tag(1, 64) }]), CustomName: str('完整保留') }] }) }));
  assert.deepEqual(r.bounds, { min: { x: -4, y: 7, z: -3 }, max: { x: -3, y: 8, z: -2 } });
  assert.deepEqual(r.blocks.map(b => [b.x, b.y, b.z]), [[-4, 7, -3], [-3, 8, -2]]);
  assert.equal(r.blocks[0].nbt.CustomName, '完整保留');
  assert.equal(r.blocks[0].nbtTypes.children.Items.items[0].children.Count.type, 'byte');
  assert.equal(r.blocks[0].container.status, 'filled');
  assert.equal(r.blocks[0].container.items[0].count, 64);
  assert.equal(r.blocks[1].container.status, 'unknown');
});

test('multiple regions merge palettes with stable property ordering, preserve states and warn about overlaps', () => {
  const r = parseLitematic(schematic({
    a: region({ palette: [state('minecraft:oak_log', { axis: 'x', extra: 'yes' })] }),
    b: region({ position: [1, 0, 0], palette: [state('minecraft:oak_log', { extra: 'yes', axis: 'x' })] }),
    c: region({ palette: [state('minecraft:oak_log', { axis: 'y' })] }),
  }));
  assert.equal(r.palette.length, 2);
  assert.equal(r.regions.length, 3);
  assert.equal(r.counts.byName['minecraft:oak_log'], 3);
  assert.equal(r.counts.duplicatePositions, 1);
  assert.match(r.warnings.join(' '), /重叠/);
});

test('all three air variants are excluded while fluids remain visible and countable', () => {
  const r = parseLitematic(schematic({ r: region({ size: [4, 1, 1], states: [0, 1, 2, 3],
    palette: ['air', 'cave_air', 'void_air', 'water'].map(n => state(`minecraft:${n}`)) }) }));
  assert.equal(r.blocks.length, 1);
  assert.equal(r.counts.byName['minecraft:water'], 1);
});

test('containers distinguish missing data, empty, populated and deferred loot without guessing', () => {
  assert.equal(containerInfo(null, 'minecraft:chest').status, 'unknown');
  assert.equal(containerInfo({}, 'minecraft:chest').status, 'unknown');
  assert.equal(containerInfo({ Items: [] }, 'minecraft:chest').status, 'empty');
  assert.equal(containerInfo({ Items: [], LootTable: 'minecraft:chests/dungeon' }, 'minecraft:chest').status, 'loot');
  assert.equal(containerInfo({}, 'minecraft:stone'), null);
  assert.equal(containerInfo({ Items: [] }, 'minecraft:ender_chest').status, 'unknown');
  const modern = containerInfo({ Items: [{ Slot: 2, id: 'minecraft:diamond', count: 4, components: { 'minecraft:custom_name': 'Precious' } }, { Slot: 4, id: 'minecraft:air', count: 1 }] }, 'minecraft:blue_shulker_box');
  assert.equal(modern.status, 'filled'); assert.equal(modern.itemCount, 4); assert.equal(modern.occupiedSlots, 1);
  assert.equal(modern.items[0].nbt.components['minecraft:custom_name'], 'Precious');
  assert.equal(containerInfo({ components: { 'minecraft:container': [{ slot: 4, item: { id: 'minecraft:ice', count: 3 } }] } }, 'mod:box').items[0].slot, 4);
  assert.equal(containerInfo({ item: { id: 'minecraft:diamond', count: 1 } }, 'minecraft:decorated_pot').status, 'filled');
  assert.equal(containerInfo({ Book: {} }, 'minecraft:lectern').status, 'empty');
});

test('legacy version 1 TileNBT wrapper and unmatched tile entities are retained', () => {
  const r = parseLitematic(schematic({ r: region({ palette: [state('minecraft:chest')], tiles: [
    { x: int(0), y: int(0), z: int(0), TileNBT: compound({ id: str('minecraft:chest'), Items: list(10, []) }) },
    { x: int(9), y: int(9), z: int(9), TileNBT: compound({ CustomName: str('orphan') }) },
  ] }) }, 1));
  assert.equal(r.blocks[0].nbt.id, 'minecraft:chest');
  assert.equal(r.blocks[0].container.status, 'empty');
  assert.equal(r.regions[0].tileEntities[1].TileNBT.CustomName, 'orphan');
  assert.match(r.warnings.join(' '), /未匹配/);
});

test('out-of-palette block states, missing packed words and excessive dimensions are rejected', () => {
  const bad = region({ palette: [state('minecraft:stone')], states: [3] });
  assert.throws(() => parseLitematic(schematic({ r: bad })), /不存在的方块状态/);
  const missing = region({}); missing.value.BlockStates = tag(12, []);
  assert.throws(() => parseLitematic(schematic({ r: missing })), /截断/);
  assert.throws(() => parseLitematic(schematic({ r: region({ size: [32768, 32768, 32768] }) })), /上限/);
});

const userFixture = process.env.LITEMATIC_SAMPLE;
test('optional local schematic preserves metadata and accounts for its blocks and saved NBT', { skip: !userFixture || !fs.existsSync(userFixture) }, () => {
  const input = fs.readFileSync(userFixture), raw = parseNBT(input).value, r = parseLitematic(input);
  assert.equal(r.version, raw.Version);
  assert.deepEqual(r.metadata, raw.Metadata || {});
  assert.equal(r.blocks.length, r.counts.totalBlocks);
  assert.equal(r.blocks.length, Object.values(r.counts.byName).reduce((sum, n) => sum + n, 0));
  assert.equal(r.counts.totalVolume, r.regions.reduce((sum, region) => sum + region.volume, 0));
  assert.equal(r.counts.tileEntities, Object.values(raw.Regions).reduce((sum, region) => sum + (region.TileEntities?.length || 0), 0));
  assert.equal(r.counts.entities, Object.values(raw.Regions).reduce((sum, region) => sum + (region.Entities?.length || 0), 0));
  assert.ok(r.blocks.filter(block => block.nbt).length <= r.counts.tileEntities);
  for (const block of r.blocks) {
    assert.ok(r.palette[block.state]);
    assert.ok([block.x, block.y, block.z, block.localIndex].every(Number.isInteger));
  }
  assert.doesNotThrow(() => JSON.stringify(r));
});
