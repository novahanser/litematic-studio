'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContainer, buildContainerLayout, buildContainerLayouts, shapeFor } = require('../src/core/container-layout.cjs');
const stack = (Slot, id = 'minecraft:diamond', Count = 1) => ({ Slot, id, Count });
function schematic(entries) {
  return { palette: entries.map(e => ({ Name: e.name || 'minecraft:chest', Properties: e.properties || {} })), blocks: entries.map((e, state) => ({
    x: e.x || 0, y: e.y || 0, z: e.z || 0, region: e.region || 'main', state, nbt: e.nbt ?? null,
    container: normalizeContainer(e.nbt ?? null, e.name || 'minecraft:chest'),
  })) };
}

test('normalization preserves component stacks, duplicate slots, malformed records and unrecorded states', () => {
  assert.equal(normalizeContainer(null, 'minecraft:waxed_oxidized_copper_chest').status, 'unknown');
  assert.equal(normalizeContainer({ Items: [] }, 'minecraft:chest').status, 'empty');
  assert.equal(normalizeContainer({ Items: [] }, 'minecraft:ender_chest').status, 'unknown');
  assert.equal(normalizeContainer({ Items: {} }, 'minecraft:hopper').status, 'unknown');
  assert.equal(normalizeContainer({ Items: [null, { id: 'minecraft:stone', count: 'NaN' }] }, 'minecraft:hopper').invalidEntries.length, 2);
  const data = normalizeContainer({ components: { 'minecraft:container': [{ slot: 2, item: { id: 'minecraft:ice', count: 4, components: { test: '<raw>' } } },
    { slot: 2, item: { id: 'minecraft:diamond', count: 9 } }] } }, 'mod:container');
  assert.equal(data.items.length, 2); assert.equal(data.occupiedSlots, 1); assert.equal(data.itemCount, 13);
  assert.equal(data.items[0].nbt.components.test, '<raw>'); assert.equal(data.items[0].slotRecorded, true);
  assert.equal(normalizeContainer({ Items: [], LootTable: 'minecraft:chests/test' }, 'minecraft:chest').status, 'loot');
});

test('all four chest directions use right-first inventory order and exact same-region adjacency', () => {
  const clockwise = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] };
  for (const [facing, [dx, dz]] of Object.entries(clockwise)) {
    const data = schematic([{ x: 7, z: -5, properties: { facing, type: 'left' }, nbt: { Items: [stack(0, 'minecraft:gold_ingot', 2)] } },
      { x: 7 + dx, z: -5 + dz, properties: { facing, type: 'right' }, nbt: { Items: [stack(26, 'minecraft:diamond', 7)] } }]);
    const fromLeft = buildContainerLayout(data, 0), fromRight = buildContainerLayout(data, 1);
    assert.equal(fromLeft.slots.length, 54, facing); assert.equal(fromLeft.kind, 'double_chest');
    assert.deepEqual(fromLeft.sources.map(s => s.index), [1, 0]); assert.equal(fromLeft.slots[26].items[0].id, 'minecraft:diamond');
    assert.equal(fromLeft.slots[27].items[0].id, 'minecraft:gold_ingot'); assert.equal(fromLeft.itemCount, 9);
    assert.deepEqual(fromLeft.slots, fromRight.slots); assert.deepEqual(fromLeft.sources, fromRight.sources);
    data.blocks[1].region = 'other'; assert.equal(buildContainerLayout(data, 0).slots.length, 27);
    assert.equal(buildContainerLayout(data, 0).flags[0].key, 'missing_partner');
  }
});

test('overlap, unrelated container, reversed connection and differing facing do not create false double chests', () => {
  const left = { properties: { type: 'left', facing: 'north' }, nbt: { Items: [] } };
  for (const other of [
    { x: 1, name: 'minecraft:trapped_chest', properties: { type: 'right', facing: 'north' } },
    { x: -1, properties: { type: 'right', facing: 'north' } },
    { x: 1, properties: { type: 'right', facing: 'south' } },
    { x: 1, properties: { type: 'left', facing: 'north' } },
  ]) assert.equal(buildContainerLayout(schematic([left, other]), 0).kind, 'storage');
  const overlap = schematic([left, { x: 1, properties: { type: 'right', facing: 'north' } }, { x: 1, properties: { type: 'right', facing: 'north' } }]);
  assert.equal(buildContainerLayout(overlap, 0).flags[0].key, 'ambiguous_partner');
});

