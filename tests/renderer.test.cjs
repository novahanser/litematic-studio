const test = require('node:test');
const assert = require('node:assert/strict');

const imports = Promise.all([import('../src/renderer/viewer.js'), import('three')]);
const atlas = { width: 64, height: 64, regions: { stone: { x: 2, y: 2, width: 16, height: 16 }, __missing__: { x: 24, y: 2, width: 16, height: 16 } } };
const directions = ['north', 'south', 'west', 'east', 'up', 'down'];
const cube = () => ({ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(directions.map(d => [d, { texture: 'stone' }])) });
const stone = { Name: 'minecraft:stone', Properties: {} };
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.00001, `${a} != ${b}`);

test('all six Minecraft faces have outward winding and UVs within the atlas tile', async () => {
  const [{ buildStateGeometry }] = await imports;
  const geometry = buildStateGeometry({ parts: [{ elements: [cube()] }] }, stone, atlas);
  assert.equal(geometry.index.count, 36);
  const expectedNormals = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const normals = geometry.attributes.normal.array;
  for (let face = 0; face < 6; face++) for (let axis = 0; axis < 3; axis++) close(normals[face * 12 + axis], expectedNormals[face][axis]);
  assert.deepEqual(geometry.boundingBox.min.toArray(), [0, 0, 0]);
  assert.deepEqual(geometry.boundingBox.max.toArray(), [1, 1, 1]);
  const uv = geometry.attributes.uv.array;
  for (let i = 0; i < uv.length; i += 2) {
    assert.ok(uv[i] > 2 / 64 && uv[i] < 18 / 64);
    assert.ok(uv[i + 1] > 1 - 18 / 64 && uv[i + 1] < 1 - 2 / 64);
  }
  geometry.dispose();
});

test('blockstate Y rotation turns north toward east and transforms partial model bounds', async () => {
  const [{ buildStateGeometry }] = await imports;
  const element = cube(); element.to = [16, 8, 8];
  const geometry = buildStateGeometry({ parts: [{ elements: [element], y: 90 }] }, stone, atlas);
  const normal = geometry.attributes.normal;
  close(normal.getX(0), 1); close(normal.getY(0), 0); close(normal.getZ(0), 0);
  geometry.boundingBox.min.toArray().forEach((v, i) => close(v, [0.5, 0, 0][i]));
  geometry.boundingBox.max.toArray().forEach((v, i) => close(v, [1, 0.5, 1][i]));
  geometry.dispose();
});

test('element rotations rescale crossed quads and retain finite geometry', async () => {
  const [{ buildStateGeometry }] = await imports;
  const element = { from: [0, 0, 8], to: [16, 16, 8], rotation: { axis: 'y', angle: 45, origin: [8, 8, 8], rescale: true }, faces: { north: { texture: 'stone' } } };
  const geometry = buildStateGeometry({ parts: [{ elements: [element] }] }, stone, atlas);
  for (const attr of Object.values(geometry.attributes)) assert.ok([...attr.array].every(Number.isFinite));
  close(geometry.boundingBox.min.x, 0); close(geometry.boundingBox.max.x, 1);
  close(geometry.boundingBox.min.z, 0); close(geometry.boundingBox.max.z, 1);
  geometry.dispose();
});

test('UV lock keeps an up face aligned to the world after a blockstate quarter turn', async () => {
  const [{ buildStateGeometry }, THREE] = await imports;
  const element = { ...cube(), faces: { up: { texture: 'stone' } } };
  const original = buildStateGeometry({ parts: [{ elements: [element] }] }, stone, atlas);
  const rotated = buildStateGeometry({ parts: [{ elements: [element], y: 90, uvlock: true }] }, stone, atlas);
  for (let i = 0; i < 4; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(rotated.attributes.position, i);
    let match = -1;
    for (let j = 0; j < 4; j++) if (point.distanceTo(new THREE.Vector3().fromBufferAttribute(original.attributes.position, j)) < 0.00001) match = j;
    assert.ok(match >= 0);
    close(rotated.attributes.uv.getX(i), original.attributes.uv.getX(match));
    close(rotated.attributes.uv.getY(i), original.attributes.uv.getY(match));
  }
  original.dispose(); rotated.dispose();
});

