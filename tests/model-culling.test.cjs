const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/viewer.js'), import('three')]);
const directions = ['up', 'down', 'south', 'north', 'east', 'west'];
const atlas = { texture: null, width: 32, height: 32, regions: { lit: { x: 2, y: 2, width: 16, height: 16, opaque: true } } };

async function assertDirectionalFace(part, block, faceAtlas) {
  const [{ buildStateGeometry, createBlockMaterial }, THREE] = await imports;
  const geometry = buildStateGeometry({ parts: [part] }, block, faceAtlas);
  assert.equal(geometry.attributes.position.count, 4);
  const center = new THREE.Vector3();
  for (let i = 0; i < 4; i++) center.add(new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, i));
  center.divideScalar(4);
  const normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, 0);
  // An inward-facing glow quad must not cover its torch when viewed from the
  // outside. Keep the declared face: its front remains visible from inside.
  for (const transparent of [false, true]) {
    const material = createBlockMaterial(faceAtlas, transparent), mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrixWorld(true);
    assert.equal(material.side, THREE.FrontSide);
    const ray = new THREE.Raycaster(center.clone().addScaledVector(normal, -.5), normal.clone());
    assert.equal(ray.intersectObject(mesh).length, 0, 'the model back face must be culled, including translucent resource-pack variants');
    ray.set(center.clone().addScaledVector(normal, .5), normal.clone().negate());
    assert.ok(ray.intersectObject(mesh).length > 0, 'the explicitly declared front face is retained');
    material.side = THREE.DoubleSide;
    ray.set(center.clone().addScaledVector(normal, -.5), normal);
    assert.ok(ray.intersectObject(mesh).length > 0, 'this fixture reproduces the previous unwanted outward red face');
    material.dispose();
  }
  geometry.dispose();
}

test('comparator-style inward glow quads are culled from outside on all six sides', async () => {
  // Six deliberately inward surfaces around one torch. These compact numeric
  // bounds reproduce the geometry pattern used by vanilla comparator models.
  const shell = [
    [[3.5, 1.5, 10.5], [6.5, 4.5, 13.5]], [[3.5, 7.5, 10.5], [6.5, 10.5, 13.5]],
    [[3.5, 4.5, 7.5], [6.5, 7.5, 10.5]], [[3.5, 4.5, 13.5], [6.5, 7.5, 16.5]],
    [[.5, 4.5, 10.5], [3.5, 7.5, 13.5]], [[6.5, 4.5, 10.5], [9.5, 7.5, 13.5]],
  ];
  for (const y of [0, 90, 180, 270]) for (let i = 0; i < shell.length; i++) {
    await assertDirectionalFace({ y, elements: [{ from: shell[i][0], to: shell[i][1], faces: {
      [directions[i]]: { texture: 'lit', uv: [6, 5, 7, 6] },
    } }] }, { Name: 'minecraft:comparator' }, atlas);
  }
});

test('real local vanilla comparator glow faces retain model-defined back-face culling', { skip: !process.env.MINECRAFT_JAR && 'Set MINECRAFT_JAR to verify the installed game model.' }, async () => {
  const { loadAssets } = require('../src/core/assets.cjs');
  const block = { Name: 'minecraft:comparator', Properties: { facing: 'south', mode: 'compare', powered: 'true' } };
  const assets = loadAssets(process.env.MINECRAFT_JAR, [block]);
  assert.equal(assets.blocks[0].fallback, undefined);
  let tested = 0;
  for (const part of assets.blocks[0].parts) for (const element of part.elements) {
    for (const [direction, face] of Object.entries(element.faces)) {
      if (String(face.uv) !== '6,5,7,6') continue;
      const faceAtlas = { ...atlas, regions: { [face.texture]: atlas.regions.lit } };
      await assertDirectionalFace({ ...part, elements: [{ ...element, faces: { [direction]: face } }] }, block, faceAtlas);
      tested++;
    }
  }
  assert.ok(tested >= 12, `expected comparator's 12 inward glow faces; found ${tested}`);
});
