'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const zlib = require('node:zlib');
const { loadAssets, _test } = require('../src/core/assets.cjs');
const imports = Promise.all([import('../src/renderer/viewer.js'), import('three'), import('../src/renderer/model-uv.js')]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const textures = ['banner_base', 'bell/bell_body', 'conduit/base', 'decorated_pot/decorated_pot_side', 'decorated_pot/decorated_pot_base',
  'chest/normal_left', 'chest/normal_right', 'chest/normal', 'skeleton/skeleton', 'skeleton/wither_skeleton', 'zombie/zombie',
  'creeper/creeper', 'player/wide/steve', 'enderdragon/dragon', 'piglin/piglin', 'copper_golem/copper_golem', 'enchanting_table_book', 'end_portal'];
function fixture(t, names, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'special-models-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const zip = new AdmZip(), jar = path.join(directory, 'client.jar');
  const entries = {
    'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'minecraft:block/stone' } } },
    'assets/minecraft/models/block/stone.json': { textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' } } }] },
    'assets/minecraft/models/block/no_elements.json': { textures: { particle: 'block/stone' } },
    'assets/minecraft/textures/block/stone.png': PNG,
    'assets/minecraft/textures/block/water_still.png': PNG,
    'assets/minecraft/textures/block/water_flow.png': PNG,
    'assets/minecraft/lang/zh_cn.json': {},
  };
  for (const name of names) entries[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: 'minecraft:block/no_elements' } } };
  for (const texture of textures) entries[`assets/minecraft/textures/entity/${texture}.png`] = PNG;
  Object.assign(entries, extra);
  for (const [filename, value] of Object.entries(entries)) zip.addFile(filename, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  zip.writeZip(jar); return jar;
}
const close = (actual, expected, tolerance = 1e-5) => assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function boundedUvs(assets) {
  for (const block of assets.blocks) for (const part of block.parts) for (const element of part.elements) {
    if (element.transform) assert.equal(element.transform.length, 16);
    for (const face of Object.values(element.faces)) {
      assert.notEqual(face.texture, 'viewer:missing', block.name);
      assert(face.uv.every(n => Number.isFinite(n) && n >= 0 && n <= 16), `${block.name}: ${face.uv}`);
    }
  }
}
async function geometry(assets, i = 0) {
  const [{ buildStateGeometry }] = await imports;
  const regions = Object.fromEntries(Object.keys(assets.textures).map(k => [k, { x: 0, y: 0, width: 64, height: 64 }]));
  return buildStateGeometry(assets.blocks[i], { Name: assets.blocks[i].name }, { width: 64, height: 64, regions });
}

// Small test-only decoder: checks actual local sprite alpha, independently of
// the viewer atlas. The shipped chest sheets are 8-bit indexed PNGs.
function pngAlpha(buffer) {
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20), depth = buffer[24], type = buffer[25];
  assert.equal(depth, 8); assert([2, 3, 6].includes(type));
  assert.equal(buffer[28], 0, 'test image must be noninterlaced');
  const bytes = type === 6 ? 4 : type === 2 ? 3 : 1, packed = []; let transparency = null;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), name = buffer.toString('ascii', offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (name === 'IDAT') packed.push(data); else if (name === 'tRNS') transparency = data;
    offset += length + 12;
  }
  const data = zlib.inflateSync(Buffer.concat(packed)), stride = width * bytes, pixels = Buffer.alloc(stride * height), alpha = Buffer.alloc(width * height);
  const paeth = (a, b, c) => { const p = a + b - c, A = Math.abs(p - a), B = Math.abs(p - b), C = Math.abs(p - c); return A <= B && A <= C ? a : B <= C ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]; assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= bytes ? pixels[i - bytes] : 0, up = y ? pixels[i - stride] : 0, corner = y && x >= bytes ? pixels[i - stride - bytes] : 0;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      pixels[i] = (data[y * (stride + 1) + x + 1] + prediction) & 255;
    }
    for (let x = 0; x < width; x++) alpha[y * width + x] = type === 6 ? pixels[y * stride + x * bytes + 3] : type === 3 ? transparency?.[pixels[y * stride + x]] ?? 255 : 255;
  }
  return { width, height, alpha };
}
function faceAlpha(image, uv) {
  const [x0, x1] = [uv[0], uv[2]].sort((a, b) => a - b).map(n => n * image.width / 16);
  const [y0, y1] = [uv[1], uv[3]].sort((a, b) => a - b).map(n => n * image.height / 16);
  let count = 0, visible = 0, minimum = 255;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
    const alpha = image.alpha[y * image.width + x]; count++; if (alpha > 20) visible++; minimum = Math.min(minimum, alpha);
  }
  return { count, visible, minimum };
}