test('filtered instances preserve source indices, world coordinates, and raycast selection', async () => {
  const [{ SchematicViewer }, THREE] = await imports;
  const scene = new THREE.Scene();
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial(), 3);
  scene.add(mesh);
  const viewer = Object.create(SchematicViewer.prototype);
  Object.assign(viewer, {
    schematic: { blocks: [{ x: 0, y: 2, z: 0, state: 0 }, { x: 1, y: 2, z: 0, state: 0 }, { x: 2, y: 2, z: 0, state: 0 }] },
    meshes: [mesh], stateMeshes: new Map([[0, mesh]]), selection: { visible: true }, selectedIndex: 1,
    scene, invalidate() {}, onStats() {}, renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), camera: new THREE.PerspectiveCamera(40, 1, 0.1, 100),
  });
  viewer.setVisible([2, 0, 2, -1]);
  assert.equal(mesh.count, 2);
  assert.deepEqual(mesh.userData.blockIndices, [2, 0]);
  assert.equal(viewer.selection.visible, false);
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [2, 2, 0]);
  viewer.camera.position.set(2.5, 2.5, -5); viewer.camera.lookAt(2.5, 2.5, 0.5); viewer.camera.updateMatrixWorld(true);
  assert.equal(viewer.pick({ clientX: 50, clientY: 50 }), 2);
  viewer.setVisible([]);
  assert.equal(mesh.visible, false);
  assert.equal(viewer.pick({ clientX: 50, clientY: 50 }), null);
  mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose();
});

async function transparentFixture(names, blocks, options = {}) {
  const [{ buildStateGeometry, buildTransparentGeometry }] = await imports;
  const palette = names.map(Name => ({ Name, Properties: {} }));
  const assets = { blocks: names.map(() => ({ parts: [{ elements: [options.element || cube()] }] })) };
  const opaqueAtlas = { ...atlas, regions: { ...atlas.regions, stone: { ...atlas.regions.stone, opaque: options.opaque === true } } };
  const source = new Map(palette.map((state, index) => [index, buildStateGeometry(assets.blocks[index], state, opaqueAtlas)]));
  const schematic = { palette, blocks };
  return { source, schematic, assets, build: indices => buildTransparentGeometry(schematic, indices || blocks.map((_, i) => i), source, assets) };
}

test('adjacent transparent cubes remove both shared faces and filtering restores the cut face', async () => {
  const fixture = await transparentFixture(['minecraft:ice'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 0 }]);
  const together = fixture.build(), cut = fixture.build([0]);
  assert.equal(together.index.count / 6, 10);
  assert.equal(cut.index.count / 6, 6);
  assert.equal(together.userData.blockIndices.filter(index => index === 1).length, 5);
  together.dispose(); cut.dispose(); fixture.source.forEach(geometry => geometry.dispose());
});

test('opaque neighbours hide transparent contact surfaces, alpha-cutout neighbours do not', async () => {
  for (const opaque of [true, false]) {
    const fixture = await transparentFixture(['minecraft:glass', 'minecraft:stone'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }], { opaque });
    const geometry = fixture.build();
    assert.equal(geometry.index.count / 6, opaque ? 5 : 6);
    geometry.dispose(); fixture.source.forEach(source => source.dispose());
  }
});

