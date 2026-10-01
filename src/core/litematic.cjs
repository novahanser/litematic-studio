'use strict';

const zlib = require('node:zlib');

const TAG_NAMES = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byte_array', 'string', 'list', 'compound', 'int_array', 'long_array'];
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_VOLUME = 32 * 1024 * 1024;
const own = (o, key) => o != null && Object.hasOwn(o, key);
const record = () => Object.create(null);

// Java NBT uses DataInput.readUTF (modified UTF-8), including encoded NUL and
// surrogate pairs. Decode it without losing unusual names or NBT string values.
function readModifiedUTF8(bytes) {
  const units = [];
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i++];
    if (c < 128) units.push(c);
    else if ((c & 0xe0) === 0xc0) {
      if (i >= bytes.length || (bytes[i] & 0xc0) !== 0x80) throw new Error('NBT 字符串 UTF-8 数据无效');
      units.push(((c & 31) << 6) | (bytes[i++] & 63));
    } else if ((c & 0xf0) === 0xe0) {
      if (i + 1 >= bytes.length || (bytes[i] & 0xc0) !== 0x80 || (bytes[i + 1] & 0xc0) !== 0x80) throw new Error('NBT 字符串 UTF-8 数据无效');
      units.push(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else if ((c & 0xf8) === 0xf0) {
      // Accept standard UTF-8 too: several third-party schematic writers use it.
      if (i + 2 >= bytes.length || [bytes[i], bytes[i + 1], bytes[i + 2]].some(b => (b & 0xc0) !== 0x80)) throw new Error('NBT 字符串 UTF-8 数据无效');
      const cp = ((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      if (cp < 0x10000 || cp > 0x10ffff) throw new Error('NBT 字符串 Unicode 数据无效');
      units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 1023));
    } else throw new Error('NBT 字符串 UTF-8 数据无效');
  }
  let result = '';
  for (let i = 0; i < units.length; i += 8192) result += String.fromCharCode(...units.slice(i, i + 8192));
  return result;
}

/** Read Java big-endian NBT. All values are JSON-safe; TAG_Long values are decimal strings.
 * Returns {name, value, types, compression, bytesRead}. `types` preserves every tag's type,
 * including empty-list element types and byte/int/long array types.
 */
function parseNBT(input) {
  if (!Buffer.isBuffer(input)) input = Buffer.from(input);
  if (!input.length) throw new Error('文件为空');
  if (input.length > MAX_BYTES) throw new Error('NBT 文件超过 512 MB 限制');
  let buffer = input, compression = 'none';
  try {
    if (input[0] === 0x1f && input[1] === 0x8b) {
      buffer = zlib.gunzipSync(input, { maxOutputLength: MAX_BYTES }); compression = 'gzip';
    } else if (input.length >= 2 && (input[0] & 15) === 8 && ((input[0] << 8) + input[1]) % 31 === 0) {
      buffer = zlib.inflateSync(input, { maxOutputLength: MAX_BYTES }); compression = 'zlib';
    }
  } catch (error) { throw new Error(`NBT 解压失败：${error.message}`); }
  let offset = 0, nodes = 0;
  function need(n) {
    if (!Number.isSafeInteger(n) || n < 0 || offset + n > buffer.length) throw new Error(`NBT 数据被截断（偏移 ${offset}）`);
  }
  function number(method, n) { need(n); const value = buffer[method](offset); offset += n; return value; }
  function string() {
    const n = number('readUInt16BE', 2); need(n);
    const value = readModifiedUTF8(buffer.subarray(offset, offset + n)); offset += n; return value;
  }
  function length(width = 1) {
    const n = number('readInt32BE', 4);
    if (n < 0 || n > MAX_VOLUME * 4) throw new Error(`NBT 数组长度无效：${n}`);
    need(n * width); return n;
  }
  function payload(type, depth) {
    if (type < 1 || type > 12) throw new Error(`不支持的 NBT 标签类型：${type}`);
    if (depth > 128) throw new Error('NBT 嵌套超过 128 层');
    if (++nodes > 10_000_000) throw new Error('NBT 标签数量超过限制');
    const types = { type: TAG_NAMES[type] };
    let value;
    switch (type) {
      case 1: value = number('readInt8', 1); break;
      case 2: value = number('readInt16BE', 2); break;
      case 3: value = number('readInt32BE', 4); break;
      case 4: value = number('readBigInt64BE', 8).toString(); break;
      case 5: value = number('readFloatBE', 4); break;
      case 6: value = number('readDoubleBE', 8); break;
      case 7: {
        const n = length(); value = new Array(n);
        for (let i = 0; i < n; i++) value[i] = buffer.readInt8(offset++);
        break;
      }
      case 8: value = string(); break;
      case 9: {
        const subtype = number('readUInt8', 1), n = length();
        if (subtype > 12 || (subtype === 0 && n > 0)) throw new Error('NBT 列表元素类型无效');
        value = new Array(n); types.elementType = TAG_NAMES[subtype]; types.items = new Array(n);
        for (let i = 0; i < n; i++) { const child = payload(subtype, depth + 1); value[i] = child.value; types.items[i] = child.types; }
        break;
      }
      case 10: {
        value = record(); types.children = record();
        for (;;) {
          const subtype = number('readUInt8', 1); if (subtype === 0) break;
          const name = string(), child = payload(subtype, depth + 1);
          value[name] = child.value; types.children[name] = child.types;
        }
        break;
      }
      case 11: {
        const n = length(4); value = new Array(n);
        for (let i = 0; i < n; i++) value[i] = number('readInt32BE', 4);
        break;
      }
      case 12: {
        const n = length(8); value = new Array(n);
        for (let i = 0; i < n; i++) value[i] = number('readBigInt64BE', 8).toString();
        break;
      }
    }
    if (typeof value === 'number' && !Number.isFinite(value)) value = String(value);
    return { value, types };
  }
  const type = number('readUInt8', 1);
  if (type !== 10) throw new Error('NBT 根标签必须是 Compound（Java 版投影文件）');
  const name = string(), root = payload(type, 0);
  return { name, ...root, compression, bytesRead: offset };
}

