'use strict';

const zlib = require('node:zlib');
const { parseNBT, parseLitematic } = require('./litematic.cjs');
const TYPES = ['end', 'byte', 'short', 'int', 'long', 'float', 'double', 'byte_array', 'string', 'list', 'compound', 'int_array', 'long_array'];
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
const MAX_BYTES = 512 * 1024 * 1024;

function modifiedUTF8(value) {
  if (typeof value !== 'string') throw new Error('NBT 字符串值无效');
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c > 0 && c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    if (bytes.length > 65535) throw new Error('NBT 字符串编码长度超过 65535 字节');
  }
  const result = Buffer.allocUnsafe(bytes.length + 2);
  result.writeUInt16BE(bytes.length); result.set(bytes, 2);
  return result;
}

/** Serialize the complete typed tree returned by parseNBT. No field/type guessing. */
function writeNBT(document, compression = document.compression || 'gzip') {
  if (document.types?.type !== 'compound') throw new Error('NBT 根标签必须是 Compound');
  const chunks = []; let size = 0, nodes = 0;
  const add = chunk => {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('NBT 文件超过 512 MB 限制');
    chunks.push(chunk);
  };
  function number(method, value, width) { const b = Buffer.allocUnsafe(width); b[method](value); add(b); }
  function integer(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`NBT 整数超出范围：${value}`);
    return value;
  }
  function long(value) {
    if (typeof value !== 'bigint' && !(typeof value === 'string' && /^-?\d+$/.test(value)) && !Number.isSafeInteger(value)) throw new Error('NBT Long 必须为整数或十进制字符串');
    const n = BigInt(value);
    if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error('NBT Long 超出 64 位范围');
    return n;
  }
  function floating(value) {
    if (typeof value === 'number') return value;
    if (['NaN', 'Infinity', '-Infinity'].includes(value)) return Number(value);
    throw new Error('NBT 浮点数值无效');
  }
  function payload(value, types, depth = 0) {
    if (depth > 128 || ++nodes > 10_000_000) throw new Error('NBT 嵌套或标签数量超过限制');
    const id = TYPES.indexOf(types?.type);
    if (id < 1) throw new Error('NBT 标签缺少有效的类型信息');
    switch (id) {
      case 1: number('writeInt8', integer(value, -128, 127), 1); break;
      case 2: number('writeInt16BE', integer(value, -32768, 32767), 2); break;
      case 3: number('writeInt32BE', integer(value, -2147483648, 2147483647), 4); break;
      case 4: number('writeBigInt64BE', long(value), 8); break;
      case 5: number('writeFloatBE', floating(value), 4); break;
      case 6: number('writeDoubleBE', floating(value), 8); break;
      case 8: add(modifiedUTF8(value)); break;
      case 10:
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NBT Compound 值无效');
        for (const [key, child] of Object.entries(value)) {
          const childType = types.children?.[key], childId = TYPES.indexOf(childType?.type);
          if (childId < 1) throw new Error(`NBT 字段 ${key} 缺少类型信息`);
          add(Buffer.from([childId])); add(modifiedUTF8(key)); payload(child, childType, depth + 1);
        }
        add(Buffer.from([0])); break;
      case 9: {
        if (!Array.isArray(value)) throw new Error('NBT List 值无效');
        const elementId = TYPES.indexOf(types.elementType);
        if (elementId < 0 || (elementId === 0 && value.length)) throw new Error('NBT 列表元素类型无效');
        add(Buffer.from([elementId])); number('writeInt32BE', value.length, 4);
        value.forEach((item, i) => {
          const childType = types.items?.[i];
          if (childType?.type !== types.elementType) throw new Error(`NBT 列表第 ${i} 项的类型不匹配`);
          payload(item, childType, depth + 1);
        }); break;
      }
      case 7: case 11: case 12: {
        if (!Array.isArray(value)) throw new Error('NBT 数组值无效');
        const width = id === 7 ? 1 : id === 11 ? 4 : 8;
        if (value.length * width + size > MAX_BYTES) throw new Error('NBT 数组超过文件大小上限');
        number('writeInt32BE', value.length, 4);
        const data = Buffer.allocUnsafe(value.length * width);
        value.forEach((item, i) => {
          if (id === 7) data.writeInt8(integer(item, -128, 127), i);
          else if (id === 11) data.writeInt32BE(integer(item, -2147483648, 2147483647), i * 4);
          else data.writeBigInt64BE(long(item), i * 8);
        });
        add(data); break;
      }
    }
  }
  add(Buffer.from([10])); add(modifiedUTF8(document.name ?? '')); payload(document.value, document.types);
  const raw = Buffer.concat(chunks, size);
  if (compression === 'none') return raw;
  if (compression === 'gzip') return zlib.gzipSync(raw);
  if (compression === 'zlib') return zlib.deflateSync(raw);
  throw new Error(`不支持的 NBT 压缩格式：${compression}`);
}

