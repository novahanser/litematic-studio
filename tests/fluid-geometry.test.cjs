'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/fluid-geometry.js'), import('three')]);
const water = (level = '0') => ({ Name: 'minecraft:water', Properties: { level } });
const contained = (name, properties = {}) => ({ Name: `minecraft:${name}`, Properties: { waterlogged: 'true', ...properties } });
const box = (from, to, rotation) => ({ from, to, faces: {}, ...(rotation ? { rotation } : {}) });
const asset = (...elements) => ({ parts: [{ elements }] });
const atlas = { width: 64, height: 64, regions: {
  still: { x: 2, y: 2, width: 16, height: 16 }, flow: { x: 24, y: 2, width: 16, height: 16 },
} };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const makeAssets = blocks => ({ blocks, fluids: { water: { still: 'still', flow: 'flow', tint: 0x3f76e4 } } });
function faces(geometry) {
  const result = [], positions = geometry.attributes.position, normals = geometry.attributes.normal;
  for (let face = 0; face < positions.count / 4; face++) {
    const points = Array.from({ length: 4 }, (_, i) => [positions.getX(face * 4 + i), positions.getY(face * 4 + i), positions.getZ(face * 4 + i)]);
    result.push({ points, normal: [normals.getX(face * 4), normals.getY(face * 4), normals.getZ(face * 4)], blockIndex: geometry.userData.blockIndices[face] });
  }
  return result;
}
function area(face) {
  const a = face.points[0], b = face.points[1], c = face.points[3];
  return Math.hypot(...a.map((n, i) => n - b[i])) * Math.hypot(...a.map((n, i) => n - c[i]));
}
function atPlane(face, axis, plane) { return face.points.every(point => Math.abs(point[axis] - plane) < 1e-6); }

test('water states, all source/flowing levels and falling columns have explicit static heights', async () => {
  const [{ isWaterState, waterHeight }] = await imports;
  assert.equal(isWaterState(water()), true); assert.equal(isWaterState(contained('stone_slab')), true);
  assert.equal(isWaterState({ Name: 'minecraft:stone_slab', Properties: { waterlogged: 'false' } }), false);
  assert.equal(isWaterState({ Name: 'minecraft:lava' }), false);
  for (let i = 0; i <= 7; i++) close(waterHeight(water(String(i))), (8 - i) / 9);
  close(waterHeight(water('8')), 1); close(waterHeight(water('15')), 1);
  close(waterHeight(water('nonsense')), 8 / 9);
  close(waterHeight(water('7'), true), 1);
  close(waterHeight(contained('oak_stairs')), 8 / 9);
  close(waterHeight({ Name: 'minecraft:bubble_column' }), 8 / 9);
});

test('one water block emits six outward, atlas-mapped quads with stable picking metadata', async () => {
  const [{ buildFluidGeometry }, THREE] = await imports;
  const schematic = { palette: [water()], blocks: [{ x: -2, y: 3, z: 5, state: 0 }] };
  const geometry = buildFluidGeometry(schematic, [0, 0, -1], makeAssets([asset()]), atlas);
  assert.equal(geometry.index.count, 36); assert.deepEqual(geometry.userData.blockIndices, [0, 0, 0, 0, 0, 0]);
  assert.equal(geometry.userData.centers.length, 18); assert.deepEqual(geometry.userData.faceOrder, [0, 1, 2, 3, 4, 5]);
  close(geometry.boundingBox.min.y, 3); close(geometry.boundingBox.max.y, 3 + 8 / 9);
  for (const face of faces(geometry)) {
    const a = new THREE.Vector3(...face.points[0]), b = new THREE.Vector3(...face.points[1]), c = new THREE.Vector3(...face.points[2]);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    face.normal.forEach((value, i) => close(normal.getComponent(i), value));
  }
  for (let i = 0; i < geometry.attributes.uv.count; i++) {
    const faceNormalY = geometry.attributes.normal.getY(i), u = geometry.attributes.uv.getX(i), v = geometry.attributes.uv.getY(i);
    const region = faceNormalY ? atlas.regions.still : atlas.regions.flow;
    assert.ok(u > region.x / 64 && u < (region.x + region.width) / 64);
    assert.ok(v > 1 - (region.y + region.height) / 64 && v < 1 - region.y / 64);
  }
  geometry.dispose();
});