test('native bare texture slots resolve through parent aliases and retain direct resource IDs', t => {
  const jar = fixture(t, ['heavy_core'], {
    'assets/minecraft/models/block/no_elements.json': { textures: { all: '#base', base: 'block/stone' }, elements: [{ from: [4, 0, 4], to: [12, 8, 12],
      faces: { north: { texture: 'all' }, south: { texture: 'minecraft:block/stone' } } }] },
  });
  const assets = loadAssets(jar, ['minecraft:heavy_core']);
  assert.equal(assets.blocks[0].fallback, undefined);
  for (const face of Object.values(assets.blocks[0].parts[0].elements[0].faces)) assert.equal(face.texture, 'minecraft:block/stone');
});

test('legitimate invisible states remain empty while dynamic models remain explicitly unsupported', t => {
  const jar = fixture(t, ['pitcher_crop', 'barrier', 'light', 'moving_piston', 'explicit_empty'], {
    'assets/minecraft/blockstates/explicit_empty.json': { variants: { '': { model: 'minecraft:block/empty_child' } } },
    'assets/minecraft/models/block/empty_parent.json': { elements: [] },
    'assets/minecraft/models/block/empty_child.json': { parent: 'block/empty_parent' },
  });
  const states = [0, 1, 2].map(age => `minecraft:pitcher_crop[age=${age},half=upper]`);
  states.push('minecraft:barrier[waterlogged=true]', 'minecraft:light[level=15,waterlogged=true]', 'minecraft:moving_piston', 'minecraft:explicit_empty');
  const assets = loadAssets(jar, states);
  assert(assets.blocks.every(b => b.parts.length === 0));
  assert(assets.blocks.slice(0, 3).every(b => b.modelKind === 'empty-json' && !b.fallback));
  assert.equal(assets.blocks[3].modelKind, 'invisible'); assert.equal(assets.blocks[3].waterlogged, true);
  assert.equal(assets.blocks[4].modelKind, 'invisible'); assert.equal(assets.blocks[4].waterlogged, true);
  assert.equal(assets.blocks[5].modelKind, 'unsupported'); assert.match(assets.blocks[5].fallbackReason, /NBT/);
  assert.equal(assets.blocks[6].modelKind, 'empty-json');
});

test('banners use bounded entity-sheet UV, exact full height and dye only the cloth', async t => {
  const jar = fixture(t, ['red_banner', 'blue_wall_banner']);
  const assets = loadAssets(jar, ['minecraft:red_banner[rotation=0]', 'minecraft:blue_wall_banner[facing=south]']);
  boundedUvs(assets);
  const standing = assets.blocks[0].parts[0].elements;
  assert.equal(standing.length, 3);
  assert(Object.values(standing[0].faces).every(face => Array.isArray(face.colorRGB)));
  assert(standing.slice(1).every(e => Object.values(e.faces).every(face => !face.colorRGB)));
  const g = await geometry(assets), wall = await geometry(assets, 1);
  close(g.boundingBox.min.y, 0); close(g.boundingBox.max.y * 16, 88 / 3);
  close((g.boundingBox.max.x - g.boundingBox.min.x) * 16, 40 / 3);
  close(wall.boundingBox.min.y * 16, -13); close(wall.boundingBox.max.y * 16, 41 / 3);
  assert(wall.boundingBox.max.z < .2); g.dispose(); wall.dispose();
});

test('double chest halves join without a gap, use separate sheets and meet at the two-piece latch', async t => {
  const jar = fixture(t, ['chest']);
  const assets = loadAssets(jar, ['minecraft:chest[facing=north,type=left]', 'minecraft:chest[facing=north,type=right]']);
  boundedUvs(assets);
  const left = await geometry(assets, 0), right = await geometry(assets, 1);
  close(left.boundingBox.min.x * 16, 1); close(left.boundingBox.max.x * 16, 16);
  close(right.boundingBox.min.x * 16, 0); close(right.boundingBox.max.x * 16, 15);
  close(left.boundingBox.max.x, right.boundingBox.min.x + 1);
  assert.equal(assets.blocks[0].parts[0].elements[0].faces.north.texture, 'minecraft:entity/chest/normal_left');
  assert.equal(assets.blocks[1].parts[0].elements[0].faces.north.texture, 'minecraft:entity/chest/normal_right');
  const leftLatch = assets.blocks[0].parts[0].elements[2], rightLatch = assets.blocks[1].parts[0].elements[2];
  assert.equal(leftLatch.to[0] - leftLatch.from[0], 1); assert.equal(rightLatch.to[0] - rightLatch.from[0], 1);
  assert(assets.blocks[0].parts[0].elements.every(e => e.faces.west), 'isolated left half must retain its join');
  assert(assets.blocks[1].parts[0].elements.every(e => e.faces.east), 'isolated right half must retain its join');
  left.dispose(); right.dispose();
});

