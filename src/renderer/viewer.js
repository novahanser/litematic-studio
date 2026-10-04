import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildFluidGeometry } from './fluid-geometry.js';
import { attachCursorZoom } from './cursor-zoom.js';
import { faceVertexUVs } from './model-uv.js';

const DEG = Math.PI / 180;
const FACE_NORMALS = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const FULL_ELEMENT = { from: [0, 0, 0], to: [16, 16, 16] };
const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };

function boundaryOf(points, normal) {
  for (const [direction, vector] of Object.entries(FACE_NORMALS)) {
    if (normal.dot(new THREE.Vector3(...vector)) < 0.99999) continue;
    const axis = vector.findIndex(n => n !== 0), value = vector[axis] > 0 ? 1 : 0;
    if (points.every(point => Math.abs(point.getComponent(axis) - value) < 0.00001)) return direction;
  }
  return null;
}

// Subtract a neighbour's coverage without discarding the exposed part of a
// pane/ice face. Several multipart boxes may jointly cover one surface.
export function subtractFaceRectangle(rect, cover) {
  const lo = rect.min.map((v, i) => Math.max(v, cover.min[i]));
  const hi = rect.max.map((v, i) => Math.min(v, cover.max[i]));
  if (hi.some((v, i) => v - lo[i] < 0.00001)) return [rect];
  return [
    { min: [rect.min[0], rect.min[1]], max: [lo[0], rect.max[1]] },
    { min: [hi[0], rect.min[1]], max: [rect.max[0], rect.max[1]] },
    { min: [lo[0], rect.min[1]], max: [hi[0], lo[1]] },
    { min: [lo[0], hi[1]], max: [hi[0], rect.max[1]] },
  ].filter(piece => piece.max.every((v, i) => v - piece.min[i] > 0.00001));
}

function corners(direction, from, to) {
  const [x0, y0, z0] = from, [x1, y1, z1] = to;
  switch (direction) {
    case 'north': return [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]];
    case 'south': return [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]];
    case 'west': return [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]];
    case 'east': return [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]];
    case 'up': return [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]];
    case 'down': return [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]];
    default: return null;
  }
}

export function defaultFaceUV(direction, from, to) {
  const [x0, y0, z0] = from, [x1, y1, z1] = to;
  switch (direction) {
    case 'down': return [x0, 16 - z1, x1, 16 - z0];
    case 'up': return [x0, z0, x1, z1];
    case 'north': return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south': return [x0, 16 - y1, x1, 16 - y0];
    case 'west': return [z0, 16 - y1, z1, 16 - y0];
    case 'east': return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
    default: return [0, 0, 16, 16];
  }
}

function partRotation(part) {
  const x = new THREE.Matrix4().makeRotationX(-(part.x || 0) * DEG);
  return new THREE.Matrix4().makeRotationY(-(part.y || 0) * DEG).multiply(x);
}

function tintFor(block, face, asset) {
  const name = block?.Name || '', props = block?.Properties || {};
  if (face.tintindex == null && !name.endsWith(':water')) return new THREE.Color(1, 1, 1);
  if (asset?.tint) return new THREE.Color(asset.tint);
  if (name.includes('redstone_wire')) {
    const power = Math.max(0, Math.min(15, Number(props.power || 0))) / 15;
    return new THREE.Color().setRGB(power * 0.6 + (power > 0 ? 0.4 : 0.3), Math.max(0, power * power * 0.7 - 0.5), Math.max(0, power * power * 0.6 - 0.7), THREE.SRGBColorSpace);
  }
  if (name.includes('water') || name.endsWith(':bubble_column')) return new THREE.Color(0x3f76e4);
  if (name.includes('birch')) return new THREE.Color(0x80a755);
  if (name.includes('spruce')) return new THREE.Color(0x619961);
  if (name.includes('lily_pad')) return new THREE.Color(0x208030);
  if (name.includes('stem')) return new THREE.Color(0xa0b000);
  if (name.includes('leaves') || name.includes('vine')) return new THREE.Color(0x77ab2f);
  return new THREE.Color(0x91bd59);
}

/** Build one Minecraft blockstate mesh in local [0,1] block coordinates.
 * Pure geometry helper: it can be exercised in Node without a DOM or GPU. */