test('bottom and top waterlogged slabs subtract their actual solid half without overlaying its surface', async () => {
  const [{ buildFluidGeometry }] = await imports;
  for (const top of [false, true]) {
    const schematic = { palette: [contained('stone_slab', { type: top ? 'top' : 'bottom' })], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] };
    const geometry = buildFluidGeometry(schematic, [0], makeAssets([asset(box([0, top ? 8 : 0, 0], [16, top ? 16 : 8, 16]))]), atlas);
    close(geometry.boundingBox.min.y, top ? 0 : 0.5); close(geometry.boundingBox.max.y, top ? 0.5 : 8 / 9);
    assert.equal(faces(geometry).filter(face => atPlane(face, 1, 0.5)).length, 0, 'No water face coincides with the solid slab interface');
    assert.equal(geometry.userData.waterloggedBlocks, 1); assert.equal(geometry.userData.faceOrder.length, 5);
    geometry.dispose();
  }
});

test('stairs honor blockstate yaw and flipped upper-half rotations', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const stairParts = [box([0, 0, 0], [16, 8, 16]), box([0, 8, 8], [16, 16, 16])];
  const schematic = { palette: [contained('oak_stairs')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] };
  const north = buildFluidGeometry(schematic, [0], makeAssets([{ parts: [{ elements: stairParts }] }]), atlas);
  close(north.boundingBox.min.y, 0.5); close(north.boundingBox.max.z, 0.5);
  const east = buildFluidGeometry(schematic, [0], makeAssets([{ parts: [{ y: 90, elements: stairParts }] }]), atlas);
  close(east.boundingBox.min.x, 0.5); close(east.boundingBox.max.x, 1); close(east.boundingBox.min.z, 0); close(east.boundingBox.max.z, 1);
  const upsideDown = buildFluidGeometry(schematic, [0], makeAssets([{ parts: [{ x: 180, elements: stairParts }] }]), atlas);
  close(upsideDown.boundingBox.min.y, 0); close(upsideDown.boundingBox.max.y, 0.5); close(upsideDown.boundingBox.min.z, 0.5);
  north.dispose(); east.dispose(); upsideDown.dispose();
});

test('multipart walls and glass panes leave water only in the unoccupied footprint', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const models = [
    asset(box([4, 0, 4], [12, 16, 12]), box([5, 0, 0], [11, 14, 4])),
    asset(box([7, 0, 0], [9, 16, 16])),
  ];
  for (let i = 0; i < models.length; i++) {
    const schematic = { palette: [contained(i ? 'glass_pane' : 'cobblestone_wall')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] };
    const geometry = buildFluidGeometry(schematic, [0], makeAssets([models[i]]), atlas);
    const tops = faces(geometry).filter(face => face.normal[1] > 0);
    const expected = i ? 7 / 8 : 1 - 1 / 4; // Wall arm ends below water surface; post reaches above it.
    close(tops.reduce((sum, face) => sum + area(face), 0), expected);
    for (const face of tops) {
      const center = face.points[0].map((_, axis) => face.points.reduce((sum, point) => sum + point[axis], 0) / 4);
      assert.ok(i ? center[0] <= 7 / 16 || center[0] >= 9 / 16 : !(center[0] > 0.25 && center[0] < 0.75 && center[2] > 0.25 && center[2] < 0.75));
    }
    geometry.dispose();
  }
});

