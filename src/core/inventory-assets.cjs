'use strict';

const fs = require('node:fs');
const AdmZip = require('adm-zip');
const { loadAssets, _test: { resourceId, cleanZipPath, defaultUv, entityBox, poseMatrix } } = require('./assets.cjs');
const { inventoryKey, stackData } = require('./inventory-key.cjs');
const GUI = ['generic_54', 'shulker_box', 'hopper', 'dispenser', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand', 'crafter', 'beacon'];
const DIRECTIONS = ['north', 'south', 'east', 'west', 'up', 'down'];
const resourcePath = (id, type, extension = 'json') => { const [ns, name] = resourceId(id).split(':'); return `assets/${ns}/${type}/${name}.${extension}`; };
// RGB facts verified against PotionContents.getColorOr() in the local 1.21.11
// client registry. Runtime data/effects outside this palette are marked approximate.
const POTION_COLORS = Object.freeze({ water:3694022, mundane:3694022, thick:3694022, awkward:3694022,
  night_vision:-3997850,invisibility:-592138,leaping:-131196,fire_resistance:-26368,swiftness:-13374465,
  slowness:-7622688,turtle_master:-7503130,strong_turtle_master:-7502362,water_breathing:-6759744,
  healing:-515037,harming:-5675670,poison:-7888029,regeneration:-3318613,strength:-14592,
  weakness:-12038840,luck:-10895098,slow_falling:-798791,wind_charged:-4339201,weaving:-8885926,oozing:-6684765,infested:-7562356 });
const addLimitation = (descriptor, code) => { descriptor.approximate = true; if (!descriptor.limitations.includes(code)) descriptor.limitations.push(code); };

/** Local inventory resources, kept separate from world blocks and their atlas. */
function loadInventoryAssets(jarPath, stacks, options = {}) {
  const output = { items: Object.create(null), textures: Object.create(null), textureMeta: Object.create(null), gui: {}, guiSizes: {}, warnings: [] };
  if (!jarPath) return output;
  if (!Array.isArray(stacks) || stacks.length > 1000000) throw new Error('Invalid inventory resource list');
  const archives = [options.resourcePackPath, jarPath].filter(Boolean).map(filename => {
    if (fs.statSync(filename).size > 768 * 1024 * 1024) throw new Error('Inventory resource archive exceeds limit');
    const entries = new AdmZip(filename).getEntries();
    if (entries.length > 200000) throw new Error('Inventory resource entry limit exceeded');
    return new Map(entries.filter(e => { try { cleanZipPath(e.entryName); return !e.isDirectory; } catch { return false; } }).map(e => [e.entryName, e]));
  });
  const cache = new Map(), models = new Map(); let readBytes = 0;
  function read(name, limit = 8 * 1024 * 1024) {
    cleanZipPath(name);
    if (!cache.has(name)) {
      const entry = archives.map(a => a.get(name)).find(Boolean);
      if (!entry) { cache.set(name, null); return null; }
      if (entry.header.size > limit || entry.header.size < 0 || readBytes + entry.header.size > 96 * 1024 * 1024) throw new Error('Inventory resources exceed read limit');
      const bytes = entry.getData(); if (bytes.length !== entry.header.size) throw new Error('Invalid inventory resource size');
      readBytes += bytes.length; cache.set(name, bytes);
    }
    return cache.get(name);
  }
  const json = name => { const bytes = read(name); return bytes ? JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) : null; };
  const gameVersion = json('version.json')?.id;
  function image(id) {
    id = resourceId(id); if (output.textures[id]) return id;
    const bytes = read(resourcePath(id, 'textures', 'png'), 32 * 1024 * 1024); if (!bytes) return null;
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid inventory PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16777216) throw new Error('Inventory PNG dimensions exceed limit');
    const animation = json(resourcePath(id, 'textures', 'png.mcmeta'))?.animation;
    const frameWidth = animation?.width ?? width, frameHeight = animation?.height ?? (animation ? Math.min(width, height) : height);
    const first = animation?.frames?.[0];
    const firstFrame = (typeof first === 'object' ? first?.index : first) ?? 0;
    if (![frameWidth, frameHeight].every(n => Number.isInteger(n) && n > 0) || width % frameWidth || height % frameHeight || !Number.isInteger(firstFrame) || firstFrame < 0 || firstFrame >= width / frameWidth * height / frameHeight) throw new Error('Invalid inventory animation frame');
    output.textures[id] = `data:image/png;base64,${bytes.toString('base64')}`;
    output.textureMeta[id] = { width, height, frameWidth, frameHeight, firstFrame, animated: !!animation };
    return id;
  }
  for (const name of GUI) { try { const id = image(`minecraft:gui/container/${name}`); if (id) { output.gui[name] = output.textures[id]; output.guiSizes[name] = output.textureMeta[id]; } } catch { /* optional UI skin */ } }
  function model(id, trail = []) {
    id = resourceId(id); if (models.has(id)) return models.get(id);
    if (trail.length >= 32 || trail.includes(id)) throw new Error('Cyclic inventory model inheritance');
    const raw = json(resourcePath(id, 'models')); if (!raw) return null;
    const parent = raw.parent && !/^(?:minecraft:)?builtin\//.test(raw.parent) ? model(raw.parent, [...trail, id]) || {} : {};
    const resolved = { ...parent, ...raw, textures: { ...parent.textures, ...raw.textures }, display: { ...parent.display, ...raw.display },
      generated: /^(?:minecraft:)?(?:builtin\/generated|item\/generated|item\/handheld)$/.test(raw.parent || '') || parent.generated };
    models.set(id, resolved); return resolved;
  }
  function resolveTexture(value, textures) {
    const visited = new Set();
    while (typeof value === 'string' && (value.startsWith('#') || Object.hasOwn(textures, value))) {
      const key = value.replace(/^#/, ''); if (visited.has(key)) return null; visited.add(key); value = textures[key];
    }
    return typeof value === 'string' && !value.startsWith('#') ? image(value) : null;
  }
  function tintValue(tint, stack, descriptor) {
    const c = stack.components || {}, tag = stack.tag || {}, type = (tint?.type || '').replace(/^minecraft:/, '');
    let color = tint?.value ?? tint?.default ?? 0xffffff;
    if (type === 'dye') color = c['minecraft:dyed_color']?.rgb ?? c['minecraft:dyed_color'] ?? tag.display?.color ?? color;
    if (type === 'potion') {
      const contents = c['minecraft:potion_contents'] || {}, custom = contents.custom_color ?? tag.CustomPotionColor;
      if (custom != null) color = custom;
      else {
        const potion = contents.potion ?? tag.Potion;
        const name = typeof potion === 'string' && potion.startsWith('minecraft:') ? potion.slice(10) : null;
        const palette = name && (POTION_COLORS[name] ?? POTION_COLORS[name.replace(/^(long|strong)_/, '')]);
        if (palette != null) color = palette;
        if (palette != null && gameVersion && gameVersion !== '1.21.11') addLimitation(descriptor, 'potion_palette_version');
        if ((potion && palette == null) || contents.custom_effects?.length || tag.CustomPotionEffects?.length) addLimitation(descriptor, 'potion_effect_color');
      }
    }
    if (type === 'firework') {
      const colors = c['minecraft:firework_explosion']?.colors ?? tag.Explosion?.Colors;
      if (Array.isArray(colors) && colors.length && colors.every(Number.isFinite)) color = [16,8,0].reduce((out, shift) => out | Math.floor(colors.reduce((sum, rgb) => sum + (rgb >> shift & 255), 0) / colors.length) << shift, 0);
    }
    if (type === 'grass') color = 0x91bd59;
    if (type === 'map_color') color = c['minecraft:map_color'] ?? color;
    if (!Number.isFinite(Number(color))) color = 0xffffff;
    return Number(color) & 0xffffff;
  }
  function choose(node, stack, descriptor, depth = 0) {
    if (!node || depth > 24) return [];
    const type = String(node.type || 'minecraft:model').replace(/^minecraft:/, '');
    if (type === 'model' || type === 'special') return [node];
    if (type === 'composite') return (node.models || []).flatMap(n => choose(n, stack, descriptor, depth + 1));
    const c = stack.components || {}, property = String(node.property || '').replace(/^minecraft:/, '');
    if (type === 'condition') {
      const selected = property === 'has_component' ? Object.hasOwn(c, node.component) : property === 'damaged' ? Number(c['minecraft:damage'] || stack.tag?.Damage || 0) > 0 : false;
      if (!['has_component', 'damaged', 'using_item', 'bundle/has_selected_item', 'fishing_rod/cast', 'selected', 'carried', 'view_entity'].includes(property)) addLimitation(descriptor, 'unsupported_property');
      return choose(selected ? node.on_true : node.on_false, stack, descriptor, depth + 1);
    }
    if (type === 'select') {
      const projectiles = c['minecraft:charged_projectiles'] ?? stack.tag?.ChargedProjectiles ?? [];
      const trim = c['minecraft:trim']?.material ?? stack.tag?.Trim?.material;
      const value = property === 'display_context' ? 'gui' : property === 'main_hand' ? 'right' : property === 'custom_model_data' ? c['minecraft:custom_model_data']?.strings?.[node.index || 0]
        : property === 'trim_material' ? (typeof trim === 'string' ? trim : trim?.asset_name)
        : property === 'charge_type' ? (projectiles.length ? projectiles.some(p => p.id === 'minecraft:firework_rocket') ? 'rocket' : 'arrow' : 'none')
        : property === 'block_state' ? c['minecraft:block_state']?.[node.block_state_property] : undefined;
      if (!['display_context','main_hand','custom_model_data','trim_material','charge_type','block_state'].includes(property)) addLimitation(descriptor, 'unsupported_property');
      const selected = (node.cases || []).find(item => (Array.isArray(item.when) ? item.when : [item.when]).includes(value));
      return choose(selected?.model || node.fallback, stack, descriptor, depth + 1);
    }
    if (type === 'range_dispatch') {
      let value = property === 'custom_model_data' ? c['minecraft:custom_model_data']?.floats?.[node.index || 0] ?? stack.tag?.CustomModelData : property === 'damage' ? c['minecraft:damage'] ?? stack.tag?.Damage : 0;
      if (!['custom_model_data','damage'].includes(property)) addLimitation(descriptor, 'unsupported_property');
      value = Number(value || 0) * (Number(node.scale) || 1);
      const entry = [...(node.entries || [])].filter(e => Number(e.threshold) <= value).sort((a, b) => b.threshold - a.threshold)[0];
      return choose(entry?.model || node.fallback, stack, descriptor, depth + 1);
    }
    addLimitation(descriptor, 'unsupported_property'); return [];
  }
  const special = [], unique = new Map();
  for (const entry of stacks) { const item = typeof entry === 'string' ? { id: entry } : entry; if (item?.id) unique.set(inventoryKey(item), item); }
  if (unique.size > 8192) throw new Error('Too many distinct inventory icons');
  for (const [key, value] of unique) {
    const raw = stackData(value), stack = { ...raw, id: value.id || raw.id }, id = stack.id;
    try {
      resourceId(id); const custom = stack.components?.['minecraft:item_model'];
      let resource = custom ? resourceId(custom) : id;
      let definition = json(resourcePath(resource, 'items'));
      if (!definition && resource === 'minecraft:chain') { resource = 'minecraft:iron_chain'; definition = json(resourcePath(resource, 'items')); }
      const descriptor = { id, kind: 'unsupported', layers: [], parts: [], display: null, guiLight: 'side', approximate: false, limitations: [] };
      const nodes = definition ? choose(definition.model, stack, descriptor) : [{ type: 'minecraft:model', model: resource.replace(':', ':item/') }];
      const c = stack.components || {}, tag = stack.tag || {};
      if (c['minecraft:enchantment_glint_override'] === true || (c['minecraft:enchantment_glint_override'] !== false && (Object.keys(c['minecraft:enchantments'] || {}).length || tag.Enchantments?.length || tag.ench?.length))) addLimitation(descriptor, 'enchantment_glint');
      for (const node of nodes) {
        const info = model(node.model && typeof node.model === 'string' ? node.model : node.base || resource.replace(':', ':item/'));
        if (!info) continue;
        descriptor.display ||= info.display?.gui || null; descriptor.guiLight = info.gui_light || descriptor.guiLight;
        const tints = (node.tints || []).map(t => tintValue(t, stack, descriptor));
        if (node.type === 'minecraft:special' || node.type === 'special') {
          if (node.model?.type === 'minecraft:shield') {
            const texture = image('minecraft:entity/shield_base_nopattern');
            if (!texture) throw new Error('Missing local shield texture');
            // Native ShieldModel's two cuboids and ShieldSpecialRenderer's Y/Z
            // flip. Keep their original origin; the GUI transform centers them.
            const transform = poseMatrix(0,0,0,0,0,0,1,-1,-1);
            descriptor.parts.push({elements:[entityBox([-6,-11,-2],[12,22,1],[0,0],texture,transform),entityBox([-1,-3,-1],[2,6,6],[26,0],texture,transform)]});
            descriptor.kind = 'model';
          } else special.push({ key, id, descriptor, stack, node });
          if (c['minecraft:banner_patterns']?.length || c['minecraft:base_color'] != null || tag.BlockEntityTag?.Patterns?.length || tag.BlockEntityTag?.Base != null) addLimitation(descriptor, 'banner_patterns');
          if (c['minecraft:profile'] || tag.SkullOwner) addLimitation(descriptor, 'player_profile');
          if (c['minecraft:pot_decorations'] || tag.BlockEntityTag?.sherds) addLimitation(descriptor, 'pot_decorations');
          continue;
        }
        if (Array.isArray(info.elements) && info.elements.length) {
          if (info.elements.length > 4096) throw new Error('Inventory model has too many elements');
          const elements = info.elements.map(element => {
            if (![element.from, element.to].every(v => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 4096))) throw new Error('Invalid inventory model coordinates');
            const faces = {};
            for (const [d, face] of Object.entries(element.faces || {})) {
              if (!DIRECTIONS.includes(d)) continue; const texture = resolveTexture(face.texture, info.textures); if (!texture) throw new Error('Missing inventory face texture');
              const color = tints[face.tintindex];
              const uv = face.uv || defaultUv(d, element.from, element.to), rotation = face.rotation ?? 0;
              if (!Array.isArray(uv) || uv.length !== 4 || !uv.every(n => Number.isFinite(n) && Math.abs(n) <= 65536) || ![0, 90, 180, 270].includes(rotation)) throw new Error('Invalid inventory face UV');
              faces[d] = { texture, uv, rotation,
                ...(color == null ? {} : { colorRGB: [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255] }) };
            }
            if (element.rotation && (!['x', 'y', 'z'].includes(element.rotation.axis) || !Number.isFinite(element.rotation.angle) || !Array.isArray(element.rotation.origin) || element.rotation.origin.length !== 3 || !element.rotation.origin.every(Number.isFinite))) throw new Error('Invalid inventory element rotation');
            return { from: element.from, to: element.to, faces, ...(element.rotation ? { rotation: element.rotation } : {}) };
          });
          descriptor.parts.push({ elements, x: 0, y: 0, uvlock: false }); descriptor.kind = 'model';
        } else {
          for (const layer of Object.keys(info.textures || {}).filter(k => /^layer\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
            const texture = resolveTexture(info.textures[layer], info.textures); if (!texture) continue;
            descriptor.layers.push({ texture, color: tints[Number(layer.slice(5))] ?? 0xffffff });
          }
          if (descriptor.layers.length && !descriptor.parts.length) descriptor.kind = 'sprite';
        }
      }
      if (descriptor.parts.length && descriptor.layers.length) addLimitation(descriptor, 'mixed_model_layers');
      descriptor.reason = descriptor.limitations.join(', ');
      output.items[key] = descriptor; output.items[id] ||= descriptor;
    } catch (error) { output.items[key] = { id, kind: 'unsupported', reason: error.message }; output.warnings.push(`${id}: ${error.message}`); }
  }
  if (special.length) {
    const palette = special.map(s => ({ Name: s.id, Properties: {
      facing: s.node.model?.type === 'minecraft:shulker_box' ? s.node.model.orientation || 'up' : s.id.endsWith('_bed') ? 'south' : 'north',
      type: 'single', rotation: '0', waterlogged: 'false', part: 'head', copper_golem_pose:s.node.model?.pose || 'standing',
    } }));
    for (const s of special) if (s.id.endsWith('_bed')) { s.footIndex = palette.length; palette.push({ Name:s.id, Properties:{facing:'south',part:'foot'} }); }
    try {
      const assets = loadAssets(jarPath, palette, options);
      Object.assign(output.textures, assets.textures); Object.assign(output.textureMeta, assets.textureMeta);
      special.forEach((s, i) => {
        const block = assets.blocks[i];
        if (block.parts?.length && !block.parts.some(p => p.elements.some(e => Object.values(e.faces).some(f => f.texture === 'viewer:missing')))) {
          s.descriptor.kind = 'model'; s.descriptor.parts = block.parts; s.descriptor.renderType = block.renderType;
          if (s.footIndex != null) {
            // Native BedRenderer's inventory path draws BOTH halves, facing
            // south, with the foot translated -1 in world Z. The south-facing
            // part rotates local +Z to world -Z, hence the +16 local offset.
            const foot = assets.blocks[s.footIndex];
            s.descriptor.parts = [...block.parts, ...foot.parts.map(part => ({...part,elements:part.elements.map(e=>({...e,from:e.from.map((n,a)=>n+(a===2?16:0)),to:e.to.map((n,a)=>n+(a===2?16:0))}))}))];
          }
          if (Number(s.node.model?.openness) > 0 || Number(s.node.model?.animation) > 0) addLimitation(s.descriptor, 'special_model_pose');
          s.descriptor.reason = s.descriptor.limitations.join(', ');
        }
      });
    } catch (error) { output.warnings.push(error.message); }
  }
  for (const descriptor of new Set(Object.values(output.items))) if (descriptor.kind === 'unsupported' && descriptor.id !== 'minecraft:air') {
    descriptor.approximate = true; descriptor.limitations ||= []; if (!descriptor.limitations.includes('unsupported_property')) descriptor.limitations.push('unsupported_property');
    descriptor.reason ||= 'No supported local item model';
  }
  return output;
}

module.exports = { loadInventoryAssets };
