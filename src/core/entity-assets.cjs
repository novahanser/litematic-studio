'use strict';

// Entity geometry is a static approximation, while every texture is read from
// the selected local game or resource pack. Archives are never extracted.
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const LIMITS = { archive: 768 * 1024 * 1024, entries: 200000, image: 32 * 1024 * 1024, json: 8 * 1024 * 1024, total: 96 * 1024 * 1024 };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LABELS = { item_frame: '物品展示框', glow_item_frame: '荧光物品展示框', item: '掉落物', item_display: '物品展示实体', block_display: '方块展示实体', text_display: '文本展示实体', armor_stand: '盔甲架', minecart: '矿车', chest_minecart: '运输矿车', hopper_minecart: '漏斗矿车', furnace_minecart: '动力矿车', tnt_minecart: 'TNT 矿车', command_block_minecart: '命令方块矿车', boat: '船', chest_boat: '运输船', zombie: '僵尸', husk: '尸壳', drowned: '溺尸', skeleton: '骷髅', wither_skeleton: '凋灵骷髅', stray: '流浪者', creeper: '苦力怕', villager: '村民', cow: '牛', pig: '猪', sheep: '羊', chicken: '鸡', painting: '画' };

function resourceId(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('无效的实体资源 ID');
  const parts = value.includes(':') ? value.split(':') : ['minecraft', value];
  if (parts.length !== 2 || !/^[a-z0-9_.-]+$/.test(parts[0]) || !/^[a-z0-9_./-]+$/.test(parts[1]) || parts[1].split('/').some(p => !p || p === '.' || p === '..')) throw new Error('无效的实体资源 ID');
  return parts.join(':');
}

function cleanPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/') || /[\\\0:]/.test(value) || value.split('/').some(p => p === '..' || p === '.')) throw new Error('无效的实体资源路径');
  return value;
}

function resourcePath(id, folder, suffix) {
  const [namespace, name] = resourceId(id).split(':');
  return cleanPath(`assets/${namespace}/${folder}/${name}.${suffix}`);
}

class Archive {
  constructor(filename, budget) {
    const resolved = path.resolve(filename), stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > LIMITS.archive) throw new Error('实体资源文件过大或不是普通文件');
    const zip = new AdmZip(resolved), entries = zip.getEntries();
    if (entries.length > LIMITS.entries) throw new Error('实体资源条目数量超过限制');
    this.entries = new Map(); this.budget = budget;
    for (const entry of entries) {
      try { cleanPath(entry.entryName); } catch { continue; }
      if (!entry.isDirectory) this.entries.set(entry.entryName, entry);
    }
  }
  read(name, max) {
    const entry = this.entries.get(cleanPath(name));
    if (!entry) return null;
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > max || this.budget.used + size > LIMITS.total) throw new Error(`实体资源超过读取限制：${name}`);
    const bytes = entry.getData();
    if (bytes.length !== size || bytes.length > max) throw new Error(`实体资源大小无效：${name}`);
    this.budget.used += size;
    return bytes;
  }
}

function entityKind(id) {
  const [namespace, name] = resourceId(id).split(':');
  // Mod entities sharing a vanilla name must not silently acquire a vanilla model.
  if (namespace !== 'minecraft') return 'unknown';
  if (name === 'item_frame' || name === 'glow_item_frame') return 'item_frame';
  if (name === 'item' || name === 'item_display' || name === 'block_display') return name;
  if (name === 'armor_stand') return 'armor_stand';
  if (name === 'minecart' || name.endsWith('_minecart')) return 'minecart';
  if (name === 'boat' || name.endsWith('_boat') || name.endsWith('_raft')) return 'boat';
  if (['zombie', 'husk', 'drowned', 'skeleton', 'wither_skeleton', 'stray', 'villager'].includes(name)) return 'humanoid';
  if (name === 'creeper') return 'creeper';
  if (['cow', 'pig', 'sheep'].includes(name)) return 'quadruped';
  if (name === 'chicken') return 'chicken';
  return 'unknown';
}

function stackFor(entity) {
  const nbt = entity?.nbt || {};
  const value = nbt.Item || nbt.item || nbt.item_stack;
  return value && typeof value === 'object' ? value : null;
}