test('single chest lid samples the outer cover, not the dark underside of the native entity sheet', t => {
  const jar = fixture(t, ['chest']);
  const assets = loadAssets(jar, ['minecraft:chest[facing=north,type=single]']);
  const [body, lid, lock] = assets.blocks[0].parts[0].elements;
  assert.deepEqual(lid.faces.up.uv, [10.5, 0, 7, 3.5]);
  assert.deepEqual(lid.faces.north.uv, [14, 4.75, 10.5, 3.5]);
  assert.deepEqual(body.faces.north.uv, [14, 10.5, 10.5, 8.25]);
  assert.notDeepEqual(lock.faces.north.uv, lock.faces.up.uv);
});

test('conduit and decorated pot use entity geometry instead of full cubes or tiled entity sheets', async t => {
  const jar = fixture(t, ['conduit', 'decorated_pot']);
  const assets = loadAssets(jar, ['minecraft:conduit', 'minecraft:decorated_pot[facing=north]']); boundedUvs(assets);
  const g = await geometry(assets, 0), pot = await geometry(assets, 1);
  g.boundingBox.min.toArray().forEach(n => close(n * 16, 5)); g.boundingBox.max.toArray().forEach(n => close(n * 16, 11));
  close(pot.boundingBox.max.y * 16, 19.9); close(pot.boundingBox.min.y, 0);
  const body = assets.blocks[1].parts[0].elements[0];
  assert.deepEqual(body.faces.north.uv, [1, 0, 15, 16]);
  assert.deepEqual(body.faces.up.uv, [7, 13.5, 14, 6.5]);
  assert.notEqual(body.faces.up.texture, body.faces.north.texture); g.dispose(); pot.dispose();
});

test('skulls retain wall offset, humanoid outer layer and separate piglin/dragon shapes', async t => {
  const jar = fixture(t, ['skeleton_skull', 'skeleton_wall_skull', 'player_head', 'dragon_head', 'piglin_head']);
  const assets = loadAssets(jar, ['minecraft:skeleton_skull[rotation=0]', 'minecraft:skeleton_wall_skull[facing=north]',
    'minecraft:player_head[rotation=0]', 'minecraft:dragon_head[rotation=0]', 'minecraft:piglin_head[rotation=0]']);
  boundedUvs(assets);
  assert.deepEqual(assets.blocks.map(b => b.parts[0].elements.length), [1, 1, 2, 7, 6]);
  assert(assets.blocks.every(b => b.renderType === 'entity-cutout-no-cull'));
  const floor = await geometry(assets), wall = await geometry(assets, 1), dragon = await geometry(assets, 3);
  close(floor.boundingBox.max.y, .5); close(floor.boundingBox.min.y, 0);
  close(wall.boundingBox.min.y, .25); close(wall.boundingBox.max.z, 1);
  assert(dragon.boundingBox.min.z < 0); assert.match(assets.blocks[2].fallbackReason, /Steve.*NBT/);
  floor.dispose(); wall.dispose(); dragon.dispose();
});

test('bell and books are appended to static supports, and absent lectern books stay absent', t => {
  const jar = fixture(t, ['bell', 'enchanting_table', 'lectern'], {
    ...Object.fromEntries(['bell', 'enchanting_table', 'lectern'].map(name => [`assets/minecraft/blockstates/${name}.json`, { variants: { '': { model: 'block/stone' } } }])),
  });
  const assets = loadAssets(jar, ['minecraft:bell', 'minecraft:enchanting_table', 'minecraft:lectern[has_book=true]', 'minecraft:lectern[has_book=false]']);
  boundedUvs(assets); assert.deepEqual(assets.blocks.map(b => b.parts.length), [2, 2, 2, 1]);
  assert.equal(assets.blocks[0].parts[1].elements.length, 2);
  assert.deepEqual(assets.blocks[0].parts[1].elements.map(e => [e.from, e.to]), [[[5, 6, 5], [11, 13, 11]], [[4, 4, 4], [12, 6, 12]]]);
  assert.equal(assets.blocks[1].parts[1].elements.length, 7); assert.equal(assets.blocks[2].parts[1].elements.length, 7);
});

