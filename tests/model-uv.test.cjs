const test = require('node:test');
const assert = require('node:assert/strict');
const imports = Promise.all([import('../src/renderer/model-uv.js'), import('three')]);
const directions = ['north', 'south', 'west', 'east', 'up', 'down'];
const angles = [0, 90, 180, 270];

// Golden results obtained by calling the installed 1.21.11 vanilla client's
// BlockModelRotation.withUvLock().inverseFaceTransformation(direction), with
// Quadrant.fromXYAngles(x,y). Each digit is a CCW UV quarter turn; columns are
// x=0/90/180/270, with y=0/90/180/270 inside each group. These are numeric test
// outputs, not game code or assets. The game JAR is not needed to run this suite.
// Official name mapping used for the independent oracle:
// https://piston-data.mojang.com/v1/objects/031a68bebf55d824f66d6573d8c752f0e1bf232a/client.txt
const VANILLA_UV_TURNS = {
  north: '0000210322222301', south: '0000012322220321',
  west: '0000333322221111', east: '0000111122223333',
  up: '0123222203210000', down: '0321000001232222',
};
const expectedTurn = ([u, v], turn) => [[u, v], [16 - v, u], [16 - u, 16 - v], [v, 16 - u]][turn];
const rectangleCorners = ([u0, v0, u1, v1]) => [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];

test('unlocked faces preserve the source rectangle, mirrors, and explicit face rotation', async () => {
  const [{ faceVertexUVs }] = await imports;
  const rect = [13, 2, 3, 15], corners = rectangleCorners(rect);
  for (const direction of directions) for (const rotation of angles) {
    const actual = faceVertexUVs(direction, rect, rotation, { x: 90, y: 270, uvlock: false });
    assert.deepEqual(actual, corners.map((_, index) => corners[(index + rotation / 90) % 4]));
  }
  assert.deepEqual(rect, [13, 2, 3, 15], 'input data must not be changed');
});

test('UV lock rotates a half-width top-face rectangle instead of stretching its old dimensions', async () => {
  const [{ faceVertexUVs }] = await imports;
  assert.deepEqual(faceVertexUVs('up', [0, 0, 8, 16], 0, { y: 90, uvlock: true }), [[16, 0], [0, 0], [0, 8], [16, 8]]);
  assert.deepEqual(faceVertexUVs('up', [2, 3, 9, 14], 0, { y: 90, uvlock: true }), [[13, 2], [2, 2], [2, 9], [13, 9]]);
  assert.deepEqual(faceVertexUVs('up', [9, 14, 2, 3], 0, { y: 90, uvlock: true }), [[2, 9], [13, 9], [13, 2], [2, 2]]);
});

test('all six faces and all x+y model rotations match the vanilla-client oracle', async () => {
  const [{ faceVertexUVs }] = await imports;
  const rectangles = [[0, 0, 16, 16], [1, 3, 7, 14], [15, 13, 2, 1], [13, 2, 3, 15], [2, 15, 13, 3], [-4, 6, 21, 12], [8, 4, 8, 12]];
  let checks = 0;
  for (const direction of directions) for (let xi = 0; xi < 4; xi++) for (let yi = 0; yi < 4; yi++) {
    const turn = Number(VANILLA_UV_TURNS[direction][xi * 4 + yi]);
    for (const rectangle of rectangles) for (const rotation of angles) {
      const source = rectangleCorners(rectangle);
      const expected = source.map((_, vertex) => expectedTurn(source[(vertex + rotation / 90) % 4], turn));
      assert.deepEqual(faceVertexUVs(direction, rectangle, rotation, { x: angles[xi], y: angles[yi], uvlock: true }), expected,
        `${direction} x=${angles[xi]} y=${angles[yi]} faceRotation=${rotation} uv=${rectangle}`);
      checks++;
    }
  }
  assert.equal(checks, 2688);
});

test('locked default UVs agree with rotated world-space face coordinates for a non-cubic element', async () => {
  const [{ faceVertexUVs }, THREE] = await imports;
  const [x0, y0, z0, x1, y1, z1] = [2, 3, 5, 11, 13, 15];
  const corners = {
    north: [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]],
    south: [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]],
    west: [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
    east: [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]],
    up: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    down: [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
  };
  const normals = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
  const project = (direction, [x, y, z]) => ({ north: [16 - x, 16 - y], south: [x, 16 - y], west: [z, 16 - y], east: [16 - z, 16 - y], up: [x, z], down: [x, 16 - z] })[direction];
  for (const direction of directions) for (const x of angles) for (const y of angles) {
    const source = corners[direction].map(point => project(direction, point));
    const rect = [...source[0], ...source[2]];
    const rotation = new THREE.Matrix4().makeRotationY(-y * Math.PI / 180).multiply(new THREE.Matrix4().makeRotationX(-x * Math.PI / 180));
    const normal = new THREE.Vector3(...normals[direction]).transformDirection(rotation);
    const destination = directions.find(face => normal.dot(new THREE.Vector3(...normals[face])) > 0.99999);
    const worldUVs = corners[direction].map(point => project(destination, new THREE.Vector3(...point).subScalar(8).applyMatrix4(rotation).addScalar(8).toArray()));
    const actual = faceVertexUVs(direction, rect, 0, { x, y, uvlock: true });
    for (let vertex = 0; vertex < 4; vertex++) for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(actual[vertex][axis] - worldUVs[vertex][axis]) < 1e-8, `${direction}, x=${x}, y=${y}, vertex=${vertex}`);
  }
});

test('full-turn wrapping, defaults, and input validation are deterministic', async () => {
  const [{ faceVertexUVs }] = await imports;
  assert.deepEqual(faceVertexUVs('south'), [[0, 0], [0, 16], [16, 16], [16, 0]]);
  assert.deepEqual(faceVertexUVs('up', [1, 2, 12, 15], -90, { x: 450, y: -90, uvlock: true }), faceVertexUVs('up', [1, 2, 12, 15], 270, { x: 90, y: 270, uvlock: true }));
  // Unlocked standing signs may legitimately use 22.5-degree geometry rotation.
  assert.doesNotThrow(() => faceVertexUVs('south', [0, 0, 16, 16], 0, { y: 22.5 }));
  assert.throws(() => faceVertexUVs('diagonal'), /direction/);
  assert.throws(() => faceVertexUVs('up', [0, 0, NaN, 16]), /finite/);
  assert.throws(() => faceVertexUVs('up', [0, 0, 16, 16], 45), /90/);
  assert.throws(() => faceVertexUVs('up', [0, 0, 16, 16], 0, { x: 45, uvlock: true }), /90/);
});