test('transparent coverage uses transformed face rectangles, retaining exposed partial faces', async () => {
  const [{ buildStateGeometry, buildTransparentGeometry }] = await imports;
  const fixture = await transparentFixture(['minecraft:white_stained_glass_pane'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 0 }], { element: { ...cube(), from: [0, 0, 7], to: [16, 16, 9] } });
  const geometry = fixture.build();
  assert.equal(geometry.index.count / 6, 10);
  const quarter = buildStateGeometry({ parts: [{ elements: [{ ...cube(), to: [16, 8, 8] }], y: 90 }] }, stone, { ...atlas, regions: { stone: { ...atlas.regions.stone, opaque: true } } });
  fixture.schematic.palette.push(stone); fixture.schematic.blocks[1].state = 1; fixture.assets.blocks.push({}); fixture.source.set(1, quarter);
  const partial = buildTransparentGeometry(fixture.schematic, [0, 1], fixture.source, fixture.assets);
  assert.equal(partial.index.count / 6, 6, 'a half-height neighbour must not remove an entire pane face');
  geometry.dispose(); partial.dispose(); fixture.source.forEach(source => source.dispose());
});

test('different transparent materials retain their interface instead of erasing tint boundaries', async () => {
  const fixture = await transparentFixture(['minecraft:white_stained_glass', 'minecraft:blue_stained_glass'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }]);
  const geometry = fixture.build();
  assert.equal(geometry.index.count / 6, 12);
  geometry.dispose(); fixture.source.forEach(source => source.dispose());
});

test('partial opaque coverage clips only the hidden area and interpolates the original UVs', async () => {
  const [{ buildStateGeometry, buildTransparentGeometry }] = await imports;
  const palette = [{ Name: 'minecraft:glass' }, stone];
  const assets = { blocks: [{ parts: [{ elements: [cube()] }] }, { parts: [{ elements: [{ ...cube(), to: [16, 8, 16] }] }] }] };
  const source = new Map(palette.map((s,i) => [i, buildStateGeometry(assets.blocks[i], s, { ...atlas, regions: { stone: { ...atlas.regions.stone, opaque: i === 1 } } })]));
  const schematic = { palette, blocks: [{ x:0,y:0,z:0,state:0 }, { x:1,y:0,z:0,state:1 }] };
  const result = buildTransparentGeometry(schematic, [0,1], source, assets);
  const east = [];
  for(let i=0;i<result.attributes.position.count;i++) if(result.attributes.normal.getX(i) > .99) east.push(i);
  assert.equal(east.length, 4);
  assert.deepEqual([...new Set(east.map(i=>result.attributes.position.getY(i)))].sort(), [.5,1]);
  const original = source.get(0).attributes.uv;
  const originalVSpan = Math.abs(original.getY(12) - original.getY(13));
  close(Math.max(...east.map(i=>result.attributes.uv.getY(i))) - Math.min(...east.map(i=>result.attributes.uv.getY(i))), originalVSpan / 2);
  result.dispose(); source.forEach(g=>g.dispose());
});

test('two neighbour model pieces jointly occlude a complete glass surface', async () => {
  const [{ buildStateGeometry, buildTransparentGeometry }] = await imports;
  const palette = [{ Name:'minecraft:glass' }, stone];
  const assets = { blocks: [{ parts:[{ elements:[cube()] }] }, { parts:[{ elements:[{ ...cube(), to:[16,8,16] }, { ...cube(), from:[0,8,0] }] }] }] };
  const source = new Map(palette.map((s,i)=>[i,buildStateGeometry(assets.blocks[i],s,{...atlas,regions:{stone:{...atlas.regions.stone,opaque:i===1}}})]));
  const result = buildTransparentGeometry({palette,blocks:[{x:0,y:0,z:0,state:0},{x:1,y:0,z:0,state:1}]},[0,1],source,assets);
  assert.equal(result.index.count / 6, 5);
  result.dispose(); source.forEach(g=>g.dispose());
});

test('resource-pack fractional alpha enables blending for any block, while cutout alpha stays opaque', async () => {
  const [{ buildStateGeometry, transparentState }] = await imports;
  for(const translucent of [true,false]) {
    const geometry = buildStateGeometry({parts:[{elements:[cube()]}]},stone,{...atlas,regions:{stone:{...atlas.regions.stone,opaque:false,translucent}}});
    assert.equal(transparentState(stone,{},geometry),translucent);
    geometry.dispose();
  }
});

