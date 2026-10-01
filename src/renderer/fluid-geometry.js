import * as THREE from 'three';

// Static fluid preview, not a fluid simulator. A 1/16 horizontal grid follows
// vanilla model pixels; vertical cuts also contain every 1/9 fluid level. Solid
// model parts are voxelized once per asset, including model/element rotations.
const X = Array.from({ length: 17 }, (_, i) => i / 16);
const Y = [...new Set([...X, ...Array.from({ length: 10 }, (_, i) => i / 9)])].sort((a, b) => a - b);
const CUTS = [X, Y, X], SIZE = [16, Y.length - 1, 16];
const CELLS = SIZE[0] * SIZE[1] * SIZE[2], EPS = 1e-7;
const DIRECTIONS = [
  { name: 'north', axis: 2, sign: -1, offset: [0, 0, -1], opposite: 'south', planar: [0, 1] },
  { name: 'south', axis: 2, sign: 1, offset: [0, 0, 1], opposite: 'north', planar: [0, 1] },
  { name: 'west', axis: 0, sign: -1, offset: [-1, 0, 0], opposite: 'east', planar: [2, 1] },
  { name: 'east', axis: 0, sign: 1, offset: [1, 0, 0], opposite: 'west', planar: [2, 1] },
  { name: 'up', axis: 1, sign: 1, offset: [0, 1, 0], opposite: 'down', planar: [0, 2] },
  { name: 'down', axis: 1, sign: -1, offset: [0, -1, 0], opposite: 'up', planar: [0, 2] },
];
const ASSET_CACHE = new WeakMap();
const POROUS = /(?:_leaves$|(?:^|_)copper_grate$|^mangrove_roots$)/;
const cellIndex = (x, y, z) => (y * SIZE[2] + z) * SIZE[0] + x;
const positionKey = b => `${b.x},${b.y},${b.z}`;

export function isWaterState(state, asset) {
  return state?.Name === 'minecraft:water' || state?.Name === 'minecraft:bubble_column' || state?.Properties?.waterlogged === 'true' || asset?.waterlogged === true;
}

/** Source/contained water is 8/9 high. Falling columns are drawn full-height;
 * visible water above joins the block at 1. No flow propagation is simulated. */
export function waterHeight(state, connectedAbove = false) {
  if (connectedAbove) return 1;
  if (state?.Name === 'minecraft:bubble_column') return 8 / 9;
  if (state?.Name !== 'minecraft:water') return 8 / 9;
  const raw = Number(state.Properties?.level ?? 0), level = Number.isFinite(raw) ? Math.max(0, Math.min(15, Math.floor(raw))) : 0;
  return level >= 8 ? 1 : (8 - level) / 9;
}

function modelBoxes(asset) {
  const boxes = [], translation = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  for (const part of asset?.parts || []) {
    const block = translation(0.5, 0.5, 0.5)
      .multiply(new THREE.Matrix4().makeRotationY(-(part.y || 0) * Math.PI / 180))
      .multiply(new THREE.Matrix4().makeRotationX(-(part.x || 0) * Math.PI / 180))
      .multiply(translation(-0.5, -0.5, -0.5));
    for (const element of part.elements || []) {
      const from = (element.from || [0, 0, 0]).map(v => v / 16), to = (element.to || [16, 16, 16]).map(v => v / 16);
      if (from.some((v, i) => !Number.isFinite(v) || !Number.isFinite(to[i]) || to[i] - v < EPS)) continue;
      let transform = block.clone();
      if (element.rotation?.axis) {
        const rotation = element.rotation, angle = (rotation.angle || 0) * Math.PI / 180;
        const origin = (rotation.origin || [8, 8, 8]).map(v => v / 16), scale = [1, 1, 1];
        const axis = { x: 0, y: 1, z: 2 }[rotation.axis] ?? 1;
        if (rotation.rescale) for (let i = 0; i < 3; i++) if (i !== axis) scale[i] = 1 / Math.max(0.01, Math.cos(angle));
        const direction = new THREE.Vector3().setComponent(axis, 1);
        transform.multiply(translation(...origin)).multiply(new THREE.Matrix4().makeScale(...scale))
          .multiply(new THREE.Matrix4().makeRotationAxis(direction, angle)).multiply(translation(...origin.map(v => -v)));
      }
      boxes.push({ from, to, inverse: transform.invert().elements });
    }
  }
  return boxes;
}