test('adjacent water and waterlogged blocks remove shared faces, and differing water levels reveal only the exposed strip', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const blocks = [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }];
  const equal = buildFluidGeometry({ palette: [water(), water()], blocks }, [0, 1], makeAssets([asset(), asset()]), atlas);
  assert.equal(equal.userData.faceOrder.length, 10); assert.equal(faces(equal).filter(face => atPlane(face, 0, 1)).length, 0);
  const unequal = buildFluidGeometry({ palette: [water('0'), water('4')], blocks }, [0, 1], makeAssets([asset(), asset()]), atlas);
  const strips = faces(unequal).filter(face => atPlane(face, 0, 1));
  assert.equal(strips.length, 1); close(area(strips[0]), 4 / 9); assert.equal(strips[0].normal[0], 1);
  const slab = buildFluidGeometry({ palette: [water(), contained('stone_slab')], blocks }, [0, 1], makeAssets([asset(), asset(box([0, 0, 0], [16, 8, 16]))]), atlas);
  assert.equal(faces(slab).filter(face => atPlane(face, 0, 1)).length, 0, 'Water joins neighbour water above slab; solid slab hides the lower interface');
  equal.dispose(); unequal.dispose(); slab.dispose();
});

test('vertical water joins are full-height without internal faces and layer filtering restores cut surfaces', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const schematic = { palette: [water()], blocks: [{ x: 0, y: 0, z: 0, state: 0 }, { x: 0, y: 1, z: 0, state: 0 }] }, assets = makeAssets([asset()]);
  const joined = buildFluidGeometry(schematic, [0, 1], assets, atlas);
  assert.equal(joined.userData.faceOrder.length, 10); assert.equal(faces(joined).filter(face => atPlane(face, 1, 1)).length, 0);
  close(joined.boundingBox.max.y, 1 + 8 / 9);
  const cut = buildFluidGeometry(schematic, [0], assets, atlas);
  assert.equal(cut.userData.faceOrder.length, 6); close(cut.boundingBox.max.y, 8 / 9);
  const topOnly = buildFluidGeometry(schematic, [1], assets, atlas);
  assert.equal(faces(topOnly).filter(face => atPlane(face, 1, 1) && face.normal[1] === -1).length, 1);
  joined.dispose(); cut.dispose(); topOnly.dispose();
});

test('only visible opaque neighbours mask water and transparent dry glass preserves its water interface', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const blocks = [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }];
  const solid = asset(box([0, 0, 0], [16, 16, 16]));
  const stoneScene = { palette: [water(), { Name: 'minecraft:stone' }], blocks }, assets = makeAssets([asset(), solid]);
  const withStone = buildFluidGeometry(stoneScene, [0, 1], assets, atlas);
  assert.equal(withStone.userData.faceOrder.length, 5);
  const hiddenStone = buildFluidGeometry(stoneScene, [0], assets, atlas); assert.equal(hiddenStone.userData.faceOrder.length, 6);
  const glass = buildFluidGeometry({ palette: [water(), { Name: 'minecraft:glass' }], blocks }, [0, 1], assets, atlas);
  assert.equal(glass.userData.faceOrder.length, 6);
  withStone.dispose(); hiddenStone.dispose(); glass.dispose();
});

test('binary-alpha trapdoor holes do not let the model box erase the adjacent water surface', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const trapdoor = asset({ from: [0, 0, 0], to: [3, 16, 16], faces: { west: { texture: 'trapdoor' }, east: { texture: 'trapdoor' } } });
  const schematic = { palette: [water(), { Name: 'minecraft:iron_trapdoor', Properties: { open: 'true' } }], blocks: [
    { x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 },
  ] };
  for (const opaque of [true, false]) {
    const localAtlas = { ...atlas, regions: { ...atlas.regions, trapdoor: { x: 44, y: 2, width: 16, height: 16, opaque, translucent: false } } };
    const geometry = buildFluidGeometry(schematic, [0, 1], makeAssets([asset(), trapdoor]), localAtlas);
    const contact = faces(geometry).filter(face => atPlane(face, 0, 1));
    assert.equal(contact.length, opaque ? 0 : 1, 'cutout alpha has no fractional pixels but still exposes the water');
    if (!opaque) close(area(contact[0]), 8 / 9);
    geometry.dispose();
  }
});