test('stacked water fills the vertical seam and removes the internal fluid surface', async () => {
  const fixture = await transparentFixture(['minecraft:water'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 0, y: 1, z: 0, state: 0 }], { element: { ...cube(), to: [16, 128 / 9, 16] } });
  fixture.assets.blocks[0].fluid = true;
  const geometry = fixture.build();
  assert.equal(geometry.index.count / 6, 10);
  const lower = [];
  geometry.userData.blockIndices.forEach((index, face) => { if (index === 0) for (let vertex = 0; vertex < 4; vertex++) lower.push(geometry.attributes.position.getY(face * 4 + vertex)); });
  close(Math.max(...lower), 1);
  const single = fixture.build([0]);
  close(single.boundingBox.max.y, 8 / 9);
  assert.equal(single.index.count / 6, 6);
  geometry.dispose(); single.dispose(); fixture.source.forEach(source => source.dispose());
});

test('transparent faces sort globally across states and raycast identity follows sorted faces', async () => {
  const [{ sortTransparentFaces, SchematicViewer }, THREE] = await imports;
  const fixture = await transparentFixture(['minecraft:ice', 'minecraft:glass'], [{ x: 0, y: 0, z: 0, state: 0 }, { x: 0, y: 0, z: 4, state: 1 }]);
  const geometry = fixture.build(), camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
  camera.position.set(0.5, 0.5, -5); camera.lookAt(0.5, 0.5, 0);
  sortTransparentFaces(geometry, camera);
  assert.equal(geometry.userData.blockIndices[geometry.userData.faceOrder[0]], 1);
  const viewer = Object.create(SchematicViewer.prototype);
  Object.assign(viewer, { schematic: fixture.schematic, meshes: [mesh], camera, pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } });
  mesh.updateMatrixWorld(true);
  assert.equal(viewer.pick({ clientX: 50, clientY: 50 }), 0);
  camera.position.set(0.5, 0.5, 10); camera.lookAt(0.5, 0.5, 0);
  sortTransparentFaces(geometry, camera);
  assert.equal(geometry.userData.blockIndices[geometry.userData.faceOrder[0]], 0);
  assert.equal(viewer.pick({ clientX: 50, clientY: 50 }), 1);
  geometry.dispose(); mesh.material.dispose(); fixture.source.forEach(source => source.dispose());
});

test('merged glass and fluid batches retain their block identities after global sorting', async () => {
  const [{ mergeTransparentGeometries, sortTransparentFaces, SchematicViewer }, THREE] = await imports;
  const fixture=await transparentFixture(['minecraft:glass'],[{x:0,y:0,z:0,state:0},{x:0,y:0,z:3,state:0}]);
  const near=fixture.build([0]),far=fixture.build([1]),merged=mergeTransparentGeometries([near,far]);
  assert.equal(merged.index.count,near.index.count+far.index.count);
  assert.deepEqual(merged.userData.blockIndices,[...near.userData.blockIndices,...far.userData.blockIndices]);
  const camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.set(.5,.5,-3);camera.lookAt(.5,.5,1);
  sortTransparentFaces(merged,camera);
  const mesh=new THREE.Mesh(merged,new THREE.MeshBasicMaterial({side:THREE.FrontSide}));mesh.updateMatrixWorld(true);
  const viewer=Object.create(SchematicViewer.prototype);
  Object.assign(viewer,{schematic:fixture.schematic,meshes:[mesh],camera,pointer:new THREE.Vector2(),raycaster:new THREE.Raycaster(),renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})}}});
  assert.equal(viewer.pick({clientX:50,clientY:50}),0);
  camera.position.z=8;camera.lookAt(.5,.5,1);sortTransparentFaces(merged,camera);
  assert.equal(viewer.pick({clientX:50,clientY:50}),1);
  [near,far,merged,...fixture.source.values()].forEach(g=>g.dispose());mesh.material.dispose();
});