function solidCells(asset, pureWater) {
  const cells = new Uint8Array(CELLS);
  if (pureWater) return cells;
  const boxes = modelBoxes(asset);
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const px = (x + 0.5) / 16, py = (Y[y] + Y[y + 1]) / 2, pz = (z + 0.5) / 16;
    for (const { inverse: m, from, to } of boxes) {
      const a = m[0] * px + m[4] * py + m[8] * pz + m[12];
      const b = m[1] * px + m[5] * py + m[9] * pz + m[13];
      const c = m[2] * px + m[6] * py + m[10] * pz + m[14];
      if (a > from[0] - EPS && a < to[0] + EPS && b > from[1] - EPS && b < to[1] + EPS && c > from[2] - EPS && c < to[2] + EPS) { cells[cellIndex(x, y, z)] = 1; break; }
    }
  }
  return cells;
}

function boundaryMask(cells, direction) {
  const [u, v] = direction.planar, width = SIZE[u], height = SIZE[v], mask = new Uint8Array(width * height), p = [0, 0, 0];
  p[direction.axis] = direction.sign > 0 ? SIZE[direction.axis] - 1 : 0;
  for (let b = 0; b < height; b++) for (let a = 0; a < width; a++) {
    p[u] = a; p[v] = b; mask[b * width + a] = cells[cellIndex(...p)];
  }
  return mask;
}

// Greedy rectangles retain physical UV coordinates; merging never stretches a
// whole texture over a tiny model gap or creates overlapping coplanar faces.
function rectangles(mask, direction, plane) {
  const remaining = mask.slice(), [u, v] = direction.planar, width = SIZE[u], height = SIZE[v], result = [];
  for (let b = 0; b < height; b++) for (let a = 0; a < width; a++) {
    if (!remaining[b * width + a]) continue;
    let right = a + 1; while (right < width && remaining[b * width + right]) right++;
    let bottom = b + 1;
    outer: while (bottom < height) { for (let x = a; x < right; x++) if (!remaining[bottom * width + x]) break outer; bottom++; }
    for (let y = b; y < bottom; y++) remaining.fill(0, y * width + a, y * width + right);
    const from = [0, 0, 0], to = [0, 0, 0];
    from[direction.axis] = to[direction.axis] = plane;
    from[u] = CUTS[u][a]; to[u] = CUTS[u][right]; from[v] = CUTS[v][b]; to[v] = CUTS[v][bottom];
    result.push({ direction: direction.name, from, to });
  }
  return result;
}

function stateCache(asset, state, fallbackCache) {
  const pureWater = state.Name === 'minecraft:water' || state.Name === 'minecraft:bubble_column';
  // These vanilla blocks describe their holes with alpha-cutout textures on a
  // full cube. Their box is not a solid volume. Do not guess this for unknown
  // modded/full-cube models; an explicit asset flag can opt them in.
  const porous = isWaterState(state, asset) && (asset?.fluidPorous === true || state.Name.startsWith('minecraft:') && POROUS.test(state.Name.slice(10)));
  const key = pureWater ? 'water' : porous ? 'porous' : 'solid';
  const owner = asset && typeof asset === 'object' ? asset : state;
  let cache = owner && typeof owner === 'object' ? ASSET_CACHE.get(owner) : fallbackCache.get(key);
  if (!cache || cache.kind !== key) {
    const solid = solidCells(asset, pureWater || porous), boundaries = {};
    for (const direction of DIRECTIONS) boundaries[direction.name] = boundaryMask(solid, direction);
    cache = { kind: key, porous, solid, boundaries, shapes: new Map(), bottomOpen: boundaries.down.some(value => value === 0) };
    if (owner && typeof owner === 'object') ASSET_CACHE.set(owner, cache); else fallbackCache.set(key, cache);
  }
  return cache;
}