test('copper statue poses preserve their distinct articulated extent and 24-pixel standing height', async t => {
  const jar = fixture(t, ['copper_golem_statue']);
  const poses = ['standing', 'running', 'sitting', 'star'];
  const assets = loadAssets(jar, poses.map(p => `minecraft:copper_golem_statue[copper_golem_pose=${p},facing=north]`)); boundedUvs(assets);
  assert.deepEqual(assets.blocks.map(b => b.parts[0].elements.length), [9, 9, 11, 9]);
  const shapes = await Promise.all(poses.map((_, i) => geometry(assets, i)));
  close(shapes[0].boundingBox.max.y * 16, 23.985); close(shapes[0].boundingBox.min.y, 0);
  assert(shapes[2].boundingBox.max.y < shapes[0].boundingBox.max.y);
  assert(shapes[3].boundingBox.max.x - shapes[3].boundingBox.min.x > shapes[0].boundingBox.max.x - shapes[0].boundingBox.min.x);
  assert.equal(new Set(shapes.map(g => JSON.stringify(g.boundingBox))).size, 4);
  for (const shape of shapes) shape.dispose();
});

test('optional real game JAR covers every special-state family without missing sprites or UV escape', { skip: !process.env.MINECRAFT_JAR }, () => {
  const names = ['conduit', 'heavy_core', 'decorated_pot', 'bell', 'enchanting_table', 'lectern', 'barrier', 'light', 'end_portal', 'end_gateway',
    'skeleton_skull', 'skeleton_wall_skull', 'wither_skeleton_skull', 'zombie_head', 'creeper_head', 'player_head', 'dragon_head', 'piglin_head',
    'red_banner', 'red_wall_banner', 'copper_golem_statue', 'waxed_oxidized_copper_golem_statue', 'chest', 'copper_chest', 'pitcher_crop'];
  const registryPath = process.env.MINECRAFT_BLOCK_REGISTRY;
  const registry = registryPath && JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const palette = registry ? names.flatMap(n => registry[`minecraft:${n}`].states.map(s => ({ Name: `minecraft:${n}`, Properties: s.properties || {} }))) : [
    'minecraft:heavy_core', 'minecraft:conduit', 'minecraft:decorated_pot[facing=north]', 'minecraft:bell[attachment=floor,facing=north]',
    'minecraft:enchanting_table', 'minecraft:lectern[facing=north,has_book=true]', 'minecraft:dragon_head', 'minecraft:piglin_head',
    'minecraft:red_banner', 'minecraft:copper_golem_statue[copper_golem_pose=running]', 'minecraft:chest[facing=north,type=left]',
    ...[0, 1, 2].map(age => `minecraft:pitcher_crop[age=${age},half=upper]`),
  ];
  const assets = loadAssets(process.env.MINECRAFT_JAR, palette); boundedUvs(assets);
  assert(!assets.blocks.some(b => b.modelKind === 'unsupported'));
  assert(!assets.warnings.some(w => /缺失或无效|缺失本地/.test(w)), assets.warnings.join('\n'));
});