function stateKey(state) {
  const properties = Object.fromEntries(Object.entries(state.Properties || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)]));
  return JSON.stringify({ Name: state.Name, Properties: properties });
}

function validateState(state) {
  if (!state || typeof state.Name !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(state.Name)) throw new Error('替换目标方块 ID 无效，需填写命名空间，例如 minecraft:stone');
  if (state.Properties != null && (typeof state.Properties !== 'object' || Array.isArray(state.Properties))) throw new Error('替换目标方块属性无效');
  const properties = Object.create(null);
  for (const [key, value] of Object.entries(state.Properties || {})) {
    if (typeof value !== 'string' || !key.length) throw new Error('方块属性必须为字符串');
    properties[key] = value;
  }
  return { Name: state.Name, Properties: properties };
}

function stateType(state) {
  return { type: 'compound', children: { Name: { type: 'string' }, Properties: { type: 'compound', children:
    Object.fromEntries(Object.keys(state.Properties).map(key => [key, { type: 'string' }])) } } };
}

function unpack(words, volume, paletteSize) {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize))), mask = (1n << BigInt(bits)) - 1n;
  const packed = words.map(word => BigInt.asUintN(64, BigInt(word))), states = new Uint32Array(volume);
  for (let i = 0; i < volume; i++) {
    const bit = i * bits, word = Math.floor(bit / 64), shift = bit % 64;
    let value = packed[word] >> BigInt(shift);
    if (shift + bits > 64) value |= packed[word + 1] << BigInt(64 - shift);
    states[i] = Number(value & mask);
  }
  return states;
}

function pack(states, paletteSize) {
  const bits = Math.max(2, Math.ceil(Math.log2(paletteSize))), words = Array(Math.ceil(states.length * bits / 64)).fill(0n);
  for (let i = 0; i < states.length; i++) {
    const bit = i * bits, word = Math.floor(bit / 64), shift = bit % 64;
    words[word] |= BigInt(states[i]) << BigInt(shift);
    if (shift + bits > 64) words[word + 1] |= BigInt(states[i]) >> BigInt(64 - shift);
  }
  return words.map(word => BigInt.asIntN(64, word).toString());
}

// These block variants share one vanilla block-entity type. Unknown/modded
// conversions use the conservative rule of retaining NBT only for the same ID.
function blockEntityFamily(name) {
  if (!name.startsWith('minecraft:')) return null;
  const n = name.slice(10);
  if (n === 'shulker_box' || n.endsWith('_shulker_box')) return 'minecraft:shulker_box';
  if (n.endsWith('_hanging_sign') || n.endsWith('_wall_hanging_sign')) return 'minecraft:hanging_sign';
  if (n.endsWith('_sign') || n.endsWith('_wall_sign')) return 'minecraft:sign';
  if (n.endsWith('_bed')) return 'minecraft:bed';
  if (n.endsWith('_banner')) return 'minecraft:banner';
  if (n.endsWith('_skull') || n.endsWith('_head')) return 'minecraft:skull';
  return null;
}

function canKeepBlockEntity(from, to, nbt) {
  if (from === to) return true;
  const family = blockEntityFamily(from);
  return !!family && family === blockEntityFamily(to) && nbt?.id === family;
}

/**
 * Replace only selected source IDs and (optionally) stable region/local indices.
 * `scope: []` means no blocks, omitted scope means every matching block.
 * The caller validates target states against its local Minecraft assets.
 * Source properties are preserved only if listed in allowedProperties.
 * No mutations touch the input buffer or filesystem; keep buffer for undo.
 */
