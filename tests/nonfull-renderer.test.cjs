const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/viewer.js'), import('three')]);
const axes = ['x', 'y', 'z'], pairs = [['west', 'east'], ['down', 'up'], ['north', 'south']];
const atlas = { texture: null, width: 64, height: 64, regions: { tile: { x: 2, y: 2, width: 16, height: 16, opaque: false } } };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('zero-thickness paired model faces remain visible from either side without DoubleSide', async () => {
  const [{ buildStateGeometry, createBlockMaterial }, THREE] = await imports;
  for (let axis = 0; axis < 3; axis++) for (const y of [0, 90, 180, 270]) {
    const from = [0, 0, 0], to = [16, 16, 16]; from[axis] = to[axis] = 8;
    const geometry = buildStateGeometry({ parts: [{ y, elements: [{ from, to, faces: Object.fromEntries(pairs[axis].map(d => [d, { texture: 'tile' }])) }] }] }, {}, atlas);
    const material = createBlockMaterial(atlas), mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
    const first = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, 0), second = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, 4);
    close(first.dot(second), -1); assert.equal(material.side, THREE.FrontSide);
    const center = new THREE.Vector3(.5, .5, .5);
    for (const normal of [first, second]) {
      const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, 2), normal.clone().negate());
      const hits = ray.intersectObject(mesh);
      assert.ok(hits.length > 0);
      assert.ok(hits.every(hit => hit.face.normal.dot(normal) > .99), 'only the model-declared side facing the viewer is selected');
    }
    geometry.dispose(); material.dispose();
  }
});

test('element rotation and rescale preserve the rotation axis and projected span for every axis/sign', async () => {
  const [{ buildStateGeometry }] = await imports;
  for (let axis = 0; axis < 3; axis++) for (const angle of [-45, -22.5, 22.5, 45]) {
    const a = (axis + 1) % 3, b = (axis + 2) % 3, from = [8, 8, 8], to = [8, 8, 8];
    from[axis] = 2; to[axis] = 14; from[a] = 0; to[a] = 16;
    const geometry = buildStateGeometry({ parts: [{ elements: [{ from, to, rotation: { axis: axes[axis], angle, origin: [8, 8, 8], rescale: true },
      faces: { [pairs[b][0]]: { texture: 'tile', uv: [0, 0, 16, 16] } },
    }] }] }, {}, atlas);
    const min = geometry.boundingBox.min.toArray(), max = geometry.boundingBox.max.toArray();
    close(min[axis], 2 / 16); close(max[axis], 14 / 16);
    close(min[a], 0); close(max[a], 1);
    close(max[b] - min[b], Math.abs(Math.tan(angle * Math.PI / 180)));
    for (const attribute of Object.values(geometry.attributes)) assert.ok([...attribute.array].every(Number.isFinite));
    geometry.dispose();
  }
});

test('explicit sRGB face colors tint only the specified surface and are converted to linear light', async () => {
  const [{ buildStateGeometry }, THREE] = await imports;
  const geometry = buildStateGeometry({ parts: [{ elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
    north: { texture: 'tile', colorRGB: [.25, .5, .75] }, south: { texture: 'tile' },
  } }] }] }, { Name: 'minecraft:blue_banner' }, atlas);
  const expected = new THREE.Color().setRGB(.25, .5, .75, THREE.SRGBColorSpace);
  const color = geometry.attributes.color;
  close(color.getX(0), expected.r); close(color.getY(0), expected.g); close(color.getZ(0), expected.b);
  assert.deepEqual([color.getX(4), color.getY(4), color.getZ(4)], [1, 1, 1]);
  geometry.dispose();
});

