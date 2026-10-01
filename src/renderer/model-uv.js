// UV basis orientations and operation order were verified against the installed
// Minecraft 1.21.11 client's BlockMath, BlockModelRotation.WithUvLock and
// FaceBakery using Mojang's official client mappings. This is an independent
// implementation; no game code or assets are distributed with the viewer.
//
// Mojang maps source-face local XY through the block rotation into the resulting
// face's local XY, then applies that mapping's INVERSE to centered texture UVs.
// Applying the transformation to coordinates (rather than permuting the four
// corners) is essential for cropped, rectangular and mirrored UV rectangles.

const BASIS = {
  south: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  north: { u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
  east: { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
  west: { u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0] },
  up: { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  down: { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const matrices = new Map();

function quadrant(angle = 0) {
  if (!Number.isFinite(angle) || !Number.isInteger(angle / 90)) throw new RangeError('Minecraft model UV rotations must be multiples of 90 degrees.');
  return ((angle / 90) % 4 + 4) % 4;
}

function rotate(vector, x, y) {
  let [a, b, c] = vector;
  // Same order as the viewer's Ry(-part.y) * Rx(-part.x), using exact integer
  // quarter turns to avoid epsilon errors at atlas tile boundaries.
  for (let turn = 0; turn < x; turn++) [b, c] = [c, -b];
  for (let turn = 0; turn < y; turn++) [a, c] = [-c, a];
  return [a, b, c];
}

function inverseFaceMatrix(direction, x, y) {
  const key = `${direction}:${x}:${y}`;
  if (matrices.has(key)) return matrices.get(key);
  const source = BASIS[direction];
  const normal = rotate(source.n, x, y);
  const destination = Object.values(BASIS).find(face => dot(face.n, normal) === 1);
  const u = rotate(source.u, x, y), v = rotate(source.v, x, y);
  // A pure quarter-turn matrix is orthogonal, so its inverse is its transpose.
  const matrix = [dot(destination.u, u), dot(destination.v, u), dot(destination.u, v), dot(destination.v, v)];
  matrices.set(key, matrix);
  return matrix;
}

/** Return four [u,v] pairs in Minecraft's 0..16 texture coordinate space.
 * Their order matches viewer.js corners(): TL, BL, BR, TR (including up/down
 * faces' established ordering). Values can be mirrored or outside 0..16 and
 * are retained; this helper neither clamps UVs nor chooses atlas coordinates.
 *
 * direction: north/south/east/west/up/down before blockstate rotation.
 * uvRect: face.uv, or the result of the existing defaultFaceUV helper.
 * faceRotation: face.rotation (0/90/180/270), applied before UV locking.
 * part: blockstate { x, y, uvlock }; element rotations do not affect UV locking.
 */
export function faceVertexUVs(direction, uvRect = [0, 0, 16, 16], faceRotation = 0, part = {}) {
  if (!BASIS[direction]) throw new RangeError(`Unknown Minecraft face direction: ${direction}`);
  if (!Array.isArray(uvRect) || uvRect.length !== 4 || !uvRect.every(Number.isFinite)) throw new TypeError('Minecraft face UVs need four finite coordinates.');
  const [u0, v0, u1, v1] = uvRect;
  const corners = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
  const shift = quadrant(faceRotation);
  const result = corners.map((_, index) => corners[(index + shift) % 4].slice());
  if (!part.uvlock) return result;
  const [a, b, c, d] = inverseFaceMatrix(direction, quadrant(part.x ?? 0), quadrant(part.y ?? 0));
  return result.map(([u, v]) => [a * (u - 8) + b * (v - 8) + 8, c * (u - 8) + d * (v - 8) + 8]);
}