test('optional independent local model oracle agrees on every copper pose vertex and UV', { skip: !process.env.COPPER_MODEL_ORACLE }, async t => {
  const jar = fixture(t, ['copper_golem_statue']);
  const [, THREE, { faceVertexUVs }] = await imports;
  const oracle = JSON.parse(fs.readFileSync(process.env.COPPER_MODEL_ORACLE, 'utf8').replace(/^\uFEFF/, ''));
  const matrix = p => new THREE.Matrix4().compose(new THREE.Vector3(...p.slice(0, 3)),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.slice(3), 'ZYX')), new THREE.Vector3(1, 1, 1));
  const corners = (d, a, b) => {
    const [x, y, z] = a, [X, Y, Z] = b;
    return { north: [[X,Y,z],[X,y,z],[x,y,z],[x,Y,z]], south: [[x,Y,Z],[x,y,Z],[X,y,Z],[X,Y,Z]],
      west: [[x,Y,z],[x,y,z],[x,y,Z],[x,Y,Z]], east: [[X,Y,Z],[X,y,Z],[X,y,z],[X,Y,z]],
      up: [[x,Y,z],[x,Y,Z],[X,Y,Z],[X,Y,z]], down: [[x,y,Z],[x,y,z],[X,y,z],[X,y,Z]] }[d];
  };
  for (const [pose, model] of Object.entries(oracle)) {
    const block = loadAssets(jar, [`minecraft:copper_golem_statue[copper_golem_pose=${pose},facing=north]`]).blocks[0];
    const expected = [], actual = [];
    function visit(node, parent, isRoot) {
      const p = node.poseXYZ_Radians.slice(); if (isRoot) { p[1] = 0; p[5] = Math.PI; }
      const transform = parent.clone().multiply(matrix(p));
      for (const cube of node.cubes) for (const q of cube.quadsXYZUV) for (const v of q)
        expected.push([...new THREE.Vector3(...v.slice(0, 3)).applyMatrix4(transform).toArray(), ...v.slice(3)]);
      for (const child of Object.values(node.children)) visit(child, transform, false);
    }
    visit(model, new THREE.Matrix4().makeTranslation(8, 0, 8), true);
    for (const element of block.parts[0].elements) for (const [d, face] of Object.entries(element.faces)) {
      const uv = faceVertexUVs(d, face.uv);
      corners(d, element.from, element.to).forEach((v, i) => actual.push([...new THREE.Vector3(...v).applyMatrix4(new THREE.Matrix4().fromArray(element.transform)).toArray(), ...uv[i].map(n => n / 16)]));
    }
    assert.equal(actual.length, expected.length, pose);
    for (const v of actual) {
      const index = expected.findIndex(e => e.every((n, i) => Math.abs(n - v[i]) < 1e-5));
      assert(index >= 0, `${pose}: unexpected vertex/UV ${JSON.stringify(v)}`); expected.splice(index, 1);
    }
  }
});

test('optional native model oracle verifies chest exterior, bell and dragon vertices, UVs and winding', { skip: !process.env.SPECIAL_MODEL_ORACLE }, async t => {
  const jar = fixture(t, ['chest', 'bell', 'dragon_head'], {
    'assets/minecraft/blockstates/bell.json': { variants: { '': { model: 'block/stone' } } },
  });
  const [, THREE, { faceVertexUVs }] = await imports;
  const oracle = JSON.parse(fs.readFileSync(process.env.SPECIAL_MODEL_ORACLE, 'utf8').replace(/^\uFEFF/, ''));
  const corners = (d, a, b) => {
    const [x,y,z] = a, [X,Y,Z] = b;
    return { north: [[X,Y,z],[X,y,z],[x,y,z],[x,Y,z]], south: [[x,Y,Z],[x,y,Z],[X,y,Z],[X,Y,Z]],
      west: [[x,Y,z],[x,y,z],[x,y,Z],[x,Y,Z]], east: [[X,Y,Z],[X,y,Z],[X,y,z],[X,Y,z]],
      up: [[x,Y,z],[x,Y,Z],[X,Y,Z],[X,Y,z]], down: [[x,y,Z],[x,y,z],[X,y,z],[X,y,Z]] }[d];
  };
  const cases = [['chest', 'minecraft:chest[facing=north,type=single]'], ['chest_left', 'minecraft:chest[facing=north,type=left]'],
    ['chest_right', 'minecraft:chest[facing=north,type=right]'], ['bell', 'minecraft:bell'], ['dragon', 'minecraft:dragon_head[rotation=0]']];
  for (const [key, state] of cases) {
    const asset = loadAssets(jar, [state]).blocks[0], expected = [], actual = [];
    const chest = key.startsWith('chest'), dragon = key === 'dragon';
    const initial = chest ? new THREE.Matrix4().makeTranslation(8, 8, 8).multiply(new THREE.Matrix4().makeRotationY(Math.PI)).multiply(new THREE.Matrix4().makeTranslation(-8, -8, -8)) :
      dragon ? new THREE.Matrix4().makeTranslation(8, 0, 8).multiply(new THREE.Matrix4().makeRotationZ(Math.PI)) : new THREE.Matrix4();
    function visit(node, parent, name) {
      const p = node.poseXYZ_Radians.slice(); if (dragon && name === 'jaw') p[3] = .2;
      const transform = parent.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...p.slice(0,3)),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.slice(3), 'ZYX')), new THREE.Vector3(...node.scale)));
      for (const cube of node.cubes) for (const q of cube.quadsXYZUV) {
        if (chest && name === 'bottom' && q.every(v => v[1] === 10)) continue;
        if (chest && name === 'lid' && q.every(v => v[1] === 0)) continue;
        // Preview caps intentionally replace the transparent native join. They
        // have their own real-alpha regression below, not a changed oracle.
        if (key === 'chest_left' && q.every(v => v[0] === 0)) continue;
        if (key === 'chest_right' && q.every(v => v[0] === 16)) continue;
        expected.push(q.map(v => {
          const point = v.slice();
          if (chest && name === 'bottom' && point[1] === 10) { point[1] = 9; point[4] -= 1 / 64; }
          return [...new THREE.Vector3(...point.slice(0,3)).applyMatrix4(transform).toArray(), ...point.slice(3)];
        }));
      }
      for (const [childName, child] of Object.entries(node.children)) visit(child, transform, childName);
    }
    visit(oracle[key], initial, 'root');
    for (const part of asset.parts) {
      if (key === 'bell' && part === asset.parts[0]) continue;
      const blockTransform = new THREE.Matrix4().makeTranslation(8,8,8).multiply(new THREE.Matrix4().makeRotationY(-(part.y || 0) * Math.PI / 180)).multiply(new THREE.Matrix4().makeTranslation(-8,-8,-8));
      for (const element of part.elements) for (const [d, face] of Object.entries(element.faces)) {
        if (face.previewCap) continue;
        const uv = faceVertexUVs(d, face.uv), transform = blockTransform.clone();
        if (element.transform) transform.multiply(new THREE.Matrix4().fromArray(element.transform));
        actual.push(corners(d, element.from, element.to).map((v, i) => [...new THREE.Vector3(...v).applyMatrix4(transform).toArray(), ...uv[i].map(n => n / 16)]));
      }
    }
    assert.equal(actual.length, expected.length, key);
    for (const q of actual) {
      const index = expected.findIndex(e => [0,1,2,3].some(shift => q.every((v,i) => v.every((n,j) => Math.abs(n - e[(i+shift)%4][j]) < 1e-5))));
      assert(index >= 0, `${key}: unmatched oriented quad ${JSON.stringify(q)}`); expected.splice(index, 1);
    }
  }
});