test('all local vanilla thin-plane and rescaled source elements retain finite directional faces inside their texture tile', { skip: !process.env.MINECRAFT_JAR && 'Set MINECRAFT_JAR to audit the installed game models.' }, async t => {
  const [{ buildStateGeometry, createBlockMaterial }, THREE] = await imports, Zip = require('adm-zip');
  const jar = new Zip(process.env.MINECRAFT_JAR); let thin = 0, rescaled = 0, checkedFaces = 0, degenerate = 0;
  for (const entry of jar.getEntries()) {
    if (!/^assets\/minecraft\/models\/block\/.*\.json$/.test(entry.entryName)) continue;
    const model = JSON.parse(jar.readAsText(entry));
    for (const element of model.elements || []) {
      const flat = element.from.some((v, axis) => v === element.to[axis]);
      if (!flat && !element.rotation?.rescale) continue;
      if (flat) thin++; if (element.rotation?.rescale) rescaled++;
      for (const [direction, face] of Object.entries(element.faces || {})) {
        const geometry = buildStateGeometry({ parts: [{ elements: [{ ...element, faces: { [direction]: { ...face, texture: 'tile' } } }] }] }, {}, atlas);
        const normalAxis = pairs.findIndex(pair => pair.includes(direction));
        const zeroArea = element.from.some((v, axis) => axis !== normalAxis && v === element.to[axis]);
        if (zeroArea) { assert.equal(geometry.index.count, 0); degenerate++; geometry.dispose(); continue; }
        for (const attribute of Object.values(geometry.attributes)) assert.ok([...attribute.array].every(Number.isFinite), entry.entryName);
        const normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, 0);
        close(normal.length(), 1);
        const material = createBlockMaterial(atlas), mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
        const center = geometry.boundingBox.getCenter(new THREE.Vector3());
        const ray = new THREE.Raycaster(center.clone().add(normal), normal.clone().negate());
        assert.ok(ray.intersectObject(mesh).length > 0, `${entry.entryName} ${direction} front`);
        ray.set(center.clone().sub(normal), normal);
        assert.equal(ray.intersectObject(mesh).length, 0, `${entry.entryName} ${direction} back`);
        const uv = geometry.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
          assert.ok(uv.getX(i) > 2 / 64 && uv.getX(i) < 18 / 64, `${entry.entryName} u`);
          assert.ok(uv.getY(i) > 1 - 18 / 64 && uv.getY(i) < 1 - 2 / 64, `${entry.entryName} v`);
        }
        checkedFaces++; geometry.dispose(); material.dispose();
      }
    }
  }
  assert.ok(thin >= 400 && rescaled >= 90 && checkedFaces > 700);
  t.diagnostic(`Validated ${thin} thin elements, ${rescaled} rescaled elements, ${checkedFaces} real faces; ${degenerate} zero-area source edges omitted.`);
});

test('pixel-space element transforms preserve compound poses, exact bounds, normals and ray selection', async () => {
  const [{ buildStateGeometry, createBlockMaterial }, THREE] = await imports;
  const directions = pairs.flat(), from = [0, 0, 0], to = [4, 8, 12];
  const pose = new THREE.Matrix4().makeTranslation(8, 24, 8).multiply(new THREE.Matrix4().makeRotationY(.5))
    .multiply(new THREE.Matrix4().makeRotationX(-.3)).multiply(new THREE.Matrix4().makeTranslation(-2, -4, -6));
  const geometry = buildStateGeometry({ parts: [{ y: 90, elements: [{ from, to, transform: pose.toArray(),
    faces: Object.fromEntries(directions.map(d => [d, { texture: 'tile', uv: [0, 0, 16, 16] }])),
  }] }] }, {}, atlas);
  const expected = new THREE.Box3(), partRotation = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  for (const x of [from[0], to[0]]) for (const y of [from[1], to[1]]) for (const z of [from[2], to[2]]) {
    expected.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(pose).divideScalar(16).subScalar(.5).applyMatrix4(partRotation).addScalar(.5));
  }
  geometry.boundingBox.min.toArray().forEach((v, i) => close(v, expected.min.toArray()[i]));
  geometry.boundingBox.max.toArray().forEach((v, i) => close(v, expected.max.toArray()[i]));
  const material = createBlockMaterial(atlas), mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
  for (let face = 0; face < 6; face++) {
    const center = new THREE.Vector3();
    for (let i = 0; i < 4; i++) center.add(new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, face * 4 + i));
    center.divideScalar(4);
    const normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, face * 4);
    const ray = new THREE.Raycaster(center.clone().add(normal), normal.clone().negate());
    const hit = ray.intersectObject(mesh)[0]; assert.ok(hit); close(hit.point.distanceTo(center), 0);
    close(hit.face.normal.dot(normal), 1);
  }
  geometry.dispose(); material.dispose();
});

test('fit and focus include tall/low model extents while the selection box stays on its placement cell', async () => {
  const [{ buildStateGeometry, createBlockMaterial, SchematicViewer }, THREE] = await imports;
  const shapes = [[[0, 0, 7], [16, 48, 9]], [[0, -24, 14], [16, 16, 16]]];
  const schematic = { palette: [{ Name: 'minecraft:white_banner' }, { Name: 'minecraft:white_wall_banner' }], blocks: [
    { x: 0, y: 0, z: 0, state: 0 }, { x: 3, y: 0, z: 0, state: 1 },
  ] };
  const scene = new THREE.Scene(), material = createBlockMaterial(atlas);
  const meshes = shapes.map(([from, to]) => new THREE.InstancedMesh(buildStateGeometry({ parts: [{ elements: [{ from, to,
    faces: Object.fromEntries(pairs.flat().map(d => [d, { texture: 'tile', uv: [0, 0, 16, 16] }])),
  }] }] }, {}, atlas), material, 1));
  meshes.forEach(mesh => scene.add(mesh));
  const viewer = Object.create(SchematicViewer.prototype), camera = new THREE.PerspectiveCamera(42, 4 / 3, .05, 1000);
  camera.position.set(8, 9, 10);
  const controls = { target: new THREE.Vector3(), object: camera, update() { this.object.lookAt(this.target); this.object.updateMatrixWorld(true); } };
  Object.assign(viewer, { schematic, meshes, scene, stateMeshes: new Map(meshes.map((mesh, i) => [i, mesh])), camera, controls,
    selection: { visible: false, position: new THREE.Vector3() }, invalidate() {}, host: { clientWidth: 800, clientHeight: 600 }, renderer: { setSize() {} } });
  viewer.setVisible([0, 1]); close(viewer.bounds().min.y, -1.5); close(viewer.bounds().max.y, 3);
  for (const projection of ['perspective', 'orthographic']) {
    viewer.setProjection(projection); viewer.fit();
    const bounds = viewer.bounds();
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(x, y, z).project(viewer.camera);
      assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1, `${projection} must contain every model-bound corner`);
    }
    viewer.focus(0); assert.deepEqual(viewer.controls.target.toArray(), [.5, 1.5, .5]);
    assert.deepEqual(viewer.selection.position.toArray(), [.5, .5, .5]);
  }
  viewer.setVisible([1]); close(viewer.bounds().min.y, -1.5); close(viewer.bounds().max.y, 1);
  meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.dispose(); }); material.dispose();
});