export function buildStateGeometry(asset, block, atlas) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [];
  const quads = [];
  const fallbackTexture = Object.keys(atlas.regions || {})[0] || '__missing__';
  const parts = Array.isArray(asset?.parts) ? asset.parts : [{ elements: [{ ...FULL_ELEMENT, faces: Object.fromEntries(Object.keys(FACE_NORMALS).map(d => [d, { texture: '__missing__' }])) }] }];
  for (const part of parts) {
    const blockRotation = partRotation(part);
    for (const element of part.elements || []) {
      const from = element.from || [0, 0, 0], to = element.to || [16, 16, 16];
      const elementRotation = element.rotation;
      let rotation = null, origin = null, scale = null;
      if (elementRotation?.axis) {
        const angle = (elementRotation.angle || 0) * DEG;
        const axis = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[elementRotation.axis];
        rotation = new THREE.Matrix4().makeRotationAxis(axis || new THREE.Vector3(0, 1, 0), angle);
        origin = new THREE.Vector3(...(elementRotation.origin || [8, 8, 8])).divideScalar(16);
        scale = new THREE.Vector3(1, 1, 1);
        if (elementRotation.rescale) {
          const amount = 1 / Math.max(0.01, Math.cos(angle));
          for (const a of ['x', 'y', 'z']) if (a !== elementRotation.axis) scale[a] = amount;
        }
      }
      for (const [direction, face] of Object.entries(element.faces || {})) {
        if (!FACE_NORMALS[direction] || !face) continue;
        const raw = corners(direction, from, to);
        const points = raw.map(p => {
          const v = new THREE.Vector3(...p).divideScalar(16);
          if (rotation) v.sub(origin).applyMatrix4(rotation).multiply(scale).add(origin);
          return v.subScalar(0.5).applyMatrix4(blockRotation).addScalar(0.5);
        });
        const normal = new THREE.Vector3().subVectors(points[1], points[0]).cross(new THREE.Vector3().subVectors(points[2], points[0])).normalize();
        const uv = face.uv || defaultFaceUV(direction, from, to);
        const sourceUVs = faceVertexUVs(direction, uv, face.rotation || 0, part);
        const region = atlas.regions[face.texture] || atlas.regions.__missing__ || atlas.regions[fallbackTexture];
        const tint = tintFor(block, face, asset);
        const start = positions.length / 3;
        const boundary = boundaryOf(points, normal);
        const worldDirection = Object.keys(FACE_NORMALS).find(name => normal.dot(new THREE.Vector3(...FACE_NORMALS[name])) > 0.99999) || null;
        const axis = worldDirection ? FACE_NORMALS[worldDirection].findIndex(n => n !== 0) : -1;
        const planarAxes = [0, 1, 2].filter(n => n !== axis);
        quads.push({ boundary, direction: worldDirection, planarAxes, opaque: region.opaque === true, min: planarAxes.map(a => Math.min(...points.map(p => p.getComponent(a)))), max: planarAxes.map(a => Math.max(...points.map(p => p.getComponent(a)))) });
        for (let i = 0; i < 4; i++) {
          positions.push(points[i].x, points[i].y, points[i].z);
          normals.push(normal.x, normal.y, normal.z);
          colors.push(tint.r, tint.g, tint.b);
          const [u, v] = sourceUVs[i];
          // A small inset keeps nearest-neighbour sampling inside this atlas tile.
          const px = region.x + 0.02 + (u / 16) * (region.width - 0.04);
          const py = region.y + 0.02 + (v / 16) * (region.height - 0.04);
          uvs.push(px / atlas.width, 1 - py / atlas.height);
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.userData.quads = quads;
  geometry.userData.hasTranslucentTexture = parts.some(part => (part.elements || []).some(element =>
    Object.values(element.faces || {}).some(face => atlas.regions[face.texture]?.translucent)));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function imageFromURI(uri) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = uri;
  });
}

async function createAtlas(assets, limit) {
  const entries = Object.entries(assets.textures || {});
  const loaded = await Promise.all(entries.map(async ([id, uri]) => ({ id, image: await imageFromURI(typeof uri === 'string' ? uri : uri.dataURI), meta: assets.textureMeta?.[id] || {} })));
  const tiles = loaded.filter(v => v.image).map(v => ({ ...v, width: Math.max(1, Math.min(v.image.width, v.meta.frameWidth || v.image.width)), height: Math.max(1, Math.min(v.image.height, v.meta.frameHeight || (v.meta.animated ? v.image.width : v.image.height))) }));
  tiles.push({ id: '__missing__', width: 16, height: 16 });
  tiles.sort((a, b) => b.height - a.height);
  const area = tiles.reduce((n, t) => n + (t.width + 4) * (t.height + 4), 0);
  let size = THREE.MathUtils.ceilPowerOfTwo(Math.max(64, Math.sqrt(area) * 1.1, ...tiles.map(t => Math.max(t.width, t.height) + 4)));
  let regions;
  while (size <= limit) {
    regions = {};
    let x = 2, y = 2, row = 0;
    for (const tile of tiles) {
      if (x + tile.width + 2 > size) { x = 2; y += row + 4; row = 0; }
      regions[tile.id] = { x, y, width: tile.width, height: tile.height };
      x += tile.width + 4; row = Math.max(row, tile.height);
    }
    if (y + row + 2 <= size) break;
    size *= 2;
  }
  if (size > limit) throw new Error(`材质图集超过显卡上限 ${limit} 像素，请使用较小的资源包。`);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (const tile of tiles) {
    const r = regions[tile.id];
    if (tile.image) {
      const columns = Math.max(1, Math.floor(tile.image.width / tile.width));
      const totalFrames = columns * Math.max(1, Math.floor(tile.image.height / tile.height));
      const frame = Math.max(0, Math.min(totalFrames - 1, Number(tile.meta.firstFrame || 0)));
      ctx.drawImage(tile.image, (frame % columns) * tile.width, Math.floor(frame / columns) * tile.height, tile.width, tile.height, r.x, r.y, r.width, r.height);
    }
    else {
      ctx.fillStyle = '#160b20'; ctx.fillRect(r.x, r.y, 16, 16);
      ctx.fillStyle = '#eb28cb'; ctx.fillRect(r.x, r.y, 8, 8); ctx.fillRect(r.x + 8, r.y + 8, 8, 8);
    }
    const pixels = ctx.getImageData(r.x, r.y, r.width, r.height).data;
    r.opaque = true;
    r.translucent = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) r.opaque = false;
      if (pixels[i] > 0 && pixels[i] < 255) r.translucent = true;
    }
    // Keep only alpha for non-opaque tiles. Raycasting otherwise hits the
    // invisible rectangles around chains, trapdoors, leaves and redstone.
    if (!r.opaque) r.alpha = Uint8Array.from({ length: r.width * r.height }, (_, i) => pixels[i * 4 + 3]);
    // Duplicate edge texels into gutters to avoid dark seams at oblique angles.
    ctx.drawImage(canvas, r.x, r.y, r.width, 1, r.x, r.y - 1, r.width, 1);
    ctx.drawImage(canvas, r.x, r.y + r.height - 1, r.width, 1, r.x, r.y + r.height, r.width, 1);
    ctx.drawImage(canvas, r.x, r.y, 1, r.height, r.x - 1, r.y, 1, r.height);
    ctx.drawImage(canvas, r.x + r.width - 1, r.y, 1, r.height, r.x + r.width, r.y, 1, r.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, regions, width: size, height: size, alphaReady: true };
}