function fluidShape(cache, height) {
  if (cache.shapes.has(height)) return cache.shapes.get(height);
  const cells = new Uint8Array(CELLS), boundaries = {}, internal = [];
  for (let y = 0; y < SIZE[1] && Y[y] < height - EPS; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const index = cellIndex(x, y, z); if (!cache.solid[index]) cells[index] = 1;
  }
  for (const direction of DIRECTIONS) {
    boundaries[direction.name] = boundaryMask(cells, direction);
    const [u, v] = direction.planar, width = SIZE[u], rows = SIZE[v];
    for (let plane = 1; plane < SIZE[direction.axis]; plane++) {
      const mask = new Uint8Array(width * rows), p = [0, 0, 0];
      for (let b = 0; b < rows; b++) for (let a = 0; a < width; a++) {
        p[u] = a; p[v] = b; p[direction.axis] = direction.sign > 0 ? plane - 1 : plane;
        if (!cells[cellIndex(...p)]) continue;
        p[direction.axis] += direction.sign;
        const adjacent = cellIndex(...p);
        if (!cells[adjacent] && !cache.solid[adjacent]) mask[b * width + a] = 1;
      }
      internal.push(...rectangles(mask, direction, CUTS[direction.axis][plane]));
    }
  }
  const shape = { cells, boundaries, internal }; cache.shapes.set(height, shape); return shape;
}

function facePoints(direction, a, b) {
  const [x0, y0, z0] = a, [x1, y1, z1] = b;
  switch (direction) {
    case 'north': return [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]];
    case 'south': return [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]];
    case 'west': return [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]];
    case 'east': return [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]];
    case 'up': return [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]];
    default: return [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]];
  }
}

function opaqueSolid(state, asset, atlas) {
  if (asset?.transparent || state.Name.startsWith('minecraft:') && POROUS.test(state.Name.slice(10)) || /(?:glass|:ice$|:frosted_ice$|:slime_block$|:honey_block$)/.test(state.Name)) return false;
  // Resource packs can make an otherwise solid block translucent. Match the
  // viewer's atlas-derived blending classification before hiding a water face.
  return !(asset?.parts || []).some(part => (part.elements || []).some(element =>
    Object.values(element.faces || {}).some(face => atlas.regions?.[face?.texture]?.translucent === true)));
}

/** Water and waterlogged volumes in WORLD coordinates, ready to merge into the
 * viewer's one globally sorted transparent batch. The solid host block remains
 * in its usual rendering path. Only visible neighbours hide cut faces.
 *
 * Asset contract: assets.fluids.water = { still, flow, tint }; all referenced
 * texture IDs already exist in the shared atlas. Sloped/curved custom elements
 * use a model-pixel approximation; known porous full cubes (leaves, copper
 * grates, mangrove roots) contain inset water visible behind their cutouts.
 * Their individual texture holes are not voxelized. Unknown models retain the
 * conservative solid-volume rule. There is no flow/biome/lighting simulation.
 */
