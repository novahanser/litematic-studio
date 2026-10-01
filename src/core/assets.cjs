'use strict';

// Reads only resources from local game/resource-pack archives. Nothing is extracted
// or executed. Model coordinates and UV coordinates use Minecraft's 0..16 units.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const LIMITS = Object.freeze({ archive: 768 * 1024 * 1024, entries: 200000,
  json: 16 * 1024 * 1024, texture: 32 * 1024 * 1024, total: 160 * 1024 * 1024,
  palette: 32768, elements: 4096, inheritance: 48 });
const DIRECTIONS = ['down', 'up', 'north', 'south', 'west', 'east'];
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const MISSING = 'viewer:missing';

function cleanZipPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') ||
      value.includes('\0') || value.startsWith('/') || value.includes(':') ||
      value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('无效的资源路径');
  }
  return value;
}

function resourceId(value, namespace = 'minecraft') {
  if (typeof value !== 'string' || value.length > 512) throw new Error('无效的资源 ID');
  const pieces = value.includes(':') ? value.split(':') : [namespace, value];
  if (pieces.length !== 2 || !/^[a-z0-9_.-]+$/.test(pieces[0]) ||
      !/^[a-z0-9_./-]+$/.test(pieces[1]) || pieces[1].split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`无效的资源 ID: ${value.slice(0, 100)}`);
  }
  return `${pieces[0]}:${pieces[1]}`;
}

function resourcePath(id, kind, extension) {
  const [namespace, name] = resourceId(id).split(':');
  return cleanZipPath(`assets/${namespace}/${kind}/${name}.${extension}`);
}

class ResourceArchive {
  constructor(filename, budget) {
    this.path = path.resolve(filename);
    const stat = fs.statSync(this.path);
    if (!stat.isFile() || stat.size > LIMITS.archive) throw new Error('资源文件过大或不是普通文件');
    this.zip = new AdmZip(this.path);
    this.budget = budget;
    const entries = this.zip.getEntries();
    if (entries.length > LIMITS.entries) throw new Error('资源包条目数量超过安全限制');
    this.entries = new Map();
    for (const entry of entries) {
      try { cleanZipPath(entry.entryName); } catch { continue; }
      if (!entry.isDirectory) this.entries.set(entry.entryName, entry);
    }
  }
  has(name) { return this.entries.has(cleanZipPath(name)); }
  read(name, maximum = LIMITS.json) {
    const entry = this.entries.get(cleanZipPath(name));
    if (!entry) return null;
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum || this.budget.used + size > LIMITS.total) {
      throw new Error(`资源超过读取限制: ${name}`);
    }
    const buffer = entry.getData();
    if (buffer.length > maximum || buffer.length !== size) throw new Error(`资源大小不合法: ${name}`);
    this.budget.used += buffer.length;
    return buffer;
  }
}

function readJson(buffer, description) {
  if (!buffer) return null;
  const parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`资源 JSON 必须是对象: ${description}`);
  return parsed;
}

function localJson(filename, maximum = LIMITS.json) {
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > maximum) return null;
    return readJson(fs.readFileSync(filename), filename);
  } catch { return null; }
}

function gameRoots() {
  const home = os.homedir();
  const candidates = [process.env.MINECRAFT_HOME, process.env.MC_GAME_DIR,
    process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft'),
    path.join(home, 'AppData', 'Roaming', '.minecraft'), path.join(home, '.minecraft'),
    path.join(home, 'Library', 'Application Support', 'minecraft'),
    path.join(home, 'Downloads', '.minecraft'), 'D:/download/.minecraft'];
  return [...new Set(candidates.filter(Boolean).map(p => path.resolve(p)))];
}

function findGameRoot(jarPath) {
  let current = path.dirname(path.resolve(jarPath));
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(path.join(current, 'assets', 'indexes')) || path.basename(current).toLowerCase() === '.minecraft') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.dirname(path.dirname(path.dirname(path.resolve(jarPath))));
}

