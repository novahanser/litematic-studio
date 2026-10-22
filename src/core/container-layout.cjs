'use strict';

const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const SIMPLE = new Set(['chest', 'trapped_chest', 'barrel', 'hopper', 'dispenser', 'dropper', 'furnace', 'blast_furnace', 'smoker',
  'brewing_stand', 'crafter', 'shulker_box', 'ender_chest', 'chiseled_bookshelf', 'decorated_pot', 'campfire', 'soul_campfire', 'jukebox', 'lectern']);
const chest = id => /^(?:minecraft:)?(?:chest|trapped_chest|(?:waxed_)?(?:(?:exposed|weathered|oxidized)_)?copper_chest)$/.test(id);
const shortName = id => String(id || '').split(':').pop();
const known = id => SIMPLE.has(shortName(id)) || shortName(id).endsWith('_shulker_box') || chest(id);
const REASONS = {
  loot: '保存了战利品表，物品尚未生成', ender: '末影箱物品属于玩家数据，不保存在方块 NBT 中',
  missing_nbt: '投影没有保存此方块的 NBT，无法判断内容', missing_inventory: 'NBT 中没有物品列表，无法确认是否为空',
  invalid_inventory: '物品记录包含无效条目，无法确认其余槽位是否为空',
};

/** Keep source entries and slot conflicts: an invalid saved stack is not empty. */
function normalizeContainer(nbt, blockName = '') {
  const data = nbt && typeof nbt === 'object' && !Array.isArray(nbt) ? nbt : null;
  const components = data?.components;
  const listKey = ['Items', 'items'].find(k => own(data, k));
  const componentField = own(components, 'minecraft:container');
  const rawList = listKey ? data[listKey] : componentField ? components['minecraft:container'] : undefined;
  const list = Array.isArray(rawList) ? rawList : null;
  const singleKey = ['Item', 'item', 'RecordItem', 'record', 'Book', 'book'].find(k => own(data, k));
  const lootTable = data?.LootTable ?? data?.loot_table ?? components?.['minecraft:container_loot']?.loot_table ?? null;
  if (!known(blockName) && rawList === undefined && !singleKey && !lootTable) return null;
  const hasInventoryField = list !== null || singleKey !== undefined;
  const items = [], invalidEntries = [], emptyEntries = [];
  if (rawList !== undefined && !list) invalidEntries.push({ kind: 'invalid_list', raw: rawList });
  const rawItems = list || (singleKey ? [data[singleKey]] : []);
  for (let index = 0; index < rawItems.length; index++) {
    const wrapper = rawItems[index];
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) { invalidEntries.push({ kind: 'invalid_item', rawIndex: index, raw: wrapper }); continue; }
    const item = wrapper.item && typeof wrapper.item === 'object' ? wrapper.item : wrapper;
    const id = item.id ?? item.Id ?? '';
    const count = Number(item.count ?? item.Count ?? (id ? 1 : 0));
    const explicitSlot = own(wrapper, 'Slot') || own(wrapper, 'slot');
    const slot = Number(wrapper.Slot ?? wrapper.slot ?? (singleKey ? 0 : index));
    if ((!id && !Object.keys(item).length) || id === 'minecraft:air' || (typeof id === 'string' && Number.isFinite(count) && count <= 0)) {
      emptyEntries.push({ rawIndex: index, slot, raw: wrapper }); continue;
    }
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(count) || count <= 0) {
      invalidEntries.push({ kind: 'invalid_item', rawIndex: index, slot, raw: wrapper }); continue;
    }
    items.push({ slot, id, count, nbt: item, rawIndex: index, slotRecorded: explicitSlot || Boolean(singleKey),
      ...(explicitSlot ? {} : { inferredSlot: !singleKey }) });
  }
  let status, reasonKey = '';
  if (shortName(blockName) === 'ender_chest') { status = 'unknown'; reasonKey = 'ender'; }
  else if (items.length) status = 'filled';
  else if (lootTable) { status = 'loot'; reasonKey = 'loot'; }
  else if (!data) { status = 'unknown'; reasonKey = 'missing_nbt'; }
  else if (invalidEntries.length) { status = 'unknown'; reasonKey = 'invalid_inventory'; }
  else if (hasInventoryField) status = 'empty';
  else { status = 'unknown'; reasonKey = 'missing_inventory'; }
  return { status, items, invalidEntries, emptyEntries, itemCount: items.reduce((sum, item) => sum + item.count, 0),
    occupiedSlots: new Set(items.map(item => item.slot)).size, lootTable, hasInventoryField, reasonKey, reason: REASONS[reasonKey] || '' };
}

