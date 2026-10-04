const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/viewer.js'), import('three')]);

function testAtlas(THREE) {
  return { texture: new THREE.Texture(), width: 16, height: 8, alphaReady: true, regions: {
    cutout: { x: 2, y: 2, width: 2, height: 2, opaque: false, alpha: new Uint8Array([0, 255, 20, 21]) },
    solid: { x: 8, y: 2, width: 2, height: 2, opaque: true },
  } };
}
const element = texture => ({ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture } } });
const asset = texture => ({ parts: [{ elements: [element(texture)] }] });
const rect = { left: 12, top: 34, width: 400, height: 300 };
function eventAt(THREE, viewer, point) {
  viewer.camera.updateMatrixWorld(true);
  const projected = new THREE.Vector3(...point).project(viewer.camera);
  return { clientX: rect.left + (projected.x + 1) * rect.width / 2, clientY: rect.top + (1 - projected.y) * rect.height / 2 };
}
function viewerFor(SchematicViewer, THREE, schematic, meshes, atlas, camera) {
  const scene = new THREE.Scene(); meshes.forEach(mesh => scene.add(mesh));
  const viewer = Object.create(SchematicViewer.prototype);
  Object.assign(viewer, { schematic, meshes, atlas, scene, camera, selection: { visible: false },
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), invalidate() {},
    renderer: { domElement: { getBoundingClientRect: () => rect } } });
  scene.updateMatrixWorld(true);
  return viewer;
}

test('CPU atlas sampling matches canvas Y orientation, nearest texels, and duplicated gutters', async () => {
  const [{ sampleAtlasAlpha }, THREE] = await imports;
  const atlas = testAtlas(THREE);
  const sample = (x, y) => sampleAtlasAlpha(atlas, new THREE.Vector2(x / atlas.width, 1 - y / atlas.height));
  assert.equal(sample(2.5, 2.5), 0);
  assert.equal(sample(3.5, 2.5), 1);
  assert.equal(sample(2.5, 3.5), 20 / 255);
  assert.equal(sample(3.5, 3.5), 21 / 255);
  assert.equal(sample(3.5, 1.5), 1, 'top gutter repeats the top texel');
  assert.equal(sample(4.5, 3.5), 21 / 255, 'right gutter repeats the right texel');
  assert.equal(sample(4.5, 4.5), 0, 'the undrawn gutter corner stays transparent');
  assert.equal(sample(8.5, 2.5), 1, 'opaque tiles need no CPU alpha plane');
  atlas.texture.offset.x = 1 / atlas.width;
  assert.equal(sample(2.5, 2.5), 1, 'texture transforms match rendered UV transforms');
  assert.equal(sampleAtlasAlpha({ ...atlas, alphaReady: false }, new THREE.Vector2()), null);
  atlas.texture.dispose();
});

test('picking uses the material alpha test and opacity, including fractional-alpha transparent pixels', async () => {
  const [{ atlasHitVisible }, THREE] = await imports;
  const atlas = testAtlas(THREE), material = new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: .08 });
  const hit = { object: { material }, face: { materialIndex: 0 }, uv: new THREE.Vector2() };
  const check = (x, y) => { hit.uv.set(x / 16, 1 - y / 8); return atlasHitVisible(hit, atlas); };
  assert.equal(check(2.5, 2.5), false);
  assert.equal(check(2.5, 3.5), false, '20/255 is below the 0.08 cutout threshold');
  assert.equal(check(3.5, 3.5), true, '21/255 is above the threshold');
  material.opacity = .5;
  assert.equal(check(3.5, 3.5), false, 'opacity participates in the shader alpha test');
  material.transparent = true; material.opacity = 1; material.alphaTest = .001;
  atlas.regions.cutout.alpha[2] = 1;
  assert.equal(check(2.5, 3.5), true, 'a visible translucent pixel remains selectable');
  assert.equal(check(2.5, 2.5), false);
  material.alphaTest = 0;
  assert.equal(check(2.5, 2.5), false, 'zero-alpha blended pixels are invisible even without alphaTest');
  material.transparent = false;
  assert.equal(check(2.5, 2.5), true, 'an opaque material without alphaTest renders even a zero-alpha texel');
  const hidden = material.clone(); hidden.visible = false;
  hit.object.material = [material, hidden]; hit.face.materialIndex = 1;
  assert.equal(check(3.5, 2.5), false);
  hidden.dispose(); material.dispose(); atlas.texture.dispose();
});