test('element rotations and zero-thickness foliage do not create NaNs or fill the whole waterlogged block', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const model = asset(box([6, 0, 6], [10, 16, 10], { axis: 'y', angle: 45, origin: [8, 8, 8], rescale: true }), box([0, 0, 8], [16, 16, 8]));
  const geometry = buildFluidGeometry({ palette: [contained('custom_post')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], makeAssets([model]), atlas);
  for (const attribute of Object.values(geometry.attributes)) assert.ok([...attribute.array].every(Number.isFinite));
  const topArea = faces(geometry).filter(face => face.normal[1] > 0).reduce((sum, face) => sum + area(face), 0);
  assert.ok(topArea > 0.7 && topArea < 1);
  geometry.dispose();
});

test('special-model pixel transforms also move the solid volume subtracted from contained water', async () => {
  const [{ buildFluidGeometry }, THREE] = await imports;
  const model = asset({ ...box([0, 0, 0], [8, 16, 16]), transform: new THREE.Matrix4().makeTranslation(8, 0, 0).toArray() });
  const geometry = buildFluidGeometry({ palette: [contained('custom_pose')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], makeAssets([model]), atlas);
  close(geometry.boundingBox.min.x, 0); close(geometry.boundingBox.max.x, .5);
  const topArea = faces(geometry).filter(face => face.normal[1] > 0).reduce((sum, face) => sum + area(face), 0);
  close(topArea, .5); geometry.dispose();
});

test('cached geometry rebuilds are deterministic and do not alter input states or solid assets', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const schematic = { palette: [contained('stone_slab')], blocks: Array.from({ length: 128 }, (_, i) => ({ x: i % 16, y: 0, z: Math.floor(i / 16), state: 0 })) };
  const assets = makeAssets([asset(box([0, 0, 0], [16, 8, 16]))]), before = JSON.stringify({ schematic, assets });
  const indices = schematic.blocks.map((_, i) => i), a = buildFluidGeometry(schematic, indices, assets, atlas), b = buildFluidGeometry(schematic, indices, assets, atlas);
  assert.deepEqual(a.attributes.position.array, b.attributes.position.array); assert.equal(JSON.stringify({ schematic, assets }), before);
  assert.equal(a.userData.waterloggedBlocks, 128); assert.ok(a.userData.faceOrder.length < 128 * 3, 'Greedy faces and neighbour culling keep the batch compact');
  const dry = buildFluidGeometry({ palette: [{ Name: 'minecraft:lava' }], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], assets, atlas);
  assert.equal(dry.index.count, 0);
  a.dispose(); b.dispose(); dry.dispose();
});

test('known porous full cubes expose inset contained water while dry and unknown cubes remain conservative', async () => {
  const [{ buildFluidGeometry }] = await imports;
  for (const name of ['oak_leaves', 'flowering_azalea_leaves', 'copper_grate', 'waxed_oxidized_copper_grate', 'mangrove_roots']) {
    const schematic = { palette: [contained(name)], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] };
    const geometry = buildFluidGeometry(schematic, [0], makeAssets([asset(box([0, 0, 0], [16, 16, 16]))]), atlas);
    assert.equal(geometry.userData.porousBlocks, 1); assert.equal(geometry.userData.faceOrder.length, 6);
    for (const face of faces(geometry)) {
      const axis = face.normal.findIndex(value => value !== 0);
      if (face.normal[1] === 1) close(face.points[0][1], 8 / 9);
      else close(face.points[0][axis], face.normal[axis] > 0 ? 0.999 : 0.001);
    }
    geometry.dispose();
  }
  const unknown = buildFluidGeometry({ palette: [contained('unknown_full_cube')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], makeAssets([asset(box([0, 0, 0], [16, 16, 16]))]), atlas);
  assert.equal(unknown.index.count, 0);
  const dry = buildFluidGeometry({ palette: [{ Name: 'minecraft:oak_leaves', Properties: { waterlogged: 'false' } }], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], makeAssets([asset(box([0, 0, 0], [16, 16, 16]))]), atlas);
  assert.equal(dry.index.count, 0); unknown.dispose(); dry.dispose();
});