test('optional real chest sheets give every isolated double-half cap fully opaque pixels', { skip: !process.env.MINECRAFT_JAR }, () => {
  const names = ['chest', 'trapped_chest', 'ender_chest', 'copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest',
    'waxed_copper_chest', 'waxed_exposed_copper_chest', 'waxed_weathered_copper_chest', 'waxed_oxidized_copper_chest'];
  const states = names.flatMap(name => (name === 'ender_chest' ? ['single'] : ['single', 'left', 'right']).map(type => ({ Name: `minecraft:${name}`, Properties: { facing: 'north', type } })));
  const assets = loadAssets(process.env.MINECRAFT_JAR, states), decoded = new Map();
  const imageFor = id => {
    if (!decoded.has(id)) decoded.set(id, pngAlpha(Buffer.from(assets.textures[id].split(',')[1], 'base64')));
    return decoded.get(id);
  };
  let caps = 0;
  for (const block of assets.blocks) {
    const half = block.properties.type;
    for (const [index, element] of block.parts[0].elements.entries()) {
      if (half === 'single') {
        assert(Object.values(element.faces).every(f => !f.previewCap));
        for (const face of Object.values(element.faces)) assert.equal(faceAlpha(imageFor(face.texture), face.uv).minimum, 255, `${block.name} single cover`);
        continue;
      }
      const direction = half === 'left' ? 'west' : 'east', face = element.faces[direction];
      assert.equal(face.previewCap, true);
      const image = imageFor(face.texture), actual = faceAlpha(image, face.uv);
      assert(actual.count > 0); assert.equal(actual.visible, actual.count, `${block.name} ${half} part ${index}`); assert.equal(actual.minimum, 255);
      const original = index === 0 ? _test.rawEntityUv(0, 19, 15, 10, 14)[direction] : index === 1 ? _test.rawEntityUv(0, 0, 15, 5, 14)[direction] : _test.rawEntityUv(0, 0, 1, 4, 1)[direction];
      if (index === 0) original[1] -= .25;
      const native = faceAlpha(image, original);
      assert(native.visible < native.count, `${block.name} ${half} part ${index}: native join contains transparent pixels`);
      caps++;
    }
  }
  assert.equal(caps, 60, '10 double-chest blocks, two halves, body/lid/latch cap');
});