export function buildFluidGeometry(schematic, visibleIndices, assets = {}, atlas = {}) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [], blockIndices = [], centers = [];
  const occupied = new Map(), descriptors = new Map(), fallbackCache = new Map(), opacityCache = new Map();
  const visible = [...new Set(visibleIndices)].filter(index => Number.isInteger(index) && schematic.blocks[index]);
  for (const index of visible) occupied.set(positionKey(schematic.blocks[index]), index);
  const descriptor = index => {
    if (index == null) return null;
    if (descriptors.has(index)) return descriptors.get(index);
    const block = schematic.blocks[index], state = schematic.palette[block.state], asset = assets.blocks?.[block.state];
    const water = isWaterState(state, asset), cache = stateCache(asset, state, fallbackCache);
    // Cache per state for this atlas/build. Model traversal must not run for
    // every fluid instance, and a newly selected resource pack must be re-read.
    if (!opacityCache.has(block.state)) opacityCache.set(block.state, opaqueSolid(state, asset, atlas));
    const result = { block, state, asset, water, cache, opaque: opacityCache.get(block.state) }; descriptors.set(index, result); return result;
  };
  const shapeFor = item => {
    if (item.shape) return item.shape;
    const b = item.block, above = descriptor(occupied.get(`${b.x},${b.y + 1},${b.z}`));
    return item.shape = fluidShape(item.cache, waterHeight(item.state, above?.water && above.cache.bottomOpen));
  };
  const fluid = assets.fluids?.water || {}, tint = new THREE.Color(fluid.tint ?? 0x3f76e4);
  const regionFor = direction => {
    const texture = direction === 'up' || direction === 'down' ? fluid.still || 'minecraft:block/water_still' : fluid.flow || 'minecraft:block/water_flow';
    return atlas.regions?.[texture] || atlas.regions?.__missing__ || Object.values(atlas.regions || {})[0] || { x: 0, y: 0, width: 1, height: 1 };
  };
  let waterBlocks = 0, waterloggedBlocks = 0, porousBlocks = 0;
  function emit(quad, block, index, porous) {
    const points = facePoints(quad.direction, quad.from, quad.to), definition = DIRECTIONS.find(d => d.name === quad.direction);
    const region = regionFor(quad.direction), start = positions.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (const p of points) {
      // Boundary planes behind a porous model must not compete with its
      // coplanar cutout texture. Keep surface UVs and adjacency masks unchanged.
      if (porous && (Math.abs(quad.from[definition.axis]) < EPS || Math.abs(quad.from[definition.axis] - 1) < EPS)) p[definition.axis] -= definition.sign * 0.001;
      const x = p[0] + block.x, y = p[1] + block.y, z = p[2] + block.z;
      positions.push(x, y, z); cx += x; cy += y; cz += z;
      normals.push(...definition.offset); colors.push(tint.r, tint.g, tint.b);
      const u = quad.direction === 'north' ? 1 - p[0] : quad.direction === 'east' ? 1 - p[2] : definition.axis === 0 ? p[2] : p[0];
      const v = definition.axis === 1 ? (quad.direction === 'down' ? 1 - p[2] : p[2]) : 1 - p[1];
      // Liquid side faces use half of the flowing sprite in each direction.
      // This is sprite semantics, independent of a resource pack's resolution.
      const uvScale = definition.axis === 1 ? 1 : 0.5;
      uvs.push((region.x + 0.02 + u * uvScale * (region.width - 0.04)) / (atlas.width || 1), 1 - (region.y + 0.02 + v * uvScale * (region.height - 0.04)) / (atlas.height || 1));
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    centers.push(cx / 4, cy / 4, cz / 4); blockIndices.push(index);
  }
  for (const index of visible) {
    const block = schematic.blocks[index], state = schematic.palette[block.state], asset = assets.blocks?.[block.state];
    if (!isWaterState(state, asset) || occupied.get(positionKey(block)) !== index) continue;
    const item = descriptor(index), shape = shapeFor(item);
    waterBlocks++; if (state.Properties?.waterlogged === 'true' || asset?.waterlogged) waterloggedBlocks++;
    if (item.cache.porous) porousBlocks++;
    for (const quad of shape.internal) emit(quad, block, index, item.cache.porous);
    for (const direction of DIRECTIONS) {
      const base = shape.boundaries[direction.name]; if (!base.some(Boolean)) continue;
      const neighbor = descriptor(occupied.get(`${block.x + direction.offset[0]},${block.y + direction.offset[1]},${block.z + direction.offset[2]}`));
      const waterMask = neighbor?.water ? shapeFor(neighbor).boundaries[direction.opposite] : null;
      const solidMask = neighbor?.opaque ? neighbor.cache.boundaries[direction.opposite] : null;
      const mask = base.slice();
      if (neighbor) for (let i = 0; i < mask.length; i++) if (waterMask?.[i] || solidMask?.[i]) mask[i] = 0;
      for (const quad of rectangles(mask, direction, direction.sign > 0 ? 1 : 0)) emit(quad, block, index, item.cache.porous);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.userData = { blockIndices, centers: new Float32Array(centers), faceOrder: Array.from({ length: blockIndices.length }, (_, i) => i), depths: new Float32Array(blockIndices.length),
    fluidPreview: true, approximation: 'static-model-pixel-fluid', waterBlocks, waterloggedBlocks, porousBlocks, voxelResolution: [...SIZE] };
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