/** Return JSON-safe texture data and one descriptor per input entity. */
function loadEntityAssets(jarPath, entities, options = {}) {
  if (!Array.isArray(entities) || entities.length > 1000000) throw new Error('实体清单无效或超过限制');
  const budget = { used: 0 }, archives = [];
  if (options.resourcePackPath) archives.push(new Archive(options.resourcePackPath, budget));
  archives.push(new Archive(jarPath, budget));
  const cache = new Map(), textures = Object.create(null), textureSizes = Object.create(null), warnings = new Set();
  const read = (name, max) => {
    if (!cache.has(name)) {
      let bytes = null;
      for (const archive of archives) { bytes = archive.read(name, max); if (bytes) break; }
      cache.set(name, bytes);
    }
    return cache.get(name);
  };
  const json = name => {
    const bytes = read(name, LIMITS.json);
    if (!bytes) return null;
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  function texture(...ids) {
    for (const raw of ids.filter(Boolean)) {
      const id = resourceId(raw);
      if (textures[id]) return id;
      const bytes = read(resourcePath(id, 'textures', 'png'), LIMITS.image);
      if (!bytes) continue;
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`实体贴图不是有效的 PNG：${id}`);
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16777216) throw new Error(`实体贴图尺寸超过限制：${id}`);
      textures[id] = `data:image/png;base64,${bytes.toString('base64')}`;
      textureSizes[id] = { width, height };
      return id;
    }
    return null;
  }
  function modelInfo(id, depth = 0, seen = new Set()) {
    id = resourceId(id);
    if (depth > 24 || seen.has(id)) return null;
    seen.add(id);
    const model = json(resourcePath(id, 'models', 'json'));
    if (!model) return null;
    const parent = model.parent && !model.parent.includes('builtin/') ? modelInfo(model.parent, depth + 1, seen) : null;
    const values = Object.assign(Object.create(null), parent?.textures, model.textures || {});
    return { textures: values, block: id.split(':')[1].startsWith('block/') || !!parent?.block };
  }
  function itemInfo(raw) {
    if (!raw) return null;
    const id = resourceId(raw), [namespace, name] = id.split(':');
    let model = null;
    const definition = json(resourcePath(id, 'items', 'json'));
    if (typeof definition?.model?.model === 'string') model = modelInfo(definition.model.model);
    model ||= modelInfo(`${namespace}:item/${name}`);
    if (model?.textures) {
      for (const key of ['layer0', 'all', 'side', 'front', 'particle', ...Object.keys(model.textures)]) {
        let candidate = model.textures[key];
        const seen = new Set();
        while (typeof candidate === 'string' && candidate.startsWith('#') && !seen.has(candidate)) { seen.add(candidate); candidate = model.textures[candidate.slice(1)]; }
        if (typeof candidate !== 'string' || candidate.startsWith('#')) continue;
        const result = texture(candidate);
        if (result) return { id, texture: result, isBlock: model.block };
      }
    }
    const item = texture(`${namespace}:item/${name}`);
    if (item) return { id, texture: item, isBlock: false };
    const block = texture(`${namespace}:block/${name}`);
    if (block) return { id, texture: block, isBlock: true };
    warnings.add(`实体物品缺少本地贴图：${id}`);
    return { id, texture: null, isBlock: false };
  }
  const descriptors = entities.map(entity => {
    let id;
    try { id = resourceId(entity?.id || 'minecraft:unknown'); } catch { return { kind: 'unknown', label: '无效实体 ID', approximation: true }; }
    const name = id.split(':')[1], nbt = entity.nbt || {}, kind = entityKind(id);
    const descriptor = { id, kind, label: LABELS[name] || name.replace(/_/g, ' '), approximation: true };
    try {
      if (kind === 'item_frame') {
        descriptor.texture = texture('minecraft:block/birch_planks');
        descriptor.borderTexture = texture('minecraft:block/oak_planks');
        descriptor.item = itemInfo(stackFor(entity)?.id);
      } else if (kind === 'item' || kind === 'item_display') descriptor.item = itemInfo(stackFor(entity)?.id);
      else if (kind === 'block_display') descriptor.item = itemInfo(nbt.block_state?.Name || nbt.block_state?.name || nbt.BlockState?.Name);
      else if (kind === 'armor_stand') { descriptor.texture = texture('minecraft:entity/armorstand/wood'); descriptor.baseTexture = texture('minecraft:block/smooth_stone', 'minecraft:block/stone'); }
      else if (kind === 'minecart') {
        descriptor.texture = texture('minecraft:entity/minecart');
        descriptor.cargoTexture = name.includes('chest') ? texture('minecraft:block/oak_planks') : name.includes('tnt') ? texture('minecraft:block/tnt_side') : name.includes('hopper') ? texture('minecraft:block/hopper_outside') : name.includes('furnace') ? texture('minecraft:block/furnace_front') : null;
      } else if (kind === 'boat') {
        const wood = name.replace(/_(chest_)?(boat|raft)$/, '');
        const selectedWood = /^[a-z_]+$/.test(nbt.Type || '') ? nbt.Type : ['boat', 'chest_boat'].includes(name) ? 'oak' : wood;
        descriptor.texture = texture(`minecraft:block/${selectedWood}_planks`, 'minecraft:block/oak_planks');
      } else if (kind === 'humanoid') {
        const folder = ['husk', 'drowned'].includes(name) ? 'zombie' : ['stray', 'wither_skeleton'].includes(name) ? 'skeleton' : name;
        descriptor.texture = texture(`minecraft:entity/${folder}/${name}`);
      } else if (kind === 'creeper') descriptor.texture = texture('minecraft:entity/creeper/creeper');
      else if (kind === 'quadruped' || kind === 'chicken') {
        const variantValue = nbt.variant || nbt.Variant || 'temperate';
        const variant = typeof variantValue === 'string' && /^(?:minecraft:)?(?:temperate|cold|warm)$/.test(variantValue) ? variantValue.split(':').pop() : 'temperate';
        descriptor.texture = texture(`minecraft:entity/${name}/${variant}_${name}`, `minecraft:entity/${name}/${name}`);
        if (name === 'sheep' && !nbt.Sheared && !nbt.sheared) descriptor.woolTexture = texture('minecraft:entity/sheep/sheep_wool');
      }
      if (descriptor.texture) descriptor.textureSize = textureSizes[descriptor.texture];
      if (kind === 'unknown') warnings.add(`实体 ${id} 使用带名称的边界占位预览。`);
    } catch (error) {
      descriptor.warning = error.message;
      warnings.add(`实体 ${id}：${error.message}`);
    }
    return descriptor;
  });
  if (descriptors.some(d => d.kind !== 'unknown')) warnings.add('实体为静态近似预览，使用本地游戏贴图；不模拟动画、AI、装备附魔光效或完整展示实体变换。');
  return { textures, textureSizes, entities: descriptors, warnings: [...warnings] };
}

module.exports = { loadEntityAssets, entityKind, _test: { resourceId, cleanPath, stackFor } };