const CONTAINERS = new Set([
  'chest', 'trapped_chest', 'barrel', 'hopper', 'dispenser', 'dropper', 'furnace',
  'blast_furnace', 'smoker', 'brewing_stand', 'crafter', 'shulker_box', 'ender_chest',
  'chiseled_bookshelf', 'decorated_pot', 'campfire', 'soul_campfire', 'jukebox', 'lectern',
]);

/** Inventory information is a statement about the saved NBT, never a live server inventory. */
function containerInfo(nbt, blockName = '') {
  const short = blockName.split(':').pop();
  const known = CONTAINERS.has(short) || short.endsWith('_shulker_box');
  const data = nbt && typeof nbt === 'object' ? nbt : null;
  const components = data?.components;
  const list = Array.isArray(data?.Items) ? data.Items : Array.isArray(data?.items) ? data.items :
    Array.isArray(components?.['minecraft:container']) ? components['minecraft:container'] : null;
  const singleKey = ['Item', 'item', 'RecordItem', 'Book', 'book'].find(key => own(data, key));
  if (!known && !list && !singleKey && !own(data, 'LootTable') && !own(data, 'loot_table')) return null;
  const items = [];
  const rawItems = list || (singleKey ? [data[singleKey]] : []);
  for (let i = 0; i < rawItems.length; i++) {
    const wrapper = rawItems[i];
    if (!wrapper || typeof wrapper !== 'object') continue;
    const item = wrapper.item && typeof wrapper.item === 'object' ? wrapper.item : wrapper;
    const id = item.id ?? item.Id ?? '';
    const count = Number(item.count ?? item.Count ?? (id ? 1 : 0));
    if (!id || id === 'minecraft:air' || !(count > 0)) continue;
    items.push({ slot: Number(wrapper.Slot ?? wrapper.slot ?? i), id: String(id), count, nbt: item });
  }
  const lootTable = data?.LootTable ?? data?.loot_table ?? null;
  const hasInventoryField = list !== null || singleKey !== undefined;
  let status, reason = '';
  if (items.length) status = 'filled';
  else if (lootTable) { status = 'loot'; reason = '保存了战利品表，物品尚未生成'; }
  else if (short === 'ender_chest') { status = 'unknown'; reason = '末影箱物品属于玩家数据，不保存在方块 NBT 中'; }
  else if (!data) { status = 'unknown'; reason = '投影没有保存此方块的 NBT，无法判断内容'; }
  else if (hasInventoryField) status = 'empty';
  else { status = 'unknown'; reason = 'NBT 中没有物品列表，无法确认是否为空'; }
  return { status, items, itemCount: items.reduce((sum, item) => sum + item.count, 0),
    occupiedSlots: items.length, lootTable, hasInventoryField, reason };
}

function vector(value, label) {
  if (!value || ['x', 'y', 'z'].some(axis => !Number.isSafeInteger(value[axis]))) throw new Error(`${label} 坐标无效`);
  return { x: value.x, y: value.y, z: value.z };
}