/** Sample the same nearest-filtered atlas texel used by the block material.
 * Alpha planes exclude the atlas's empty space and opaque tiles to keep CPU
 * memory small even when a resource pack supplies large textures. */
export function sampleAtlasAlpha(atlas, uv) {
  if (!atlas?.alphaReady || !uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return null;
  const mapped = uv.clone();
  if (atlas.texture) {
    if (atlas.texture.matrixAutoUpdate) atlas.texture.updateMatrix();
    atlas.texture.transformUv(mapped);
  } else mapped.y = 1 - mapped.y;
  const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(mapped.x * atlas.width)));
  const y = Math.min(atlas.height - 1, Math.max(0, Math.floor(mapped.y * atlas.height)));
  for (const region of Object.values(atlas.regions)) {
    // createAtlas duplicates one edge texel into each side's gutter. The four
    // corners remain clear, exactly as they do in the rendered canvas.
    const insideX = x >= region.x && x < region.x + region.width;
    const insideY = y >= region.y && y < region.y + region.height;
    if (!(insideX && y >= region.y - 1 && y <= region.y + region.height)
      && !(insideY && x >= region.x - 1 && x <= region.x + region.width)) continue;
    if (region.opaque) return 1;
    const localX = Math.min(region.width - 1, Math.max(0, x - region.x));
    const localY = Math.min(region.height - 1, Math.max(0, y - region.y));
    return region.alpha[(localY * region.width) + localX] / 255;
  }
  return 0;
}

/** Raycaster tests geometry, while the GPU discards pixels below alphaTest. */
export function atlasHitVisible(hit, atlas) {
  const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex || 0] : hit.object.material;
  if (!material || material.visible === false) return false;
  if (!atlas || material.map !== atlas.texture) return true;
  const alpha = sampleAtlasAlpha(atlas, hit.uv);
  if (alpha == null) return true;
  const effectiveAlpha = alpha * material.opacity;
  return effectiveAlpha >= material.alphaTest && (!material.transparent || effectiveAlpha > 0);
}

export function createBlockMaterial(atlas, transparent = false) {
  // Minecraft model faces are directional. Some redstone models deliberately
  // face luminous quads inward; DoubleSide exposes them as solid red boxes.
  // Models that need both sides already declare both face directions.
  return new THREE.MeshLambertMaterial({ map: atlas.texture, vertexColors: true,
    alphaTest: transparent ? 0.001 : 0.08, transparent, depthWrite: !transparent, side: THREE.FrontSide });
}

export function transparentState(block, asset, geometry) {
  return !!asset?.transparent || !!geometry?.userData.hasTranslucentTexture || /(?:stained_glass|:glass(?:_pane)?$|:water$|:ice$|:frosted_ice$|:slime_block$|:honey_block$)/.test(block?.Name || '');
}

function transparencyFamily(block) {
  const name = block?.Name || '';
  return /:(water|bubble_column)$/.test(name) ? 'water' : /:(ice|frosted_ice)$/.test(name) ? 'ice' : name;
}

/** Merge transparent quads into one sortable batch, eliminating shared surfaces.
 * Visibility is an input: hiding a layer exposes its neighbours' cut faces again. */
