'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/entity-view.js'), import('three')]);
const entity = (id = 'minecraft:item_frame', position = { x: 0, y: 2.5, z: 0 }, nbt = {}) => ({ id, position, rotation: [0, 0], nbt });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('six item frame directions face the wall normal instead of relying only on yaw', async () => {
  const [{ frameOrientation }, THREE] = await imports;
  const expected = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  expected.forEach((normal, Facing) => {
    const result = new THREE.Vector3(0, 0, 1).applyEuler(frameOrientation({ Facing }, [270, 0]));
    result.toArray().forEach((n, axis) => near(n, normal[axis]));
  });
});

test('preview geometry keeps world position, item rotation, and source index for selection', async () => {
  const [{ EntityPreviewLayer }, THREE] = await imports;
  const source = [entity('minecraft:item_frame', { x: 12, y: -2.5, z: 7 }, { Facing: 3, ItemRotation: 2 })];
  const layer = new EntityPreviewLayer(source, { entities: [{ kind: 'item_frame', item: { id: 'minecraft:ice', isBlock: true } }] });
  await layer.ready;
  const frame = layer.objects[0], item = frame.children.find(o => o.userData.itemId);
  near(item.rotation.z, -Math.PI / 2);
  assert.equal(frame.children.length, 6);
  assert.deepEqual(frame.position.toArray(), [12, -2.5, 7]);
  const ray = new THREE.Raycaster(new THREE.Vector3(12, -2.5, 10), new THREE.Vector3(0, 0, -1));
  const picked = layer.pick(ray);
  assert.equal(picked.index, 0); assert.equal(picked.entity, source[0]); assert.ok(picked.distance < 3.1);
  const bounds = layer.focusBounds(0);
  assert.ok(bounds.min.x > 11.6 && bounds.max.x < 12.4);
  layer.dispose();
});

test('entity visibility uses selected integer layers and supports negative coordinates, indices and a global switch', async () => {
  const [{ EntityPreviewLayer }, THREE] = await imports;
  const entities = [entity(undefined, { x: 0, y: -0.1, z: 0 }), entity(undefined, { x: 0, y: 2.7, z: 0 }), { id: 'minecraft:unknown', position: null }];
  const layer = new EntityPreviewLayer(entities, { entities: [{ kind: 'item_frame' }, { kind: 'item_frame' }, { kind: 'unknown' }] });
  layer.setFilter({ layers: [-1] }); assert.deepEqual(layer.getVisibleIndices(), [0]);
  layer.setFilter({ layers: null, minY: 2, maxY: 2 }); assert.deepEqual(layer.getVisibleIndices(), [1]);
  layer.setVisible(false); assert.deepEqual(layer.getVisibleIndices(), []);
  assert.equal(layer.pick(new THREE.Raycaster()), null);
  layer.setVisible(true); assert.deepEqual(layer.getVisibleIndices(), [1]);
  layer.setVisible([0]); assert.deepEqual(layer.getVisibleIndices(), []);
  layer.setFilter({ minY: null, maxY: null }); assert.deepEqual(layer.getVisibleIndices(), [0]);
  assert.equal(layer.focusBounds(2), null);
  layer.dispose();
});

test('known entity previews have recognizable multipart shapes and unknown entities are marked', async () => {
  const [{ EntityPreviewLayer }] = await imports;
  const ids = ['armor_stand', 'minecart', 'oak_boat', 'zombie', 'creeper', 'cow', 'chicken', 'custom'];
  const kinds = ['armor_stand', 'minecart', 'boat', 'humanoid', 'creeper', 'quadruped', 'chicken', 'unknown'];
  const layer = new EntityPreviewLayer(ids.map(id => entity(`minecraft:${id}`, { x: 0, y: 0, z: 0 }, { ShowArms: 1 })), { entities: kinds.map(kind => ({ kind })) });
  layer.objects.forEach((object, index) => {
    const geometryObjects = []; object.traverse(child => { if (child.geometry) geometryObjects.push(child); });
    if (index < kinds.length - 1) assert.ok(geometryObjects.length >= 5, `${ids[index]} has multiple body parts`);
    else assert.equal(object.userData.placeholder, true);
    for (const mesh of geometryObjects) assert.ok([...mesh.geometry.attributes.position.array].every(Number.isFinite));
    assert.ok(!layer.focusBounds(index).isEmpty());
  });
  layer.dispose();
});

test('invisible item frames preserve their contents while hiding the wood frame', async () => {
  const [{ EntityPreviewLayer }] = await imports;
  const layer = new EntityPreviewLayer([entity(undefined, undefined, { Invisible: 1 })], { entities: [{ kind: 'item_frame', item: { id: 'minecraft:ice', isBlock: true } }] });
  assert.equal(layer.objects[0].children.length, 1);
  assert.equal(layer.objects[0].children[0].userData.itemId, 'minecraft:ice');
  layer.dispose();
});

test('rotated block items stay entirely in front of the item frame backing', async () => {
  const [{ EntityPreviewLayer }, THREE] = await imports;
  for (let ItemRotation = 0; ItemRotation < 8; ItemRotation++) {
    const layer = new EntityPreviewLayer([entity(undefined, { x: 0, y: 0, z: 0 }, { Facing: 3, ItemRotation })], { entities: [{ kind: 'item_frame', item: { id: 'minecraft:ice', isBlock: true } }] });
    const item = layer.objects[0].children.find(child => child.userData.itemId);
    const bounds = new THREE.Box3().setFromObject(item);
    assert.ok(bounds.min.z > 0.021, `rotation ${ItemRotation} must not penetrate the backing`);
    assert.ok(bounds.max.z < 0.14, `rotation ${ItemRotation} stays shallow`);
    layer.dispose();
  }
});

test('block display is a unit block and preserves compound translation and scale', async () => {
  const [{ EntityPreviewLayer }] = await imports;
  const layer = new EntityPreviewLayer([entity('minecraft:block_display', { x: 5, y: 6, z: 7 }, { transformation: { translation: [1, 2, 3], scale: [2, 3, 4] } })], { entities: [{ kind: 'block_display', item: { id: 'minecraft:stone', isBlock: true } }] });
  const bounds = layer.focusBounds(0);
  assert.deepEqual(bounds.min.toArray(), [6, 8, 10]);
  assert.deepEqual(bounds.max.toArray(), [8, 11, 14]);
  layer.dispose();
});

test('texture loading only accepts inline PNG data and disposal releases geometry, materials, and texture', async () => {
  const [{ EntityPreviewLayer }, THREE] = await imports;
  const paths = [], textures = [];
  const textureLoader = { load(path, onLoad) { paths.push(path); const texture = new THREE.Texture(); textures.push(texture); queueMicrotask(onLoad); return texture; } };
  const layer = new EntityPreviewLayer([entity()], { textures: { local: 'data:image/png;base64,AAAA', remote: 'https://example.com/external.png' }, entities: [{ kind: 'item_frame', texture: 'local', borderTexture: 'remote' }] }, { textureLoader });
  await layer.ready; assert.deepEqual(paths, ['data:image/png;base64,AAAA']);
  let textureDisposed = 0, geometryDisposed = 0;
  textures[0].addEventListener('dispose', () => textureDisposed++);
  layer.objects[0].children[0].geometry.addEventListener('dispose', () => geometryDisposed++);
  layer.dispose(); layer.dispose();
  assert.equal(textureDisposed, 1); assert.equal(geometryDisposed, 1); assert.equal(layer.group.children.length, 0);
});