function shapeFor(id, info) {
  const name = shortName(id), grid = (kind, count, columns, hasGameScreen = true) => ({ kind, count, columns, width: columns * 18, height: Math.ceil(count / columns) * 18,
    hasGameScreen, positions: Array.from({ length: count }, (_, i) => [i % columns * 18, Math.floor(i / columns) * 18]) });
  if (chest(id) || name === 'barrel' || name.endsWith('shulker_box') || name === 'ender_chest') return grid('storage', 27, 9);
  if (name === 'hopper') return grid('hopper', 5, 5);
  if (name === 'dispenser' || name === 'dropper') return grid('dispenser', 9, 3);
  if (name === 'crafter') return grid('crafter', 9, 3);
  // Coordinates are relative to the first inventory area in the locally
  // installed 1.21.11 Menu classes. Player inventory is intentionally omitted.
  if (['furnace', 'blast_furnace', 'smoker'].includes(name)) return { kind: 'furnace', count: 3, width: 108, height: 54, hasGameScreen: true,
    positions: [[18, 0], [18, 36], [78, 18]], roles: ['input', 'fuel', 'output'] };
  if (name === 'brewing_stand') return { kind: 'brewing', count: 5, width: 108, height: 60, hasGameScreen: true,
    positions: [[39, 34], [62, 41], [85, 34], [62, 0], [0, 0]], roles: ['bottle', 'bottle', 'bottle', 'ingredient', 'fuel'] };
  if (name === 'chiseled_bookshelf') return grid('bookshelf', 6, 3, false);
  if (name === 'campfire' || name === 'soul_campfire') return grid('campfire', 4, 2, false);
  if (['decorated_pot', 'jukebox', 'lectern'].includes(name)) return grid(name, 1, 1, false);
  const valid = info?.items?.map(x => x.slot).filter(x => Number.isSafeInteger(x) && x >= 0 && x < 256) || [];
  const count = Math.max(1, Math.min(256, Math.max(-1, ...valid) + 1));
  return { ...grid('generic', count, Math.min(9, count), false), inferredCapacity: true };
}

const CLOCKWISE = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] };
const positionKey = b => JSON.stringify([b.region, b.x, b.y, b.z]);
function connectedPosition(block, properties) {
  const step = CLOCKWISE[properties.facing];
  if (!step || !['left', 'right'].includes(properties.type)) return null;
  const sign = properties.type === 'left' ? 1 : -1;
  return { ...block, x: block.x + step[0] * sign, z: block.z + step[1] * sign };
}