test('porous contained water joins adjacent water without retaining inset shared faces', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const schematic = { palette: [contained('copper_grate'), water()], blocks: [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }] };
  const geometry = buildFluidGeometry(schematic, [0, 1], makeAssets([asset(box([0, 0, 0], [16, 16, 16])), asset()]), atlas);
  assert.equal(geometry.userData.faceOrder.length, 10);
  assert.equal(faces(geometry).filter(face => atPlane(face, 0, 0.999) || atPlane(face, 0, 1)).length, 0);
  geometry.dispose();
});

test('flowing side UVs use half the sprite regardless of resource-pack pixel resolution', async () => {
  const [{ buildFluidGeometry }] = await imports;
  for (const pixels of [16, 32, 64]) {
    const localAtlas = { width: 256, height: 256, regions: { still: { x: 2, y: 2, width: 16, height: 16 }, flow: { x: 80, y: 2, width: pixels, height: pixels } } };
    const schematic = { palette: [water('4')], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] };
    const geometry = buildFluidGeometry(schematic, [0], makeAssets([asset()]), localAtlas);
    const { position, normal, uv } = geometry.attributes;
    let maxSideU = 0, maxSideV = 0, maxTopU = 0;
    for (let i = 0; i < position.count; i++) {
      const side = normal.getY(i) === 0, region = localAtlas.regions[side ? 'flow' : 'still'];
      const u = (uv.getX(i) * 256 - region.x - 0.02) / (region.width - 0.04);
      const v = ((1 - uv.getY(i)) * 256 - region.y - 0.02) / (region.height - 0.04);
      if (side) {
        assert.ok(u >= -1e-6 && u <= 0.5 + 1e-6);
        close(v, (1 - position.getY(i)) * 0.5);
        maxSideU = Math.max(maxSideU, u); maxSideV = Math.max(maxSideV, v);
      } else maxTopU = Math.max(maxTopU, u);
    }
    close(maxSideU, 0.5); close(maxSideV, 0.5); close(maxTopU, 1);
    geometry.dispose();
  }
});

test('fractional-alpha resource-pack stone retains the water interface, while opaque stone occludes it', async () => {
  const [{ buildFluidGeometry }] = await imports;
  const solid = box([0, 0, 0], [16, 16, 16]);
  solid.faces = Object.fromEntries(['north', 'south', 'east', 'west', 'up', 'down'].map(direction => [direction, { texture: 'stone' }]));
  const assets = makeAssets([asset(), asset(solid)]);
  const schematic = { palette: [water(), { Name: 'minecraft:stone', Properties: {} }], blocks: [
    { x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 },
  ] };
  // Reuse the exact assets across atlas changes to catch stale opacity caches.
  for (const translucent of [true, false, true]) {
    const localAtlas = { ...atlas, regions: { ...atlas.regions, stone: { x: 2, y: 24, width: 16, height: 16, opaque: !translucent, translucent } } };
    const geometry = buildFluidGeometry(schematic, [0, 1], assets, localAtlas);
    const interfaceFaces = faces(geometry).filter(face => face.normal[0] === 1 && atPlane(face, 0, 1));
    assert.equal(interfaceFaces.length, translucent ? 1 : 0);
    assert.equal(geometry.userData.faceOrder.length, translucent ? 6 : 5);
    geometry.dispose();
  }
});