test('projection switching preserves framing and orthographic fit, zoom and focus remain finite', async () => {
  const [{ SchematicViewer }, THREE] = await imports;
  const viewer = Object.create(SchematicViewer.prototype);
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.05, 10000);
  camera.position.set(10, 8, 12);
  const controls = { target: new THREE.Vector3(1, 2, 3), object: camera, minDistance: 0.2, maxDistance: 50000, update() { this.object.lookAt(this.target); } };
  Object.assign(viewer, { camera, controls, invalidate() {}, host: { clientWidth: 800, clientHeight: 600 }, renderer: { setSize() {} }, schematic: { blocks: [{ x: 1, y: 2, z: 3 }] }, selection: { position: new THREE.Vector3() }, visibleSet: new Set([0]) });
  controls.update();
  const beforeDistance = camera.position.distanceTo(controls.target);
  viewer.setProjection('orthographic');
  assert.equal(viewer.getProjection(), 'orthographic');
  assert.equal(controls.object, viewer.camera);
  viewer.setProjection('perspective');
  close(viewer.camera.position.distanceTo(controls.target), beforeDistance);
  viewer.setProjection('orthographic'); viewer.fit();
  viewer.zoom(2); assert.equal(viewer.camera.zoom, 2);
  viewer.focus(0); assert.deepEqual(viewer.controls.target.toArray(), [1.5, 2.5, 3.5]);
  assert.ok(viewer.camera.projectionMatrix.elements.every(Number.isFinite));
  viewer.resize(); assert.ok(viewer.camera.left < 0 && viewer.camera.right > 0);
  for (const direction of ['front', 'back', 'side', 'left', 'top', 'bottom']) { viewer.view(direction); assert.ok(viewer.camera.position.toArray().every(Number.isFinite)); }
});

test('out-of-range sprite UV patches preserve neighbour clipping, sorted face identity and ray picking', async () => {
  const [{ buildStateGeometry, buildTransparentGeometry, sortTransparentFaces, SchematicViewer, createBlockMaterial }, THREE] = await imports;
  const localAtlas = { texture: null, width: 64, height: 64, regions: {
    glass: { x: 2, y: 2, width: 16, height: 16, opaque: false },
    solid: { x: 24, y: 2, width: 16, height: 16, opaque: true },
  } };
  const schematic = { palette: [{ Name: 'minecraft:glass' }, stone], blocks: [{ x: 0, y: 0, z: 0, state: 0 }, { x: 1, y: 0, z: 0, state: 1 }] };
  const assets = { blocks: [
    { parts: [{ elements: [{ ...cube(), faces: { east: { texture: 'glass', uv: [-8, -8, 24, 24] } } }] }] },
    { parts: [{ elements: [{ ...cube(), to: [16, 8, 16], faces: { west: { texture: 'solid' } } }] }] },
  ] };
  const source = new Map(assets.blocks.map((a, i) => [i, buildStateGeometry(a, schematic.palette[i], localAtlas)]));
  assert.equal(source.get(0).index.count / 6, 9, 'only the out-of-range face needs subdivision');
  const geometry = buildTransparentGeometry(schematic, [1, 0], source, assets);
  assert.equal(geometry.index.count / 6, 6, 'the opaque neighbour clips the lower half of the subdivided face');
  const { position, uv } = geometry.attributes;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i), z = position.getZ(i);
    assert.ok(y >= .5);
    const expectedU = Math.max(0, Math.min(16, 24 - 32 * z)), expectedV = Math.max(0, Math.min(16, 24 - 32 * y));
    close(uv.getX(i), (2.02 + expectedU / 16 * 15.96) / 64);
    close(uv.getY(i), 1 - (2.02 + expectedV / 16 * 15.96) / 64);
  }
  assert.ok(geometry.userData.blockIndices.every(index => index === 0));
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
  camera.position.set(5, .75, .5); camera.lookAt(1, .75, .5); sortTransparentFaces(geometry, camera);
  const material = createBlockMaterial(localAtlas, true), mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
  const viewer = Object.create(SchematicViewer.prototype);
  Object.assign(viewer, { schematic, meshes: [mesh], camera, pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } });
  assert.equal(viewer.pick({ clientX: 50, clientY: 50 }), 0);
  geometry.dispose(); source.forEach(g => g.dispose()); material.dispose();
});