test('double chest with unrecorded or loot half keeps that entire half unknown', () => {
  const data = schematic([{ properties: { facing: 'north', type: 'right' }, nbt: { Items: [stack(0)] } },
    { x: -1, properties: { facing: 'north', type: 'left' } }]);
  let layout = buildContainerLayout(data, 0);
  assert.equal(layout.status, 'mixed'); assert.equal(layout.complete, false);
  assert(layout.slots.slice(27).every(s => s.status === 'unknown'));
  data.blocks[1].nbt = { LootTable: 'minecraft:chests/simple_dungeon' };
  data.blocks[1].container = normalizeContainer(data.blocks[1].nbt, 'minecraft:chest');
  layout = buildContainerLayout(data, 0); assert(layout.slots.slice(27).every(s => s.status === 'loot')); assert(layout.flags.some(f => f.key === 'loot'));
});

test('container layouts follow native menu slot indices and storage-only blocks have no invented game screen', () => {
  assert.equal(shapeFor('minecraft:barrel').count, 27); assert.equal(shapeFor('minecraft:red_shulker_box').count, 27);
  assert.equal(shapeFor('minecraft:hopper').count, 5); assert.equal(shapeFor('minecraft:dispenser').columns, 3);
  const furnace = shapeFor('minecraft:blast_furnace');
  assert.deepEqual(furnace.roles, ['input', 'fuel', 'output']); assert.deepEqual(furnace.positions, [[18, 0], [18, 36], [78, 18]]);
  const brew = shapeFor('minecraft:brewing_stand'); assert.deepEqual(brew.roles, ['bottle', 'bottle', 'bottle', 'ingredient', 'fuel']);
  assert.deepEqual(brew.positions[1], [62, 41]); assert.deepEqual(brew.positions[4], [0, 0]);
  for (const [name, count] of [['decorated_pot', 1], ['lectern', 1], ['jukebox', 1], ['campfire', 4], ['chiseled_bookshelf', 6]]) {
    const shape = shapeFor(`minecraft:${name}`); assert.equal(shape.count, count); assert.equal(shape.hasGameScreen, false);
  }
});

test('disabled crafter slots and anomalous slot records remain visible without overwriting another stack', () => {
  const data = schematic([{ name: 'minecraft:crafter', nbt: { disabled_slots: [0, 8], Items: [stack(0), stack(0, 'minecraft:ice', 64), stack(99), stack(-1), stack(1.5), { id: 'minecraft:coal', count: 7 }, null] } }]);
  const layout = buildContainerLayout(data, 0);
  assert.equal(layout.slots.length, 9); assert.equal(layout.slots[0].items.length, 2); assert.equal(layout.slots[0].status, 'conflict');
  assert.equal(layout.slots[0].disabled, true); assert.equal(layout.slots[8].disabled, true); assert.equal(layout.slots[1].disabled, false);
  assert.equal(layout.slots[1].status, 'unknown'); assert.equal(layout.slots[8].status, 'unknown');
  assert.equal(layout.itemCount, 75); assert.equal(layout.anomalies.filter(a => a.kind === 'out_of_range').length, 3);
  assert.equal(layout.anomalies.filter(a => a.kind === 'duplicate_slot').length, 1);
  assert.equal(layout.anomalies.filter(a => a.kind === 'missing_slot').length, 1);
  assert.equal(layout.anomalies.filter(a => a.kind === 'invalid_item').length, 1); assert.equal(layout.complete, false);
});

test('missing, invalid and duplicate slot indices cannot confirm unused slots are empty', () => {
  for (const Items of [[{id:'minecraft:diamond',count:2}], [stack(99)], [stack(1),stack(1)]]) {
    const layout=buildContainerLayout(schematic([{name:'minecraft:barrel',nbt:{Items}}]),0);
    assert.equal(layout.slots[26].status,'unknown'); assert.equal(layout.complete,false);
  }
});

test('all-container index preserves block indices and does not mutate source NBT', () => {
  const data = schematic([{ name: 'minecraft:stone' }, { name: 'minecraft:decorated_pot', nbt: { item: { id: 'minecraft:emerald', count: 4 } } }]);
  const before = JSON.stringify(data), layouts = buildContainerLayouts(data);
  assert.deepEqual(Object.keys(layouts), ['1']); assert.equal(layouts[1].slots[0].items[0].count, 4); assert.equal(JSON.stringify(data), before);
});

test('nonstandard saved Items on an ender chest never claim to be the player inventory', () => {
  const data = schematic([{ name: 'minecraft:ender_chest', nbt: { Items: [stack(0, 'minecraft:diamond', 3)] } }]);
  const layout = buildContainerLayout(data, 0);
  assert.equal(layout.status, 'unknown'); assert.equal(layout.sources[0].reasonKey, 'ender');
  assert.equal(layout.slots[0].items[0].id, 'minecraft:diamond');
  assert(layout.slots.slice(1).every(slot => slot.status === 'unknown')); assert.equal(layout.complete, false);
});