export function buildTransparentGeometry(schematic, visibleIndices, stateGeometries, assets, { excludeWater = false } = {}) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [], blockIndices = [], centers = [];
  const occupied = new Map();
  for (const index of visibleIndices) {
    const block = schematic.blocks[index];
    occupied.set(`${block.x},${block.y},${block.z}`, block);
  }
  const fluidScales = new Map();
  function fluidScale(block) {
    if (fluidScales.has(block)) return fluidScales.get(block);
    const above = occupied.get(`${block.x},${block.y + 1},${block.z}`), geometry = stateGeometries.get(block.state);
    const connected = assets.blocks?.[block.state]?.fluid && above && assets.blocks?.[above.state]?.fluid && transparencyFamily(schematic.palette[block.state]) === transparencyFamily(schematic.palette[above.state]);
    const scale = connected && geometry?.boundingBox.max.y > 0 ? 1 / geometry.boundingBox.max.y : 1;
    fluidScales.set(block, scale); return scale;
  }
  function surface(face, scale) {
    if (scale === 1) return face;
    return { ...face, boundary: face.direction === 'up' ? 'up' : face.boundary,
      min: face.min.map((value, index) => face.planarAxes[index] === 1 ? value * scale : value),
      max: face.max.map((value, index) => face.planarAxes[index] === 1 ? value * scale : value) };
  }
  for (const index of visibleIndices) {
    const block = schematic.blocks[index], state = schematic.palette[block.state], asset = assets.blocks?.[block.state];
    const source = stateGeometries.get(block.state);
    if (!source || !transparentState(state, asset, source) || excludeWater && /:(water|bubble_column)$/.test(state.Name)) continue;
    const scale = fluidScale(block);
    for (let faceIndex = 0; faceIndex < source.userData.quads.length; faceIndex++) {
      const face = surface(source.userData.quads[faceIndex], scale);
      let rectangles = [{ min: face.min, max: face.max }];
      if (face.boundary) {
        const offset = FACE_NORMALS[face.boundary];
        const neighbor = occupied.get(`${block.x + offset[0]},${block.y + offset[1]},${block.z + offset[2]}`);
        if (neighbor) {
          const neighborState = schematic.palette[neighbor.state], neighborGeometry = stateGeometries.get(neighbor.state);
          const sameMedium = transparentState(neighborState, assets.blocks?.[neighbor.state], neighborGeometry) && transparencyFamily(state) === transparencyFamily(neighborState);
          const neighborScale = fluidScale(neighbor);
          for (const base of neighborGeometry?.userData.quads || []) {
            const other = surface(base, neighborScale);
            if (other.boundary === OPPOSITE[face.boundary] && (sameMedium || other.opaque)) rectangles = rectangles.flatMap(rect => subtractFaceRectangle(rect, other));
            if (!rectangles.length) break;
          }
        }
      }
      if (!rectangles.length) continue;
      const clipped = rectangles.length !== 1 || rectangles[0].min.some((v,i) => v !== face.min[i]) || rectangles[0].max.some((v,i) => v !== face.max[i]);
      const localPoints = clipped && Array.from({ length: 4 }, (_, vertex) => {
        const at = faceIndex * 4 + vertex;
        return new THREE.Vector3(source.attributes.position.getX(at), source.attributes.position.getY(at) * scale, source.attributes.position.getZ(at));
      });
      const edgeU = clipped && localPoints[3].clone().sub(localPoints[0]), edgeV = clipped && localPoints[1].clone().sub(localPoints[0]);
      for (const rectangle of rectangles) {
      const start = positions.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let vertex = 0; vertex < 4; vertex++) {
        const at = faceIndex * 4 + vertex;
        const point = clipped && localPoints[vertex].clone();
        if (clipped) face.planarAxes.forEach((axis, i) => point.setComponent(axis,
          Math.abs(point.getComponent(axis) - face.min[i]) < 0.00001 ? rectangle.min[i] : rectangle.max[i]));
        const x = (clipped ? point.x : source.attributes.position.getX(at)) + block.x,
          y = (clipped ? point.y : source.attributes.position.getY(at) * scale) + block.y,
          z = (clipped ? point.z : source.attributes.position.getZ(at)) + block.z;
        positions.push(x, y, z); cx += x; cy += y; cz += z;
        normals.push(source.attributes.normal.getX(at), source.attributes.normal.getY(at), source.attributes.normal.getZ(at));
        if (clipped) {
        const delta = point.clone().sub(localPoints[0]);
        const u = edgeU.lengthSq() ? delta.dot(edgeU) / edgeU.lengthSq() : 0, v = edgeV.lengthSq() ? delta.dot(edgeV) / edgeV.lengthSq() : 0;
        const uv = source.attributes.uv, first = faceIndex * 4;
        uvs.push(uv.getX(first) + (uv.getX(first + 3) - uv.getX(first)) * u + (uv.getX(first + 1) - uv.getX(first)) * v,
          uv.getY(first) + (uv.getY(first + 3) - uv.getY(first)) * u + (uv.getY(first + 1) - uv.getY(first)) * v);
        } else uvs.push(source.attributes.uv.getX(at), source.attributes.uv.getY(at));
        colors.push(source.attributes.color.getX(at), source.attributes.color.getY(at), source.attributes.color.getZ(at));
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      centers.push(cx / 4, cy / 4, cz / 4);
      blockIndices.push(index);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.userData.blockIndices = blockIndices;
  geometry.userData.centers = new Float32Array(centers);
  geometry.userData.faceOrder = Array.from({ length: blockIndices.length }, (_, i) => i);
  geometry.userData.depths = new Float32Array(blockIndices.length);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

/** All transparent states share one globally sorted index buffer. Instance-level
 * sorting cannot order interleaved water, glass, and ice correctly. */
export function sortTransparentFaces(geometry, camera) {
  camera.updateMatrixWorld(true);
  const { centers, faceOrder, depths } = geometry.userData;
  if (!centers?.length) return;
  const view = camera.matrixWorldInverse.elements;
  for (let face = 0; face < faceOrder.length; face++) depths[face] = view[2] * centers[face * 3] + view[6] * centers[face * 3 + 1] + view[10] * centers[face * 3 + 2] + view[14];
  faceOrder.sort((a, b) => depths[a] - depths[b]);
  const indices = geometry.index.array;
  for (let slot = 0; slot < faceOrder.length; slot++) {
    const vertex = faceOrder[slot] * 4, offset = slot * 6;
    indices[offset] = vertex; indices[offset + 1] = vertex + 1; indices[offset + 2] = vertex + 2;
    indices[offset + 3] = vertex; indices[offset + 4] = vertex + 2; indices[offset + 5] = vertex + 3;
  }
  geometry.index.needsUpdate = true;
}

// Water in partial blocks and glass must be in the SAME sortable draw call;
// sorting separate materials would bring the original see-through bug back.
export function mergeTransparentGeometries(parts) {
  const geometry = new THREE.BufferGeometry();
  for (const [name, itemSize] of [['position',3],['normal',3],['uv',2],['color',3]]) {
    const array = new Float32Array(parts.reduce((n,p)=>n+p.attributes[name].array.length,0));
    let offset = 0;
    for (const part of parts) { array.set(part.attributes[name].array,offset); offset += part.attributes[name].array.length; }
    geometry.setAttribute(name,new THREE.BufferAttribute(array,itemSize));
  }
  const blockIndices = parts.flatMap(part=>part.userData.blockIndices);
  const centers = new Float32Array(blockIndices.length*3);
  let offset = 0;
  for(const part of parts) { centers.set(part.userData.centers,offset); offset += part.userData.centers.length; }
  const indices = new Uint32Array(blockIndices.length*6);
  for(let face=0;face<blockIndices.length;face++) { const i=face*4; indices.set([i,i+1,i+2,i,i+2,i+3],face*6); }
  geometry.setIndex(new THREE.BufferAttribute(indices,1));
  geometry.userData = { blockIndices, centers, faceOrder:Array.from({length:blockIndices.length},(_,i)=>i), depths:new Float32Array(blockIndices.length) };
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}

export class SchematicViewer {
  constructor(host, { onSelect, onHover, onStats, onSelectEntity, onProjectionChange } = {}) {
    this.host = host;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onStats = onStats;
    this.onSelectEntity = onSelectEntity;
    this.onProjectionChange = onProjectionChange;
    this.meshes = [];
    this.visibleIndices = [];
    this.selectedIndex = null;
    this.generation = 0;
    this.disposed = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101722');
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 10000);
    this.projection = 'perspective';
    this.orthoHeight = 40;
    this.camera.position.set(30, 25, 35);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor('#101722');
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', '三维投影：中键旋转，Shift+中键平移，Ctrl+中键缩放，滚轮朝鼠标指向位置缩放，左键选中，小键盘切换视角');
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 50000;
    this.controls.minZoom = 0.0001;
    this.controls.maxZoom = 100000;
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
    this.controls.addEventListener('change', () => this.invalidate());
    // Lambert divides irradiance by PI. Keep the brightest face below unit
    // radiance, while retaining Minecraft's evenly lit, readable textures.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-0.7, 1, 0.5); this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfd5ff, 0.25);
    fill.position.set(1, 0.35, -1); this.scene.add(fill);
    this.blockGroup = new THREE.Group(); this.scene.add(this.blockGroup);
    this.gridGroup = new THREE.Group(); this.scene.add(this.gridGroup);
    this.selection = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.008, 1.008, 1.008)), new THREE.LineBasicMaterial({ color: 0x6bf5bd, depthTest: false, transparent: true, opacity: 0.98 }));
    this.selection.renderOrder = 100; this.selection.visible = false; this.scene.add(this.selection);
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    const canvas = this.renderer.domElement;
    this.handlers = {
      // Capture phase runs before OrbitControls. Modifier panning is supported
      // natively; Ctrl+MMB overrides its default modifier action with dollying.
      pointerdown: event => {
        canvas.focus();
        if (event.button === 1) this.controls.mouseButtons.MIDDLE = event.ctrlKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
        if (event.button === 0) this.press = { x: event.clientX, y: event.clientY, time: performance.now() };
      },
      pointerup: event => {
        const press = this.press; this.press = null;
        if (event.button !== 0 || !press || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
        const hit = this.pickTarget(event);
        if (hit?.entity) {
          this.select(null);
          this.selectedEntityIndex = hit.index;
          this.onSelectEntity?.(hit.entity, hit.index);
          return;
        }
        const index = hit?.index ?? null;
        this.selectedEntityIndex = null;
        this.select(index);
        this.onSelect?.(index == null ? null : this.schematic.blocks[index], index);
      },
      pointermove: event => {
        if (!this.onHover || event.buttons || performance.now() - (this.hoverTime || 0) < 120) return;
        this.hoverTime = performance.now(); const index = this.pick(event);
        this.onHover(index == null ? null : this.schematic.blocks[index], index);
      },
      pointerleave: () => { this.press = null; this.onHover?.(null, null); },
      contextmenu: event => event.preventDefault(),
      keydown: event => this.handleKey(event),
    };
    Object.entries(this.handlers).forEach(([name, handler]) => canvas.addEventListener(name, handler, name === 'pointerdown'));
    this.cursorZoom = attachCursorZoom({ element: canvas, getCamera: () => this.camera, controls: this.controls,
      pick: event => this.pickTarget(event), beforeZoom: () => this.stopInertia(), invalidate: () => this.invalidate() });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    if (this.camera.isOrthographicCamera) {
      this.camera.left = -this.orthoHeight * this.camera.aspect / 2; this.camera.right = -this.camera.left;
      this.camera.top = this.orthoHeight / 2; this.camera.bottom = -this.camera.top;
    }
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    if (this.pending || this.disposed) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      if (this.disposed) return;
      this.controls.update();
      this.sortTransparent();
      this.renderer.render(this.scene, this.camera);
    });
  }

  clearMeshes() {
    const geometries = new Set(this.stateGeometries?.values() || []);
    for (const mesh of this.meshes) { geometries.add(mesh.geometry); mesh.material.dispose(); mesh.dispose?.(); this.blockGroup.remove(mesh); }
    for (const geometry of geometries) geometry.dispose();
    this.stateGeometries = null;
    this.meshes = [];
    this.transparentMesh = null;
    this.atlas?.texture.dispose(); this.atlas = null;
  }

  async setData(schematic, assets) {
    const generation = ++this.generation;
    const atlas = await createAtlas(assets, this.renderer.capabilities.maxTextureSize);
    if (generation !== this.generation || this.disposed) { atlas.texture.dispose(); return; }
    this.clearMeshes();
    this.setEntityLayer(null);
    this.schematic = schematic;
    this.assets = assets;
    this.atlas = atlas;
    this.visibleBounds = null;
    this.selectedIndex = null; this.selection.visible = false;
    const counts = new Map();
    for (const block of schematic.blocks) counts.set(block.state, (counts.get(block.state) || 0) + 1);
    this.stateMeshes = new Map();
    this.stateGeometries = new Map();
    for (const [state, count] of counts) {
      const block = schematic.palette[state], asset = assets.blocks?.[state];
      const geometry = buildStateGeometry(asset, block, atlas);
      const transparent = transparentState(block, asset, geometry);
      this.stateGeometries.set(state, geometry);
      if (transparent) continue;
      const material = createBlockMaterial(atlas);
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.blockIndices = [];
      mesh.userData.state = state;
      mesh.renderOrder = 0;
      this.meshes.push(mesh); this.stateMeshes.set(state, mesh); this.blockGroup.add(mesh);
    }
    this.rebuildGrid();
    this.setVisible(schematic.blocks.map((_, i) => i));
    this.fit();
  }

  setVisible(indices) {
    if (!this.schematic) return;
    const matrix = new THREE.Matrix4(), seen = new Set();
    for (const mesh of this.meshes) if (mesh.isInstancedMesh) { mesh.count = 0; mesh.userData.blockIndices = []; }
    const box = new THREE.Box3();
    for (const index of indices) {
      if (!Number.isInteger(index) || seen.has(index)) continue;
      const block = this.schematic.blocks[index]; if (!block) continue;
      const mesh = this.stateMeshes.get(block.state);
      if (!mesh && !this.stateGeometries?.has(block.state)) continue;
      seen.add(index);
      if (mesh) {
        matrix.makeTranslation(block.x, block.y, block.z);
        mesh.setMatrixAt(mesh.count++, matrix);
        mesh.userData.blockIndices.push(index);
      }
      box.expandByPoint(new THREE.Vector3(block.x, block.y, block.z));
      box.expandByPoint(new THREE.Vector3(block.x + 1, block.y + 1, block.z + 1));
    }
    this.visibleIndices = [...seen]; this.visibleSet = seen; this.visibleBounds = box;
    for (const mesh of this.meshes) if (mesh.isInstancedMesh) {
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox(); mesh.computeBoundingSphere();
    }
    this.rebuildTransparent();
    this.selection.visible = this.selectedIndex != null && seen.has(this.selectedIndex);
    this.scene.updateMatrixWorld(true);
    this.invalidate(); this.onStats?.(this.getStats());
  }

  rebuildTransparent() {
    if (!this.stateGeometries) return;
    if (this.transparentMesh) {
      this.transparentMesh.geometry.dispose(); this.transparentMesh.material.dispose();
      this.blockGroup.remove(this.transparentMesh);
      this.meshes = this.meshes.filter(mesh => mesh !== this.transparentMesh);
    }
    const hasWater = !!this.assets.fluids?.water;
    let geometry = buildTransparentGeometry(this.schematic, this.visibleIndices, this.stateGeometries, this.assets, {excludeWater:hasWater});
    if(hasWater) {
      const water = buildFluidGeometry(this.schematic,this.visibleIndices,this.assets,this.atlas);
      const base = geometry;
      geometry = mergeTransparentGeometries([base,water]);
      geometry.userData.waterFaces = water.index.count / 6;
      base.dispose(); water.dispose();
    }
    const material = createBlockMaterial(this.atlas, true);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = geometry.index.count > 0;
    mesh.userData.transparentBatch = true;
    mesh.renderOrder = 2;
    this.transparentMesh = mesh;
    this.meshes.push(mesh); this.blockGroup.add(mesh);
    this.transparentCamera = null;
  }

  sortTransparent() {
    if (!this.transparentMesh?.visible) return;
    this.camera.updateMatrixWorld(true);
    const next = this.camera.matrixWorld.elements;
    if (this.transparentCamera && next.every((value, i) => value === this.transparentCamera[i])) return;
    sortTransparentFaces(this.transparentMesh.geometry, this.camera);
    this.transparentCamera = [...next];
  }

  bounds() {
    if (this.visibleBounds && !this.visibleBounds.isEmpty()) return this.visibleBounds.clone();
    if (!this.schematic?.blocks.length) return new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 10, 5));
    const box = new THREE.Box3();
    for (const b of this.schematic.blocks) { box.expandByPoint(new THREE.Vector3(b.x, b.y, b.z)); box.expandByPoint(new THREE.Vector3(b.x + 1, b.y + 1, b.z + 1)); }
    return box;
  }

  rebuildGrid() {
    for (const child of [...this.gridGroup.children]) { child.geometry?.dispose(); if (Array.isArray(child.material)) child.material.forEach(m => m.dispose()); else child.material?.dispose(); this.gridGroup.remove(child); }
    const box = this.bounds(), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const span = Math.max(16, Math.ceil(Math.max(size.x, size.z) + 12));
    const divisions = span > 180 ? Math.ceil(span / 5) : span;
    const grid = new THREE.GridHelper(span, divisions, 0x405065, 0x273445);
    grid.position.set(center.x, box.min.y - 0.04, center.z);
    grid.material.transparent = true; grid.material.opacity = 0.5;
    this.gridGroup.add(grid);
    const axes = new THREE.AxesHelper(Math.min(12, span / 5));
    axes.position.set(box.min.x - 2, box.min.y, box.min.z - 2); this.gridGroup.add(axes);
  }

  fit() {
    this.stopInertia();
    const box = this.bounds(), center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const radius = Math.max(1, size.length() / 2);
    const fov = this.camera.fov || 42;
    const angle = Math.min(fov * DEG / 2, Math.atan(Math.tan(fov * DEG / 2) * this.camera.aspect));
    const distance = radius / Math.sin(angle) * 1.08;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() < 0.01) direction.set(1, 0.8, 1).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.near = 0.05;
    this.camera.far = Math.max(10000, distance * 10 + radius * 4);
    this.controls.maxDistance = this.camera.far / 3;
    if (this.camera.isOrthographicCamera) {
      this.orthoHeight = radius * 2.16 / Math.min(1, this.camera.aspect);
      this.camera.zoom = 1;
      this.resize();
    }
    this.camera.updateProjectionMatrix(); this.controls.update(); this.invalidate();
  }

  zoom(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.stopInertia();
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, 0.0001, 100000);
      this.camera.updateProjectionMatrix(); this.controls.update(); this.invalidate(); return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); this.invalidate();
  }

  view(direction) {
    this.stopInertia();
    const vectors = { iso: [1, 0.8, 1], top: [0, 1, 0.00001], bottom: [0, -1, 0.00001], front: [0, 0, -1], back: [0, 0, 1], side: [1, 0, 0], left: [-1, 0, 0] };
    const distance = Math.max(1, this.camera.position.distanceTo(this.controls.target));
    this.camera.position.copy(this.controls.target).addScaledVector(new THREE.Vector3(...(vectors[direction] || vectors.iso)).normalize(), distance);
    this.controls.update(); this.invalidate();
  }

  setProjection(projection) {
    if (!['perspective', 'orthographic'].includes(projection) || projection === this.getProjection()) return;
    this.stopInertia();
    const old = this.camera, aspect = old.aspect || 1;
    const distance = Math.max(0.2, old.position.distanceTo(this.controls.target));
    let camera;
    if (projection === 'orthographic') {
      this.orthoHeight = 2 * distance * Math.tan((old.fov || 42) * DEG / 2) / old.zoom;
      camera = new THREE.OrthographicCamera(-this.orthoHeight * aspect / 2, this.orthoHeight * aspect / 2, this.orthoHeight / 2, -this.orthoHeight / 2, old.near, old.far);
      camera.position.copy(old.position);
    } else {
      camera = new THREE.PerspectiveCamera(42, aspect, old.near, old.far);
      const newDistance = this.orthoHeight / old.zoom / (2 * Math.tan(21 * DEG));
      camera.position.copy(this.controls.target).addScaledVector(old.position.clone().sub(this.controls.target).normalize(), newDistance);
    }
    camera.aspect = aspect;
    camera.up.copy(old.up); camera.quaternion.copy(old.quaternion);
    this.camera = camera; this.projection = projection; this.controls.object = camera;
    camera.updateProjectionMatrix(); this.controls.update(); this.invalidate();
    this.onProjectionChange?.(projection);
  }

  getProjection() { return this.camera.isOrthographicCamera ? 'orthographic' : 'perspective'; }
  stopInertia() {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = damping;
  }
  getCameraInfo() {
    return { projection: this.getProjection(), position: this.camera.position.toArray(), target: this.controls.target.toArray(), zoom: this.camera.zoom, distance: this.camera.position.distanceTo(this.controls.target), fov: this.camera.fov || null };
  }

  handleKey(event) {
    if (event.altKey || event.metaKey || event.target?.closest?.('input,textarea,select,[contenteditable="true"],dialog') || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return;
    const views = { Numpad1: event.ctrlKey ? 'back' : 'front', Numpad3: event.ctrlKey ? 'left' : 'side', Numpad7: event.ctrlKey ? 'bottom' : 'top' };
    if (views[event.code]) { this.setProjection('orthographic'); this.view(views[event.code]); }
    else if (event.code === 'Numpad5') this.setProjection(this.getProjection() === 'perspective' ? 'orthographic' : 'perspective');
    else if (event.code === 'Home') this.fit();
    else if (event.code === 'NumpadDecimal') {
      if (this.selectedEntityIndex != null) this.focusEntity(this.selectedEntityIndex);
      else this.focus(this.selectedIndex);
    }
    else return;
    event.preventDefault(); event.stopPropagation();
  }

  pick(event) {
    return this.pickTarget(event, false)?.index ?? null;
  }

  pickTarget(event, includeEntities = true) {
    if (!this.schematic) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes.filter(m => m.visible), false);
    let blockHit = null;
    for (const hit of hits) {
      if (!atlasHitVisible(hit, this.atlas)) continue;
      const geometry = hit.object.geometry;
      const index = hit.object.isInstancedMesh ? hit.object.userData.blockIndices[hit.instanceId]
        : geometry.userData.blockIndices?.[geometry.userData.faceOrder?.[Math.floor(hit.faceIndex / 2)]];
      if (index != null) { blockHit = { index, distance: hit.distance, point: hit.point }; break; }
    }
    const entityHit = includeEntities ? this.entityLayer?.pick?.(this.raycaster) : null;
    return entityHit && (!blockHit || entityHit.distance < blockHit.distance) ? entityHit : blockHit;
  }

  select(index) {
    const block = index == null ? null : this.schematic?.blocks[index];
    this.selectedIndex = block ? index : null;
    if (block) this.selectedEntityIndex = null;
    this.selection.visible = !!block && this.visibleSet?.has(index);
    if (block) this.selection.position.set(block.x + 0.5, block.y + 0.5, block.z + 0.5);
    this.invalidate();
  }

  focus(index) {
    const block = this.schematic?.blocks[index]; if (!block) return;
    this.focusPoint(new THREE.Vector3(block.x + 0.5, block.y + 0.5, block.z + 0.5));
    this.select(index);
  }

  focusPoint(point, distance = 9) {
    this.stopInertia();
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() < 0.01) direction.set(1, 0.8, 1).normalize();
    this.controls.target.copy(point);
    this.camera.position.copy(point).addScaledVector(direction, distance);
    if (this.camera.isOrthographicCamera) { this.camera.zoom = this.orthoHeight / Math.max(2, distance * 0.75); this.camera.updateProjectionMatrix(); }
    this.controls.update(); this.invalidate();
  }

  setEntityLayer(layer) {
    if (this.entityLayer === layer) return;
    if (this.entityLayer) { this.scene.remove(this.entityLayer.group || this.entityLayer); this.entityLayer.dispose?.(); }
    this.entityLayer = layer;
    this.selectedEntityIndex = null;
    if (layer) this.scene.add(layer.group || layer);
    this.invalidate();
  }
  setEntityVisible(visible) { this.entityLayer?.setVisible?.(visible); this.invalidate(); }
  setEntityFilter(filter) { this.entityLayer?.setFilter?.(filter); this.invalidate(); }
  focusEntity(index) {
    const box = this.entityLayer?.focusBounds?.(index);
    if (!box || box.isEmpty()) return;
    this.select(null); this.selectedEntityIndex = index;
    this.focusPoint(box.getCenter(new THREE.Vector3()), Math.max(4, box.getSize(new THREE.Vector3()).length() * 3));
  }

  setGrid(visible) { this.gridGroup.visible = !!visible; this.invalidate(); }

  capture() {
    if (this.disposed) throw new Error('三维查看器已关闭。');
    // With preserveDrawingBuffer=false Chromium may clear the backing buffer
    // after compositing. Draw and read synchronously in the same task.
    this.controls.update();
    this.sortTransparent();
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  getStats() {
    return { visible: this.visibleIndices.length, total: this.schematic?.blocks.length || 0, meshes: this.meshes.filter(m => m.visible).length, triangles: this.meshes.reduce((n, m) => n + (m.isInstancedMesh ? m.count : 1) * (m.geometry.index?.count || 0) / 3, 0), transparentFaces: this.transparentMesh?.geometry.userData.faceOrder.length || 0, waterFaces: this.transparentMesh?.geometry.userData.waterFaces || 0, atlasSize: this.atlas?.width || 0 };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    if (this.pending) cancelAnimationFrame(this.pending);
    this.resizeObserver.disconnect(); this.cursorZoom?.dispose(); this.controls.dispose();
    Object.entries(this.handlers).forEach(([name, handler]) => this.renderer.domElement.removeEventListener(name, handler, name === 'pointerdown'));
    this.setEntityLayer(null);
    this.clearMeshes();
    this.selection.geometry.dispose(); this.selection.material.dispose();
    for (const child of this.gridGroup.children) { child.geometry?.dispose(); child.material?.dispose(); }
    this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