/**
 * Geometry matches the supplied Litematica 0.25.4 jar:
 * - LitematicaBlockStateContainer.getIndex: y * sizeX * sizeZ + z * sizeX + x.
 * - LitematicaBitArray.getAt: uninterrupted bit stream crossing 64-bit words.
 * - takeBlocksFromWorld: both states and tile entities are relative to the MIN corner.
 *   Region Position remains selection pos1; negative Size moves the min by size + 1.
 * Upstream: https://github.com/sakura-ryoko/litematica/blob/1.21.11/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java
 */
function parseLitematic(buffer, { fileName = '' } = {}) {
  const parsed = parseNBT(buffer), root = parsed.value;
  if (!root.Regions || typeof root.Regions !== 'object' || Array.isArray(root.Regions)) throw new Error('不是有效的 .litematic 文件：缺少 Regions');
  const version = Number(root.Version);
  if (!Number.isInteger(version) || version < 1) throw new Error('投影格式版本无效');
  const warnings = [];
  if (version > 7) warnings.push(`文件格式版本 ${version} 高于已验证的版本 7，部分字段可能不被识别。`);
  const palette = [], paletteMap = new Map(), blocks = [], entities = [], regions = [], byName = record();
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let totalVolume = 0, orphanTileEntities = 0, tileEntityCount = 0, duplicatePositions = 0;
  const positions = new Set();
  const regionTypes = parsed.types.children.Regions?.children || {};
  for (const [name, region] of Object.entries(root.Regions)) {
    const position = vector(region.Position, `${name}.Position`), size = vector(region.Size, `${name}.Size`);
    const dimensions = { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) };
    const volume = dimensions.x * dimensions.y * dimensions.z;
    totalVolume += volume;
    if (!Number.isSafeInteger(volume) || volume < 1 || totalVolume > MAX_VOLUME) throw new Error(`投影体积无效或超过 ${MAX_VOLUME.toLocaleString()} 个位置的上限`);
    const origin = {};
    for (const axis of ['x', 'y', 'z']) {
      origin[axis] = position[axis] + (size[axis] < 0 ? size[axis] + 1 : 0);
      min[axis] = Math.min(min[axis], origin[axis]);
      max[axis] = Math.max(max[axis], origin[axis] + dimensions[axis] - 1);
    }
    regions.push({ name, position, size, min: origin, dimensions, volume });
    const localPalette = region.BlockStatePalette;
    if (!Array.isArray(localPalette) || !localPalette.length) throw new Error(`区域 ${name} 缺少方块调色板`);
    const localToGlobal = localPalette.map(entry => {
      if (!entry || typeof entry.Name !== 'string') throw new Error(`区域 ${name} 的方块名称无效`);
      const properties = record();
      for (const key of Object.keys(entry.Properties || {}).sort()) properties[key] = String(entry.Properties[key]);
      const state = { Name: entry.Name, Properties: properties }, key = JSON.stringify(state);
      if (!paletteMap.has(key)) { paletteMap.set(key, palette.length); palette.push(state); }
      return paletteMap.get(key);
    });
    const bits = Math.max(2, Math.ceil(Math.log2(localPalette.length)));
    const words = region.BlockStates;
    if (!Array.isArray(words) || words.length < Math.ceil(volume * bits / 64)) throw new Error(`区域 ${name} 的 BlockStates 数据被截断`);
    const packed = words.map(word => BigInt.asUintN(64, BigInt(word))), mask = (1n << BigInt(bits)) - 1n;
    const tiles = new Map(), tileList = region.TileEntities || [], tileTypes = regionTypes[name]?.children?.TileEntities?.items || [];
    for (let i = 0; i < tileList.length; i++) {
      const entry = tileList[i], nbt = version === 1 && entry.TileNBT ? entry.TileNBT : entry;
      const coord = entry;
      if (!coord || ['x', 'y', 'z'].some(axis => !Number.isInteger(coord[axis]))) { warnings.push(`区域 ${name} 有一个无法定位的方块 NBT，已保留在区域数据中。`); orphanTileEntities++; continue; }
      const key = `${coord.x},${coord.y},${coord.z}`;
      tiles.set(key, { nbt, types: version === 1 && entry.TileNBT ? tileTypes[i]?.children?.TileNBT : tileTypes[i] });
    }
    let regionBlockCount = 0;
    for (let index = 0; index < volume; index++) {
      const bit = index * bits, wordIndex = Math.floor(bit / 64), shift = bit % 64;
      let value = packed[wordIndex] >> BigInt(shift);
      if (shift + bits > 64) value |= packed[wordIndex + 1] << BigInt(64 - shift);
      const localState = Number(value & mask);
      if (localState >= localPalette.length) throw new Error(`区域 ${name} 位置 ${index} 引用了不存在的方块状态 ${localState}`);
      const state = localToGlobal[localState], blockName = palette[state].Name;
      if (AIR.has(blockName)) continue;
      const x = index % dimensions.x, y = Math.floor(index / (dimensions.x * dimensions.z)), z = Math.floor(index / dimensions.x) % dimensions.z;
      const key = `${x},${y},${z}`, tile = tiles.get(key);
      if (tile) { tiles.delete(key); tileEntityCount++; }
      const block = { x: origin.x + x, y: origin.y + y, z: origin.z + z, state, region: name, localIndex: index,
        nbt: tile?.nbt || null, nbtTypes: tile?.types || null, container: containerInfo(tile?.nbt, blockName) };
      const worldKey = `${block.x},${block.y},${block.z}`;
      if (positions.has(worldKey)) duplicatePositions++;
      positions.add(worldKey);
      blocks.push(block); regionBlockCount++; byName[blockName] = (byName[blockName] || 0) + 1;
    }
    orphanTileEntities += tiles.size;
    regions[regions.length - 1].blockCount = regionBlockCount;
    // Keep every block-entity payload, including unmatched entries, without discarding NBT.
    regions[regions.length - 1].tileEntities = tileList;
    regions[regions.length - 1].tileEntityTypes = tileTypes;
    const entityList = Array.isArray(region.Entities) ? region.Entities : [];
    const entityTypes = regionTypes[name]?.children?.Entities?.items || [];
    for (let i = 0; i < entityList.length; i++) {
      const entry = entityList[i], legacy = version === 1 && entry?.EntityData;
      const nbt = legacy || entry, nbtTypes = legacy ? entityTypes[i]?.children?.EntityData : entityTypes[i];
      const pos = legacy ? [entry.x, entry.y, entry.z] : nbt?.Pos;
      const valid = Array.isArray(pos) && pos.length >= 3 && pos.slice(0, 3).every(Number.isFinite);
      const localPosition = valid ? { x: pos[0], y: pos[1], z: pos[2] } : null;
      // Unlike blocks / block entities, ordinary entities are relative to pos1,
      // NOT the minimum corner. This matters for regions with negative Size.
      const entityPosition = valid ? { x: position.x + pos[0], y: position.y + pos[1], z: position.z + pos[2] } : null;
      const rotation = Array.isArray(nbt?.Rotation) && nbt.Rotation.length >= 2 && nbt.Rotation.slice(0, 2).every(Number.isFinite)
        ? nbt.Rotation.slice(0, 2) : [0, 0];
      entities.push({ id: typeof nbt?.id === 'string' ? nbt.id : 'unknown', position: entityPosition,
        localPosition, rotation, region: name, localIndex: i, nbt, nbtTypes: nbtTypes || null });
      if (!valid) warnings.push(`区域 ${name} 的实体 ${i + 1} 缺少有效 Pos，已保留 NBT，无法定位预览。`);
    }
    regions[regions.length - 1].entityCount = entityList.length;
  }
  if (!regions.length) throw new Error('投影不包含任何区域');
  if (orphanTileEntities) warnings.push(`${orphanTileEntities} 个方块 NBT 未匹配到非空气方块，已保留在区域原始数据中。`);
  if (duplicatePositions) warnings.push(`区域存在 ${duplicatePositions} 个重叠方块；材料数量按各区域分别统计。`);
  const unknownContainers = blocks.filter(block => block.container?.status === 'unknown').length;
  if (unknownContainers) warnings.push(`${unknownContainers} 个容器缺少可确认的物品列表；“未知”不代表空容器。`);
  return { fileName, metadata: root.Metadata || {}, version, subVersion: root.SubVersion ?? null,
    minecraftDataVersion: root.MinecraftDataVersion ?? null, regions, palette, blocks, entities,
    bounds: { min, max }, counts: { totalBlocks: blocks.length, byName, totalVolume, tileEntities: tileEntityCount,
      containers: blocks.filter(block => block.container).length, entities: entities.length, duplicatePositions }, warnings,
    nbtInfo: { compression: parsed.compression, rootName: parsed.name, longEncoding: 'decimal-string',
      note: 'nbt 为完整保存的方块实体 NBT；nbtTypes 保存类型。容器内容仅反映投影文件。' } };
}

module.exports = { parseNBT, parseLitematic, containerInfo };