function discoverGameResources() {
  const result = [];
  for (const root of gameRoots()) {
    let versions;
    try { versions = fs.readdirSync(path.join(root, 'versions'), { withFileTypes: true }); } catch { continue; }
    for (const version of versions.filter(v => v.isDirectory()).slice(0, 256)) {
      const directory = path.join(root, 'versions', version.name);
      let files;
      try { files = fs.readdirSync(directory).filter(file => file.endsWith('.jar')).slice(0, 8); } catch { continue; }
      for (const file of files) {
        const filename = path.join(directory, file);
        try {
          const archive = new ResourceArchive(filename, { used: 0 });
          if (!archive.has('assets/minecraft/blockstates/stone.json')) continue;
          const metadata = readJson(archive.read('version.json'), 'version.json') || {};
          result.push({ path: filename, version: metadata.id || version.name, name: metadata.name || version.name,
            gameDirectory: root, size: fs.statSync(filename).size });
        } catch { /* An incomplete launcher/library jar is not a usable resource source. */ }
      }
    }
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function parsePaletteEntry(entry) {
  if (typeof entry === 'string') {
    const match = /^([^\[]+)(?:\[(.*)\])?$/.exec(entry);
    if (!match) throw new Error('无效的方块状态');
    const properties = Object.create(null);
    if (match[2]) for (const term of match[2].split(',')) {
      const equal = term.indexOf('=');
      if (equal > 0) properties[term.slice(0, equal).trim()] = term.slice(equal + 1).trim();
    }
    return { name: resourceId(match[1]), properties };
  }
  if (!entry || typeof entry !== 'object') throw new Error('无效的方块调色板条目');
  const name = entry.Name || entry.name || entry.id;
  const properties = Object.create(null);
  const source = entry.Properties || entry.properties || {};
  for (const [key, value] of Object.entries(source)) properties[key] = String(value);
  return { name: resourceId(name), properties };
}

function propertyMatches(actual, required) {
  return String(required).split('|').some(value => value.startsWith('!') ? actual !== value.slice(1) : actual === value);
}

function conditionMatches(condition, properties) {
  if (!condition) return true;
  if (typeof condition !== 'object' || Array.isArray(condition)) return false;
  return Object.entries(condition).every(([key, value]) => {
    if (key === 'OR') return Array.isArray(value) && value.some(part => conditionMatches(part, properties));
    if (key === 'AND') return Array.isArray(value) && value.every(part => conditionMatches(part, properties));
    return propertyMatches(properties[key], value);
  });
}

function variantMatches(key, properties) {
  if (key === '') return true;
  return key.split(',').filter(term => term.trim()).every(term => {
    const equal = term.indexOf('=');
    return equal > 0 && propertyMatches(properties[term.slice(0, equal).trim()], term.slice(equal + 1).trim());
  });
}

function chooseModel(apply) {
  // Position-based random variants do not affect material counts. A stable first
  // variant makes repeated previews deterministic.
  return Array.isArray(apply) ? apply[0] : apply;
}

function finiteVector(value, fallback) {
  return Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 4096) ? value.slice() : fallback.slice();
}

function defaultUv(direction, from, to) {
  const [x1, y1, z1] = from; const [x2, y2, z2] = to;
  switch (direction) {
    case 'down': return [x1, 16 - z2, x2, 16 - z1];
    case 'up': return [x1, z1, x2, z2];
    case 'north': return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case 'south': return [x1, 16 - y2, x2, 16 - y1];
    case 'west': return [z1, 16 - y2, z2, 16 - y1];
    default: return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
}

function box(from, to, texture, uv) {
  const faces = Object.create(null);
  for (const direction of DIRECTIONS) faces[direction] = { texture,
    uv: uv && uv[direction] ? uv[direction] : defaultUv(direction, from, to) };
  return { from, to, faces };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function missingPng() {
  function chunk(type, data) {
    const name = Buffer.from(type); const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([head, name, data, tail]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.from([0, 255, 0, 255, 255, 20, 20, 20, 255, 0, 20, 20, 20, 255, 255, 0, 255, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function loadAssets(jarPath, palette, options = {}) {
  if (!Array.isArray(palette) || palette.length > LIMITS.palette) throw new Error(`方块调色板无效，最多 ${LIMITS.palette} 项`);
  const warnings = new Set();
  const warn = message => { if (warnings.size < 250) warnings.add(message); };
  const budget = { used: 0 };
  const base = new ResourceArchive(jarPath, budget);
  if (!base.has('assets/minecraft/blockstates/stone.json')) throw new Error('此 JAR 不包含完整的 Minecraft 客户端方块资源，请选择游戏客户端 JAR');
  const archives = [base];
  if (options.resourcePackPath) archives.unshift(new ResourceArchive(options.resourcePackPath, budget));
  const jsonCache = new Map();
  function readResource(name, maximum) {
    for (const archive of archives) if (archive.has(name)) return archive.read(name, maximum);
    return null;
  }
  function json(name) {
    if (!jsonCache.has(name)) jsonCache.set(name, readJson(readResource(name, LIMITS.json), name));
    return jsonCache.get(name);
  }
  const metadata = readJson(base.read('version.json'), 'version.json') || {};
  const textures = Object.create(null);
  const textureMeta = Object.create(null);
  function texture(id) {
    try { id = resourceId(id); } catch { id = MISSING; }
    if (textures[id]) return id;
    if (id !== MISSING) {
      const filename = resourcePath(id, 'textures', 'png');
      let data;
      try { data = readResource(filename, LIMITS.texture); } catch (error) { warn(error.message); }
      if (data && data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
        if (width > 0 && width <= 8192 && height > 0 && height <= 65536 && width * height <= 16777216) {
          let animation;
          try { animation = json(`${filename}.mcmeta`)?.animation; } catch { warn(`动画元数据无效: ${id}`); }
          const declaredWidth = animation && Number.isInteger(animation.width) ? animation.width : null;
          const declaredHeight = animation && Number.isInteger(animation.height) ? animation.height : null;
          let frameWidth = declaredWidth ?? (animation && declaredHeight === null ? Math.min(width, height) : width);
          let frameHeight = declaredHeight ?? (animation && declaredWidth === null ? Math.min(width, height) : height);
          if (frameWidth <= 0 || frameWidth > width || frameHeight <= 0 || frameHeight > height) { frameWidth = width; frameHeight = height; }
          let firstFrame = Number.isInteger(animation?.frames?.[0]) ? animation.frames[0] : (animation?.frames?.[0]?.index || 0);
          if (!Number.isSafeInteger(firstFrame) || firstFrame < 0 || firstFrame >= Math.floor(width / frameWidth) * Math.floor(height / frameHeight)) firstFrame = 0;
          textures[id] = `data:image/png;base64,${data.toString('base64')}`;
          textureMeta[id] = { width, height, frameWidth, frameHeight, animated: Boolean(animation),
            firstFrame };
          return id;
        }
      }
      warn(`缺失或无效的本地材质: ${id}`);
    }
    if (!textures[MISSING]) {
      textures[MISSING] = `data:image/png;base64,${missingPng().toString('base64')}`;
      textureMeta[MISSING] = { width: 2, height: 2, frameWidth: 2, frameHeight: 2, animated: false, firstFrame: 0 };
    }
    return MISSING;
  }
  const modelCache = new Map();
  function model(id, trail = []) {
    id = resourceId(id);
    if (modelCache.has(id)) return modelCache.get(id);
    if (trail.includes(id) || trail.length >= LIMITS.inheritance) throw new Error(`模型继承循环或过深: ${id}`);
    const own = json(resourcePath(id, 'models', 'json'));
    if (!own) throw new Error(`缺失本地模型: ${id}`);
    let parent = {};
    if (own.parent && !own.parent.startsWith('builtin/') && !own.parent.startsWith('minecraft:builtin/')) {
      parent = model(resourceId(own.parent), [...trail, id]);
    }
    const result = { ...parent, ...own, textures: { ...parent.textures, ...own.textures },
      elements: own.elements === undefined ? parent.elements : own.elements };
    modelCache.set(id, result);
    return result;
  }
  function resolvedTexture(reference, variables) {
    const seen = new Set();
    while (typeof reference === 'string' && reference.startsWith('#')) {
      if (seen.has(reference) || seen.size > 64) return texture(MISSING);
      seen.add(reference);
      reference = variables[reference.slice(1)];
    }
    return texture(reference || MISSING);
  }
  function elementsFor(data) {
    if (!Array.isArray(data.elements)) return [];
    if (data.elements.length > LIMITS.elements) throw new Error('模型元素过多');
    return data.elements.map(element => {
      const from = finiteVector(element.from, [0, 0, 0]); const to = finiteVector(element.to, [16, 16, 16]);
      const faces = Object.create(null);
      for (const direction of DIRECTIONS) {
        const face = element.faces?.[direction];
        if (!face || typeof face !== 'object') continue;
        const uv = Array.isArray(face.uv) && face.uv.length === 4 && face.uv.every(n => Number.isFinite(n) && Math.abs(n) <= 4096) ? face.uv.slice() : defaultUv(direction, from, to);
        faces[direction] = { texture: resolvedTexture(face.texture, data.textures || {}), uv,
          rotation: [0, 90, 180, 270].includes(face.rotation) ? face.rotation : 0,
          ...(Number.isInteger(face.tintindex) ? { tintindex: face.tintindex } : {}),
          ...(DIRECTIONS.includes(face.cullface) ? { cullface: face.cullface } : {}) };
      }
      const result = { from, to, faces, shade: element.shade !== false };
      if (element.rotation && ['x', 'y', 'z'].includes(element.rotation.axis) && Number.isFinite(element.rotation.angle) && Math.abs(element.rotation.angle) <= 360) {
        result.rotation = { origin: finiteVector(element.rotation.origin, [8, 8, 8]), axis: element.rotation.axis,
          angle: element.rotation.angle, rescale: Boolean(element.rotation.rescale) };
      }
      if (Number.isFinite(element.light_emission)) result.light_emission = element.light_emission;
      return result;
    });
  }
  function existsTexture(id) {
    try { return archives.some(a => a.has(resourcePath(id, 'textures', 'png'))); } catch { return false; }
  }
  function entityApproximation(name, properties, particle) {
    const localName = name.split(':')[1];
    const facingY = { north: 0, east: 90, south: 180, west: 270 }[properties.facing] || 0;
    if (/(?:^|_)chest$/.test(localName)) {
      let type = localName === 'ender_chest' ? 'ender' : localName === 'trapped_chest' ? 'trapped' : 'normal';
      if (localName.includes('copper')) type = localName.includes('oxidized') ? 'copper_oxidized' : localName.includes('weathered') ? 'copper_weathered' : localName.includes('exposed') ? 'copper_exposed' : 'copper';
      const tex = texture(`minecraft:entity/chest/${type}`);
      const scale = rect => rect.map(n => n / 4);
      const bodyUv = { up: scale([14, 19, 28, 33]), down: scale([28, 19, 42, 33]), north: scale([14, 33, 28, 43]),
        south: scale([42, 33, 56, 43]), west: scale([0, 33, 14, 43]), east: scale([28, 33, 42, 43]) };
      const lidUv = { up: scale([14, 0, 28, 14]), down: scale([28, 0, 42, 14]), north: scale([14, 14, 28, 19]),
        south: scale([42, 14, 56, 19]), west: scale([0, 14, 14, 19]), east: scale([28, 14, 42, 19]) };
      const lockUv = Object.fromEntries(DIRECTIONS.map(direction => [direction, scale([1, 1, 3, 5])]));
      return { parts: [{ x: 0, y: facingY, uvlock: false, elements: [box([1, 0, 1], [15, 10, 15], tex, bodyUv),
        box([1, 10, 1], [15, 14, 15], tex, lidUv), box([7, 8, 0], [9, 12, 1], tex, lockUv)] }], reason: '箱子使用本地实体材质与静态近似模型；双箱连接和开盖动画未模拟' };
    }
    if (localName.endsWith('shulker_box')) {
      const color = localName === 'shulker_box' ? '' : `_${localName.slice(0, -12)}`;
      const tex = texture(`minecraft:entity/shulker/shulker${color}`);
      const scale = rect => rect.map(n => n / 4);
      const uv = { up: scale([16, 0, 32, 16]), down: scale([32, 28, 48, 44]),
        north: scale([16, 16, 32, 32]), south: scale([48, 16, 64, 32]), west: scale([0, 16, 16, 32]), east: scale([32, 16, 48, 32]) };
      return { parts: [{ x: properties.facing === 'down' ? 180 : (properties.facing === 'up' || !properties.facing ? 0 : 90),
        y: facingY, uvlock: false, elements: [box([0, 0, 0], [16, 16, 16], tex, uv)] }], reason: '潜影盒使用本地实体材质与静态近似模型；未模拟开盖' };
    }
    if (localName.endsWith('_bed')) {
      const color = localName.slice(0, -4);
      let texId = `minecraft:entity/bed/${color}`;
      if (!existsTexture(texId)) texId = `minecraft:block/${color}_wool`;
      const tex = texture(texId);
      const element = box([0, 3, 0], [16, 9, 16], tex);
      return { parts: [{ x: 0, y: facingY, uvlock: false, elements: [element] }], reason: '床使用本地材质与静态近似模型' };
    }
    if (localName.endsWith('_sign')) {
      const wall = localName.includes('_wall_');
      const hanging = localName.includes('_hanging_');
      const wood = localName.replace(/_(wall_)?(hanging_)?sign$/, '');
      let tex = texture(`minecraft:entity/signs/${wood}`);
      const signUv = Object.fromEntries(Object.entries({ up: [2, 0, 26, 2], down: [26, 0, 50, 2],
        north: [2, 2, 26, 14], south: [28, 2, 52, 14], west: [0, 2, 2, 14], east: [26, 2, 28, 14] })
        .map(([direction, uv]) => [direction, [uv[0] / 4, uv[1] / 2, uv[2] / 4, uv[3] / 2]]));
      const elements = [box([0, wall ? 4 : 8, wall ? 14 : 7], [16, wall ? 12 : 16, wall ? 16 : 9], tex, signUv)];
      if (!wall && !hanging) elements.push(box([7, 0, 7], [9, 8, 9], texture(`minecraft:block/${wood}_planks`)));
      if (hanging) {
        tex = texture(`minecraft:block/${wood}_planks`);
        elements.splice(0, elements.length, box([1, 1, 7], [15, 12, 9], tex),
          box([3, 12, 7], [4, 16, 9], tex), box([12, 12, 7], [13, 16, 9], tex));
      }
      return { parts: [{ x: 0, y: wall ? facingY : (Number(properties.rotation) || 0) * 22.5, uvlock: false, elements }],
        reason: '告示牌使用本地木材与静态近似模型；文字仍可在 NBT 面板中查看' };
    }
    if (localName.endsWith('_banner')) {
      const wall = localName.includes('_wall_');
      const color = localName.replace(/_(wall_)?banner$/, '');
      const cloth = texture(`minecraft:block/${color}_wool`);
      const pole = texture('minecraft:block/oak_planks');
      const elements = [box([1, 1, wall ? 13 : 7], [15, wall ? 16 : 29, wall ? 14 : 8], cloth)];
      if (!wall) elements.push(box([7, 0, 7], [9, 29, 9], pole));
      return { parts: [{ x: 0, y: wall ? facingY : (Number(properties.rotation) || 0) * 22.5, uvlock: false, elements }],
        reason: '旗帜使用本地对应颜色材质与静态近似模型；图案保存在 NBT 面板中' };
    }
    if (localName === 'decorated_pot') {
      const side = texture('minecraft:entity/decorated_pot/decorated_pot_side');
      const top = texture('minecraft:block/terracotta');
      return { parts: [{ x: 0, y: facingY, uvlock: false, elements: [box([1, 0, 1], [15, 14, 15], side),
        box([5, 14, 5], [11, 16, 11], top)] }], reason: '饰纹陶罐使用本地材质与静态近似模型；陶片图案保存在 NBT 面板中' };
    }
    const tex = particle || texture(existsTexture(`${name.split(':')[0]}:block/${localName}`) ? `${name.split(':')[0]}:block/${localName}` : MISSING);
    return { parts: [{ x: 0, y: 0, uvlock: false, elements: [box([0, 0, 0], [16, 16, 16], tex)] }], reason: '此方块没有可读取的静态元素，使用材质立方体近似' };
  }

  const lang = Object.create(null);
  function mergeLanguage(value) { if (value) for (const [key, text] of Object.entries(value)) if (typeof text === 'string') lang[key] = text; }
  mergeLanguage(json('assets/minecraft/lang/en_us.json'));
  const gameRoot = findGameRoot(jarPath);
  const launcherVersion = localJson(path.join(path.dirname(jarPath), `${path.basename(jarPath, path.extname(jarPath))}.json`));
  function loadIndexedChinese() {
    for (const root of [...new Set([gameRoot, ...gameRoots()])]) {
      const indexDir = path.join(root, 'assets', 'indexes');
      let names;
      try { names = fs.readdirSync(indexDir).filter(n => n.endsWith('.json')); } catch { continue; }
      const preferred = `${launcherVersion?.assetIndex?.id}.json`;
      names.sort((a, b) => a === preferred ? -1 : b === preferred ? 1 : b.localeCompare(a, undefined, { numeric: true }));
      for (const name of names.slice(0, 16)) {
        const index = localJson(path.join(indexDir, name));
        const hash = index?.objects?.['minecraft/lang/zh_cn.json']?.hash;
        if (!/^[a-f0-9]{40}$/.test(hash || '')) continue;
        const language = localJson(path.join(root, 'assets', 'objects', hash.slice(0, 2), hash));
        if (language) { mergeLanguage(language); return true; }
      }
    }
    return false;
  }
  const chineseFound = loadIndexedChinese();
  mergeLanguage(json('assets/minecraft/lang/zh_cn.json'));
  if (!chineseFound && !json('assets/minecraft/lang/zh_cn.json')) warn('本地未找到简体中文语言包，缺失名称使用英文或方块 ID');
  const blocks = palette.map(entry => {
    let state;
    try { state = parsePaletteEntry(entry); } catch (error) {
      warn(error.message);
      return { name: String(entry?.Name || entry?.name || entry), label: '无效方块', parts: [], fallback: true };
    }
    const { name, properties } = state;
    const translationKey = `block.${name.replace(':', '.').replace(/\//g, '.')}`;
    const result = { name, properties, label: lang[translationKey] || lang[translationKey.replace(/^block\./, 'item.')] || name, parts: [] };
    if (AIR.has(name)) return result;
    if (name === 'minecraft:water' || name === 'minecraft:lava' || name === 'minecraft:bubble_column') {
      const liquid = name === 'minecraft:lava' ? 'lava' : 'water'; const level = Number(properties.level || 0);
      const height = name === 'minecraft:bubble_column' || level >= 8 ? 16 : Math.max(2, (8 - level) * 16 / 9);
      const still = texture(`minecraft:block/${liquid}_still`); const flow = texture(`minecraft:block/${liquid}_flow`);
      const element = box([0, 0, 0], [16, height, 16], still);
      for (const direction of ['north', 'south', 'west', 'east']) element.faces[direction].texture = flow;
      if (liquid === 'water') for (const face of Object.values(element.faces)) face.tintindex = 0;
      result.parts = [{ x: 0, y: 0, uvlock: false, elements: [element] }];
      result.fluid = true;
      result.transparent = liquid === 'water';
      return result;
    }
    let particle;
    try {
      const blockstate = json(resourcePath(name, 'blockstates', 'json'));
      if (!blockstate) throw new Error(`缺失本地方块状态: ${name}`);
      const definitions = [];
      if (blockstate.variants && typeof blockstate.variants === 'object') {
        const matching = Object.entries(blockstate.variants).find(([key]) => variantMatches(key, properties));
        if (matching) definitions.push(chooseModel(matching[1]));
      }
      if (Array.isArray(blockstate.multipart)) for (const piece of blockstate.multipart) {
        if (conditionMatches(piece.when, properties)) definitions.push(chooseModel(piece.apply));
      }
      for (const definition of definitions.filter(Boolean)) {
        const data = model(definition.model);
        if (!particle && data.textures?.particle) particle = resolvedTexture(data.textures.particle, data.textures);
        const elements = elementsFor(data);
        if (elements.length) result.parts.push({ elements, x: [0, 90, 180, 270].includes(definition.x) ? definition.x : 0,
          y: [0, 90, 180, 270].includes(definition.y) ? definition.y : 0, uvlock: Boolean(definition.uvlock),
          ambientocclusion: data.ambientocclusion !== false });
      }
      // Empty multipart is legitimate (e.g. a disconnected wall without a post).
      if (!definitions.length && Array.isArray(blockstate.multipart)) return result;
      if (result.parts.length) return result;
    } catch (error) { warn(`${name}: ${error.message}`); }
    const approximation = entityApproximation(name, properties, particle);
    result.parts = approximation.parts; result.fallback = true; result.fallbackReason = approximation.reason;
    warn(`${name}: ${approximation.reason}`);
    return result;
  });
  return { blocks, textures, textureMeta, lang, source: { path: path.resolve(jarPath), version: metadata.id || path.basename(jarPath, '.jar'),
    gameDirectory: gameRoot, resourcePackPath: options.resourcePackPath ? path.resolve(options.resourcePackPath) : null }, warnings: [...warnings] };
}

module.exports = { discoverGameResources, loadAssets, _test: { resourceId, cleanZipPath, conditionMatches, variantMatches, defaultUv, parsePaletteEntry } };