test('verified skull NoCull faces reveal the interior through a cutout hole without changing ordinary block culling', async () => {
  const [{ buildStateGeometry, createBlockMaterial, transparentState, SchematicViewer }, THREE] = await imports;
  const localAtlas = { texture: new THREE.Texture(), width: 64, height: 32, alphaReady: true, regions: {
    hole: { x: 2, y: 2, width: 16, height: 16, opaque: false, translucent: true, alpha: new Uint8Array(256).fill(25) },
    solid: { x: 24, y: 2, width: 16, height: 16, opaque: true },
  } };
  const block = { Name: 'minecraft:skeleton_skull', Properties: { rotation: '0' } };
  const parts = [{ elements: [{ from: [4, 0, 4], to: [12, 8, 12], faces: Object.fromEntries(pairs.flat().map(d =>
    [d, { texture: d === 'down' ? 'hole' : 'solid', uv: [0, 0, 16, 16] }])) }] }];
  const skull = { parts, renderType: 'entity-cutout-no-cull' }, ordinary = { parts };
  const geometry = buildStateGeometry(skull, block, localAtlas), normalGeometry = buildStateGeometry(ordinary, block, localAtlas);
  assert.equal(geometry.index.count, normalGeometry.index.count * 2);
  assert.equal(geometry.userData.quads.length, geometry.index.count / 6);
  for (let face = 0; face < geometry.userData.quads.length; face += 2) {
    const originalNormal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, face * 4);
    const reversedNormal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, (face + 1) * 4);
    close(originalNormal.dot(reversedNormal), -1);
    for (let i = 0; i < 4; i++) {
      const source = face * 4 + [0, 3, 2, 1][i], reversed = (face + 1) * 4 + i;
      for (const attribute of ['position', 'uv']) {
        const values = geometry.attributes[attribute];
        for (let axis = 0; axis < values.itemSize; axis++) close(values.array[source * values.itemSize + axis], values.array[reversed * values.itemSize + axis]);
      }
    }
  }
  assert.equal(transparentState(block, skull, geometry), false, 'fractional texels do not change the original entity cutout render type');
  assert.equal(transparentState(block, ordinary, normalGeometry), true, 'ordinary resource-pack blending classification remains unchanged');
  const material = createBlockMaterial(localAtlas, false, skull), regular = createBlockMaterial(localAtlas);
  assert.equal(material.side, THREE.FrontSide); assert.equal(regular.side, THREE.FrontSide);
  close(material.alphaTest, .1); close(regular.alphaTest, .08);
  assert.equal(material.depthWrite, true); assert.equal(material.transparent, false);
  const mesh = new THREE.InstancedMesh(geometry, material, 1); mesh.setMatrixAt(0, new THREE.Matrix4()); mesh.userData.blockIndices = [0]; mesh.updateMatrixWorld(true);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 10); camera.position.set(.5, -2, .5); camera.up.set(0, 0, 1); camera.lookAt(.5, .25, .5); camera.updateMatrixWorld(true);
  const viewer = Object.create(SchematicViewer.prototype);
  Object.assign(viewer, { schematic: { palette: [block], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, atlas: localAtlas, meshes: [mesh], camera,
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(), renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } });
  const event = { clientX: 50, clientY: 50 };
  close(viewer.pickTarget(event, false).point.y, .5, 'the back of the top face is visible through the low-alpha bottom texel');
  mesh.geometry = normalGeometry;
  assert.equal(viewer.pickTarget(event, false), null, 'the ordinary one-sided model does not expose its interior');
  mesh.geometry = geometry; localAtlas.regions.hole.alpha.fill(26);
  close(viewer.pickTarget(event, false).point.y, 0, '26/255 passes the skull-specific 0.1 cutoff');
  geometry.dispose(); normalGeometry.dispose(); material.dispose(); regular.dispose(); mesh.dispose(); localAtlas.texture.dispose();
});