function buildContainerLayout(schematic, index, positionIndex) {
  const block = schematic.blocks?.[index], state = schematic.palette?.[block?.state];
  if (!block || !state) return null;
  const info = block.container || normalizeContainer(block.nbt, state.Name);
  if (!info) return null;
  const props = state.Properties || {}, shape = shapeFor(state.Name, info), flags = [], indices = [index];
  if (chest(state.Name) && ['left', 'right'].includes(props.type)) {
    const map = positionIndex || new Map();
    if (!positionIndex) schematic.blocks.forEach((b, i) => { const key = positionKey(b); map.set(key, [...(map.get(key) || []), i]); });
    const target = connectedPosition(block, props), candidates = target ? map.get(positionKey(target)) || [] : [];
    const ownCandidates = map.get(positionKey(block)) || [];
    const partnerIndex = candidates.length === 1 && ownCandidates.length === 1 ? candidates[0] : undefined;
    const partner = schematic.blocks[partnerIndex], partnerState = partner && schematic.palette[partner.state], p = partnerState?.Properties || {};
    const reverse = partner && connectedPosition(partner, p);
    if (partner && partnerState.Name === state.Name && p.facing === props.facing && p.type !== props.type && ['left', 'right'].includes(p.type) &&
        reverse && reverse.x === block.x && reverse.y === block.y && reverse.z === block.z && reverse.region === block.region) {
      // Vanilla ChestBlock maps RIGHT to DoubleBlockCombiner.FIRST. Therefore
      // top slots 0..26 are RIGHT and bottom slots 27..53 are LEFT, at every yaw.
      indices.splice(0, 1, ...(props.type === 'right' ? [index, partnerIndex] : [partnerIndex, index]));
      shape.kind = 'double_chest'; shape.count = 54; shape.height = 108;
      shape.positions = Array.from({ length: 54 }, (_, i) => [i % 9 * 18, Math.floor(i / 9) * 18]);
    } else flags.push({ key: ownCandidates.length > 1 || candidates.length > 1 ? 'ambiguous_partner' : 'missing_partner' });
  }
  const slots = [], sources = [], anomalies = [];
  for (const [sourceOrder, sourceIndex] of indices.entries()) {
    const sourceBlock = schematic.blocks[sourceIndex], sourceState = schematic.palette[sourceBlock.state];
    const sourceInfo = sourceBlock.container || normalizeContainer(sourceBlock.nbt, sourceState.Name);
    const offset = sourceOrder * 27, count = indices.length > 1 ? 27 : shape.count;
    const disabled = new Set(Array.isArray(sourceBlock.nbt?.disabled_slots) ? sourceBlock.nbt.disabled_slots.map(Number) : []);
    const recordedItems = sourceInfo.items || [];
    const reliableSlots = recordedItems.every(item => !item.inferredSlot && Number.isSafeInteger(item.slot) && item.slot >= 0 && item.slot < count) &&
      new Set(recordedItems.map(item => item.slot)).size === recordedItems.length;
    const confirmed = Boolean(sourceInfo.hasInventoryField && !sourceInfo.invalidEntries?.length && reliableSlots && !sourceInfo.lootTable && sourceInfo.reasonKey !== 'ender');
    sources.push({ index: sourceIndex, name: sourceState.Name, region: sourceBlock.region, position: { x: sourceBlock.x, y: sourceBlock.y, z: sourceBlock.z },
      half: sourceState.Properties?.type || null, offset, status: sourceInfo.status, reasonKey: sourceInfo.reasonKey || '', lootTable: sourceInfo.lootTable || null,
      itemCount: sourceInfo.itemCount || 0, hasInventoryField: sourceInfo.hasInventoryField });
    for (let local = 0; local < count; local++) {
      const global = offset + local, pos = shape.positions[global];
      slots.push({ index: global, sourceIndex, sourceSlot: local, x: pos[0], y: pos[1], role: shape.roles?.[local] || '',
        disabled: shape.kind === 'crafter' && disabled.has(local), items: [], status: sourceInfo.lootTable ? 'loot' : confirmed ? 'empty' : 'unknown' });
    }
    for (const item of sourceInfo.items || []) {
      if (!Number.isSafeInteger(item.slot) || item.slot < 0 || item.slot >= count) {
        anomalies.push({ kind: 'out_of_range', sourceIndex, slot: item.slot, item }); continue;
      }
      if (item.inferredSlot) anomalies.push({ kind: 'missing_slot', sourceIndex, slot: item.slot, item });
      const slot = slots[offset + item.slot]; slot.items.push(item); slot.status = slot.items.length > 1 ? 'conflict' : 'filled';
      if (slot.items.length === 2) anomalies.push({ kind: 'duplicate_slot', sourceIndex, slot: item.slot, index: slot.index });
      if (slot.disabled) anomalies.push({ kind: 'disabled_occupied', sourceIndex, slot: item.slot, item });
    }
    for (const invalid of sourceInfo.invalidEntries || []) anomalies.push({ ...invalid, sourceIndex });
    if (sourceInfo.lootTable) flags.push({ key: 'loot', sourceIndex });
  }
  const statuses = new Set(sources.map(s => s.status));
  const status = statuses.size === 1 ? sources[0].status : 'mixed';
  return { ...shape, positions: undefined, slots, sources, selectedBlockIndex: index, flags, anomalies, status,
    complete: slots.every(s => !['unknown', 'loot', 'conflict'].includes(s.status)) && !anomalies.length,
    itemCount: sources.reduce((sum, s) => sum + s.itemCount, 0), occupiedSlots: slots.filter(s => s.items.length).length };
}

function buildContainerLayouts(schematic) {
  const positions = new Map(), layouts = Object.create(null);
  schematic.blocks.forEach((block, index) => { const key = positionKey(block); positions.set(key, [...(positions.get(key) || []), index]); });
  schematic.blocks.forEach((block, index) => {
    if (!block.container) return;
    const layout = buildContainerLayout(schematic, index, positions); if (layout) layouts[index] = layout;
  });
  return layouts;
}

module.exports = { normalizeContainer, buildContainerLayout, buildContainerLayouts, shapeFor, connectedPosition };