test('cutout holes select the rear block after instance filtering and select nothing with no rear block', async () => {
  const [{ buildStateGeometry, SchematicViewer }, THREE] = await imports;
  for (const orthographic of [false, true]) {
    const atlas = testAtlas(THREE), schematic = { blocks: [
      { x: 0, y: 0, z: 0, state: 0 }, { x: 4, y: 0, z: 0, state: 0 },
      { x: 0, y: 0, z: 2, state: 1 }, { x: 2, y: 0, z: 0, state: 0 },
    ] };
    const materials = [0, 1].map(() => new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: .08, side: THREE.DoubleSide }));
    const meshes = ['cutout', 'solid'].map((texture, i) => new THREE.InstancedMesh(buildStateGeometry(asset(texture), {}, atlas), materials[i], i ? 1 : 3));
    const camera = orthographic ? new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, .1, 100) : new THREE.PerspectiveCamera(40, 4 / 3, .1, 100);
    camera.position.set(.5, .5, -5); camera.lookAt(.5, .5, 0);
    const viewer = viewerFor(SchematicViewer, THREE, schematic, meshes, atlas, camera);
    viewer.stateMeshes = new Map([[0, meshes[0]], [1, meshes[1]]]);
    viewer.setVisible([3, 2, 0]);
    assert.deepEqual(meshes[0].userData.blockIndices, [3, 0]);
    const hole = eventAt(THREE, viewer, [.75, .75, 0]);
    assert.equal(viewer.pick(hole), 2, `${orthographic ? 'orthographic' : 'perspective'} hole passes through to the source block index`);
    assert.equal(viewer.pick(eventAt(THREE, viewer, [.25, .75, 0])), 0, 'the visible portion of the same filtered instance remains selectable');
    assert.equal(viewer.pick(eventAt(THREE, viewer, [.75, .25, 0])), 2, 'alpha below alphaTest passes through');
    assert.equal(viewer.pick(eventAt(THREE, viewer, [.25, .25, 0])), 0, 'alpha above alphaTest selects the foreground');
    viewer.setVisible([0]);
    assert.equal(viewer.pick(hole), null, 'an empty hole supplies no cursor-zoom surface');
    meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }); atlas.texture.dispose();
  }
});

test('transparent picking preserves filtered block identities after global face sorting', async () => {
  const [{ buildStateGeometry, buildTransparentGeometry, sortTransparentFaces, SchematicViewer }, THREE] = await imports;
  const atlas = testAtlas(THREE); atlas.regions.cutout.alpha.fill(0);
  const schematic = { palette: [{ Name: 'minecraft:glass' }, { Name: 'minecraft:blue_stained_glass' }], blocks: [
    { x: 4, y: 0, z: 0, state: 1 }, { x: 0, y: 0, z: 0, state: 0 }, { x: 0, y: 0, z: 3, state: 1 },
  ] };
  const assets = { blocks: [asset('cutout'), asset('solid')] };
  const source = new Map(assets.blocks.map((a, i) => [i, buildStateGeometry(a, schematic.palette[i], atlas)]));
  const geometry = buildTransparentGeometry(schematic, [2, 1], source, assets);
  const material = new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: .001, transparent: true, side: THREE.FrontSide });
  const mesh = new THREE.Mesh(geometry, material), camera = new THREE.PerspectiveCamera(40, 4 / 3, .1, 100);
  camera.position.set(.5, .5, -5); camera.lookAt(.5, .5, 0);
  sortTransparentFaces(geometry, camera);
  const viewer = viewerFor(SchematicViewer, THREE, schematic, [mesh], atlas, camera);
  const event = eventAt(THREE, viewer, [.5, .5, 0]);
  assert.equal(viewer.pick(event), 2, 'the hole in the nearer sorted face exposes original block 2');
  atlas.regions.cutout.alpha.fill(1);
  assert.equal(viewer.pick(event), 1, 'nonzero translucent alpha selects original block 1');
  atlas.regions.cutout.alpha.fill(0); mesh.geometry = buildTransparentGeometry(schematic, [1], source, assets);
  sortTransparentFaces(mesh.geometry, camera);
  assert.equal(viewer.pick(event), null, 'filtering away the rear face leaves no visible texel to pick');
  mesh.geometry.dispose(); geometry.dispose(); source.forEach(g => g.dispose()); material.dispose(); atlas.texture.dispose();
});