function replaceBlocks(buffer, options = {}) {
  const { fromNames, scope, preserveProperties = false, allowedProperties = {}, stateMap = {} } = options;
  if (!Array.isArray(fromNames) || fromNames.length === 0 || fromNames.some(name => typeof name !== 'string')) throw new Error('请选择至少一种待替换方块');
  const target = validateState(options.to), from = new Set(fromNames);
  const parsed = parseNBT(buffer), schematic = parseLitematic(buffer), root = parsed.value;
  const selected = scope === undefined ? null : new Map();
  if (scope !== undefined) {
    if (!Array.isArray(scope)) throw new Error('替换范围必须为方块索引列表');
    for (const entry of scope) {
      if (!entry || typeof entry.region !== 'string' || !Number.isSafeInteger(entry.localIndex) || entry.localIndex < 0) throw new Error('替换范围含有无效方块索引');
      if (!selected.has(entry.region)) selected.set(entry.region, new Set());
      selected.get(entry.region).add(entry.localIndex);
    }
    for (const [name, indices] of selected) {
      const region = schematic.regions.find(r => r.name === name);
      if (!region || [...indices].some(index => index >= region.volume)) throw new Error('替换范围已失效，请重新选择方块');
    }
  }
  let changed = 0, removedBlockEntities = 0, preservedBlockEntities = 0, totalBlocks = 0;
  const changedRegions = [];
  for (const descriptor of schematic.regions) {
    const name = descriptor.name, region = root.Regions[name], types = parsed.types.children.Regions.children[name].children;
    const palette = region.BlockStatePalette.slice(), paletteTypes = types.BlockStatePalette.items.slice();
    const states = unpack(region.BlockStates, descriptor.volume, palette.length);
    const scopeIndices = selected?.get(name), eligible = selected === null || !!scopeIndices;
    const paletteMap = new Map(palette.map((state, index) => [stateKey(state), index]));
    const substitutions = new Map(), changedIds = new Map();
    if (eligible) for (let i = 0, initialLength = palette.length; i < initialLength; i++) {
      const source = palette[i];
      if (!from.has(source.Name)) continue;
      const sourceKey = stateKey(source);
      let destination = Object.hasOwn(stateMap, sourceKey) ? validateState(stateMap[sourceKey]) : validateState(target);
      if (preserveProperties && !Object.hasOwn(stateMap, sourceKey)) {
        for (const [key, value] of Object.entries(source.Properties || {})) {
          if (Object.hasOwn(allowedProperties, key) && Array.isArray(allowedProperties[key]) && allowedProperties[key].includes(String(value))) destination.Properties[key] = String(value);
        }
      }
      const key = stateKey(destination);
      if (key === sourceKey) continue;
      if (!paletteMap.has(key)) {
        paletteMap.set(key, palette.length); palette.push(destination); paletteTypes.push(stateType(destination));
      }
      substitutions.set(i, paletteMap.get(key));
    }
    let regionChanged = 0;
    for (let index = 0; index < states.length; index++) {
      const oldState = states[index], targetState = substitutions.get(oldState);
      if (targetState !== undefined && (selected === null || scopeIndices?.has(index))) {
        changedIds.set(index, [palette[oldState].Name, palette[targetState].Name]);
        states[index] = targetState; regionChanged++;
      }
      if (!AIR.has(palette[states[index]].Name)) totalBlocks++;
    }
    if (!regionChanged) continue;
    changed += regionChanged; changedRegions.push(name);
    region.BlockStatePalette = palette; types.BlockStatePalette.items = paletteTypes;
    region.BlockStates = pack(states, palette.length);
    const tiles = region.TileEntities;
    if (Array.isArray(tiles)) {
      const kept = [], keptTypes = [], tileTypes = types.TileEntities;
      tiles.forEach((entry, i) => {
        const { x, y, z } = entry || {}, d = descriptor.dimensions;
        const inBounds = [x, y, z].every(Number.isInteger) && x >= 0 && x < d.x && y >= 0 && y < d.y && z >= 0 && z < d.z;
        const names = inBounds ? changedIds.get(y * d.x * d.z + z * d.x + x) : null;
        const nbt = schematic.version === 1 && entry.TileNBT ? entry.TileNBT : entry;
        if (names && !canKeepBlockEntity(names[0], names[1], nbt)) removedBlockEntities++;
        else { kept.push(entry); keptTypes.push(tileTypes.items[i]); if (names) preservedBlockEntities++; }
      });
      region.TileEntities = kept; tileTypes.items = keptTypes;
    }
  }
  if (!changed) return { buffer: Buffer.from(buffer), changed, removedBlockEntities, preservedBlockEntities, changedRegions };
  if (!root.Metadata) { root.Metadata = Object.create(null); parsed.types.children.Metadata = { type: 'compound', children: Object.create(null) }; }
  const metaTypes = parsed.types.children.Metadata.children;
  if (!metaTypes.TotalBlocks) metaTypes.TotalBlocks = { type: 'int' };
  root.Metadata.TotalBlocks = metaTypes.TotalBlocks.type === 'long' ? String(totalBlocks) : totalBlocks;
  if (!metaTypes.TimeModified) metaTypes.TimeModified = { type: 'long' };
  root.Metadata.TimeModified = metaTypes.TimeModified.type === 'long' ? String(Date.now()) : Date.now();
  return { buffer: writeNBT(parsed), changed, removedBlockEntities, preservedBlockEntities, changedRegions };
}

function createDocument(buffer) {
  const parsed = parseNBT(buffer);
  return { ...parsed, schematic: parseLitematic(buffer), serialize: compression => writeNBT(parsed, compression) };
}

module.exports = { writeNBT, createDocument, replaceBlocks, stateKey, canKeepBlockEntity };
