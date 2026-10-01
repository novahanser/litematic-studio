import * as THREE from 'three';

const DEG = Math.PI / 180;
const WOOL_COLORS = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const vector = (value, fallback = [0, 0, 0]) => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(n => Number.isFinite(n)) ? value.slice(0, 3) : fallback;

// Vanilla cuboid texture unfolding, with local +Z as the front of the entity.
// Reference UV sizes remain vanilla-sized when high resolution packs are used.
export function applyCuboidUV(geometry, u, v, w, h, d, textureWidth = 64, textureHeight = 64) {
  const rectangles = [
    [u + d + w, v + d, d, h], [u, v + d, d, h],
    [u + d, v, w, d], [u + d + w, v, w, d],
    [u + d, v + d, w, h], [u + d * 2 + w, v + d, w, h],
  ];
  const uv = geometry.attributes.uv;
  rectangles.forEach(([x, y, width, height], face) => {
    const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]];
    corners.forEach(([px, py], index) => uv.setXY(face * 4 + index, px / textureWidth, 1 - py / textureHeight));
  });
  uv.needsUpdate = true;
  return geometry;
}

export function frameOrientation(nbt = {}, rotation = []) {
  const facing = number(nbt.Facing ?? nbt.facing, -1);
  const euler = new THREE.Euler();
  if (facing === 0) euler.x = Math.PI / 2;
  else if (facing === 1) euler.x = -Math.PI / 2;
  else if (facing === 2) euler.y = Math.PI;
  else if (facing === 3) euler.y = 0;
  else if (facing === 4) euler.y = -Math.PI / 2;
  else if (facing === 5) euler.y = Math.PI / 2;
  else { euler.y = -number(rotation?.[0]) * DEG; euler.x = number(rotation?.[1]) * DEG; }
  return euler;
}

function box(parent, size, position, material, uv = null, uvSize = [64, 64]) {
  const geometry = new THREE.BoxGeometry(...size);
  if (uv) applyCuboidUV(geometry, uv[0], uv[1], size[0] * 16, size[1] * 16, size[2] * 16, ...uvSize);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function labelSprite(label, color = '#f9c977') {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = 'rgba(13,22,34,0.9)'; ctx.fillRect(0, 0, 512, 80);
  ctx.font = '28px "Microsoft YaHei", sans-serif'; ctx.fillStyle = color;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(label).slice(0, 65), 256, 40, 494);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, transparent: true }));
  sprite.scale.set(2.4, 0.375, 1); sprite.position.y = 1.45;
  sprite.userData.ownedTexture = texture;
  return sprite;
}

function addItem(parent, item, layer, scale = 0.5) {
  if (!item) return null;
  const group = new THREE.Group(); parent.add(group);
  if (item.isBlock) {
    const material = layer.material(item.texture, 0xffffff, { alphaTest: 0.04 });
    const mesh = box(group, [scale * 0.7, scale * 0.7, scale * 0.7], [0, 0, 0], material);
    mesh.rotation.set(Math.PI / 7, Math.PI / 4, 0);
  } else if (item.texture) {
    const material = layer.material(item.texture, 0xffffff, { side: THREE.DoubleSide, alphaTest: 0.15 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale), material);
    group.add(mesh);
  } else {
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(scale * 0.34), layer.material(null, 0xf3b958));
    group.add(mesh);
  }
  group.userData.itemId = item.id;
  return group;
}

function buildFrame(root, entity, descriptor, layer) {
  const nbt = entity.nbt || {};
  root.rotation.copy(frameOrientation(nbt, entity.rotation || nbt.Rotation));
  if (!(nbt.Invisible || nbt.invisible)) {
    const backing = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0xb7a16e);
    const border = layer.material(descriptor.borderTexture, descriptor.borderTexture ? 0xffffff : 0x825d36);
    box(root, [0.7, 0.7, 0.042], [0, 0, 0], backing);
    box(root, [0.75, 0.0625, 0.0625], [0, 0.34375, 0.013], border);
    box(root, [0.75, 0.0625, 0.0625], [0, -0.34375, 0.013], border);
    box(root, [0.0625, 0.625, 0.0625], [-0.34375, 0, 0.013], border);
    box(root, [0.0625, 0.625, 0.0625], [0.34375, 0, 0.013], border);
  }
  const item = addItem(root, descriptor.item, layer, 0.5);
  if (item) {
    // Framed block items are shallow reliefs. Keep the entire rotated cuboid in
    // front of the backing; a full-depth item pokes through its rear as a wedge.
    if (descriptor.item.isBlock) item.scale.z = 0.18;
    item.position.z = descriptor.item.isBlock ? 0.08 : 0.05;
    item.rotation.z = -number(nbt.ItemRotation ?? nbt.item_rotation) * Math.PI / 4;
  }
}

function buildArmorStand(root, entity, descriptor, layer) {
  const nbt = entity.nbt || {}, pose = nbt.Pose || nbt.pose || {};
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0xa7824b);
  if (!(nbt.NoBasePlate || nbt.no_base_plate)) box(root, [0.75, 0.0625, 0.75], [0, 0.03125, 0], layer.material(descriptor.baseTexture, 0xc2c0b8));
  function limb(size, origin, offset, uv, poseValue) {
    const pivot = new THREE.Group(); pivot.position.set(...origin); root.add(pivot);
    const values = vector(poseValue); pivot.rotation.set(values[0] * DEG, values[1] * DEG, values[2] * DEG);
    box(pivot, size, offset, material, uv); return pivot;
  }
  limb([0.125, 0.6875, 0.125], [-0.125, 0.8125, 0], [0, -0.34375, 0], [40, 16], pose.LeftLeg);
  limb([0.125, 0.6875, 0.125], [0.125, 0.8125, 0], [0, -0.34375, 0], [0, 16], pose.RightLeg);
  box(root, [0.5, 0.125, 0.1875], [0, 0.8125, 0], material, [0, 48]);
  limb([0.125, 0.6875, 0.125], [0, 0.8125, 0], [0, 0.34375, 0], [16, 0], pose.Body);
  box(root, [0.75, 0.1875, 0.1875], [0, 1.5, 0], material, [0, 26]);
  limb([0.125, 0.4375, 0.125], [0, 1.5, 0], [0, 0.21875, 0], [0, 0], pose.Head);
  if (nbt.ShowArms || nbt.show_arms) {
    limb([0.125, 0.75, 0.125], [-0.375, 1.5, 0], [0, -0.3125, 0], [24, 0], pose.LeftArm);
    limb([0.125, 0.75, 0.125], [0.375, 1.5, 0], [0, -0.3125, 0], [32, 16], pose.RightArm);
  }
  if (nbt.Small || nbt.small) root.scale.setScalar(0.5);
}

function buildMinecart(root, entity, descriptor, layer) {
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0x929ba4);
  box(root, [1.25, 0.125, 0.875], [0, 0.0625, 0], material, [0, 0], [64, 32]);
  box(root, [1.25, 0.5, 0.125], [0, 0.375, -0.4375], material, [0, 10], [64, 32]);
  box(root, [1.25, 0.5, 0.125], [0, 0.375, 0.4375], material, [0, 10], [64, 32]);
  box(root, [0.125, 0.5, 0.75], [-0.5625, 0.375, 0], material, [0, 10], [64, 32]);
  box(root, [0.125, 0.5, 0.75], [0.5625, 0.375, 0], material, [0, 10], [64, 32]);
  if (descriptor.cargoTexture) {
    const cargo = box(root, [0.7, 0.7, 0.7], [0, 0.475, 0], layer.material(descriptor.cargoTexture, 0xffffff));
    cargo.userData.approximation = '矿车载荷静态近似';
  }
}

function buildBoat(root, entity, descriptor, layer) {
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0x9b703d);
  const raft = entity.id?.endsWith('_raft');
  box(root, [1.45, 0.125, 0.95], [0, 0.0625, 0], material);
  if (!raft) {
    box(root, [1.45, 0.38, 0.125], [0, 0.28, -0.49], material);
    box(root, [1.45, 0.38, 0.125], [0, 0.28, 0.49], material);
    box(root, [0.125, 0.38, 0.85], [-0.7, 0.28, 0], material);
    box(root, [0.125, 0.38, 0.85], [0.7, 0.28, 0], material);
  }
  for (const sign of [-1, 1]) {
    const oar = new THREE.Group(); oar.position.set(0, 0.3, sign * 0.5); oar.rotation.x = sign * 0.15; oar.rotation.y = sign * -0.35; root.add(oar);
    box(oar, [0.065, 0.065, 0.75], [0, 0, sign * 0.28], material);
    box(oar, [0.2, 0.06, 0.28], [0, 0, sign * 0.7], material);
  }
  if (entity.id?.includes('chest')) {
    box(root, [0.65, 0.55, 0.65], [-0.3, 0.39, 0], material);
    box(root, [0.08, 0.16, 0.035], [-0.3, 0.5, 0.34], layer.material(null, 0xc9c9bb));
  }
}

function buildHumanoid(root, entity, descriptor, layer) {
  const name = entity.id?.split(':')[1], nbt = entity.nbt || {};
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0x9aaf84);
  const skeleton = ['skeleton', 'wither_skeleton', 'stray'].includes(name), villager = name === 'villager';
  const uvSize = skeleton ? [64, 32] : [64, 64];
  const legWidth = skeleton ? 0.125 : 0.25;
  box(root, [legWidth, 0.75, legWidth], [-0.125, 0.375, 0], material, [0, 16], uvSize);
  box(root, [legWidth, 0.75, legWidth], [0.125, 0.375, 0], material, [0, 16], uvSize);
  box(root, [0.5, villager ? 0.875 : 0.75, 0.25], [0, 1.125, 0], material, [16, 16], uvSize);
  const head = new THREE.Group(); head.position.y = 1.5; head.rotation.x = number(entity.rotation?.[1] ?? nbt.Rotation?.[1]) * DEG; root.add(head);
  box(head, [0.5, villager ? 0.625 : 0.5, 0.5], [0, 0.25, 0], material, [0, 0], uvSize);
  if (villager) {
    box(head, [0.125, 0.25, 0.125], [0, 0.1, 0.3], material, [24, 0]);
    box(root, [0.75, 0.25, 0.25], [0, 1.25, 0.25], material, [40, 16]);
  } else for (const sign of [-1, 1]) {
    const arm = new THREE.Group(); arm.position.set(sign * 0.375, 1.43, 0); root.add(arm);
    if (!skeleton) arm.rotation.x = -Math.PI / 2;
    box(arm, [legWidth, 0.75, legWidth], [0, -0.3125, 0], material, [40, 16], uvSize);
  }
  if (name === 'wither_skeleton') root.scale.setScalar(1.2);
  if (nbt.IsBaby || number(nbt.Age) < 0 || nbt.is_baby) root.scale.multiplyScalar(0.5);
}

function buildCreeper(root, descriptor, layer) {
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0x699951);
  for (const x of [-0.125, 0.125]) for (const z of [-0.25, 0.25]) box(root, [0.25, 0.375, 0.25], [x, 0.1875, z], material, [0, 16], [64, 32]);
  box(root, [0.5, 0.75, 0.25], [0, 0.75, 0], material, [16, 16], [64, 32]);
  box(root, [0.5, 0.5, 0.5], [0, 1.375, 0], material, [0, 0], [64, 32]);
}

function buildAnimal(root, entity, descriptor, layer) {
  const name = entity.id?.split(':')[1], nbt = entity.nbt || {}, cow = name === 'cow', sheep = name === 'sheep';
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : name === 'pig' ? 0xe59fab : 0xb9aca0);
  const uvSize = sheep ? [64, 32] : [64, 64];
  const legHeight = cow ? 0.75 : 0.375;
  for (const x of [-0.23, 0.23]) for (const z of [-0.35, 0.35]) box(root, [0.25, legHeight, 0.25], [x, legHeight / 2, z], material, [0, 16], uvSize);
  const torso = box(root, [0.625, 1, 0.625], [0, legHeight + 0.3, 0], material, [18, 4], uvSize); torso.rotation.x = Math.PI / 2;
  box(root, [0.5, sheep ? 0.375 : 0.5, sheep ? 0.375 : 0.5], [0, legHeight + 0.45, 0.55], material, [0, 0], uvSize);
  if (name === 'pig') box(root, [0.25, 0.1875, 0.0625], [0, legHeight + 0.35, 0.82], material, [16, 16]);
  if (cow) for (const x of [-0.26, 0.26]) box(root, [0.0625, 0.1875, 0.0625], [x, legHeight + 0.76, 0.55], layer.material(null, 0xd5c4a6));
  if (sheep && descriptor.woolTexture) {
    const wool = layer.material(descriptor.woolTexture, WOOL_COLORS[Math.max(0, Math.min(15, number(nbt.Color ?? nbt.color)))], { alphaTest: 0.08 });
    const body = box(root, [0.7, 1.08, 0.73], [0, legHeight + 0.3, 0], wool, [18, 4], [64, 32]); body.rotation.x = Math.PI / 2;
  }
  if (number(nbt.Age) < 0 || nbt.IsBaby || nbt.is_baby) root.scale.setScalar(0.5);
}

function buildChicken(root, entity, descriptor, layer) {
  const material = layer.material(descriptor.texture, descriptor.texture ? 0xffffff : 0xebe7db);
  box(root, [0.375, 0.5, 0.375], [0, 0.4375, 0], material, [0, 9], [64, 32]);
  box(root, [0.25, 0.375, 0.1875], [0, 0.8125, 0.23], material, [0, 0], [64, 32]);
  box(root, [0.25, 0.125, 0.125], [0, 0.75, 0.385], material, [14, 0], [64, 32]);
  box(root, [0.125, 0.125, 0.125], [0, 0.625, 0.355], material, [14, 4], [64, 32]);
  for (const sign of [-1, 1]) {
    box(root, [0.0625, 0.375, 0.375], [sign * 0.21875, 0.48, 0], material, [24, 13], [64, 32]);
    box(root, [0.0625, 0.2, 0.0625], [sign * 0.1, 0.1, 0], layer.material(null, 0xd7ac37));
    box(root, [0.125, 0.035, 0.2], [sign * 0.1, 0.0175, 0.055], layer.material(null, 0xd7ac37));
  }
  if (number(entity.nbt?.Age) < 0 || entity.nbt?.IsBaby) root.scale.setScalar(0.5);
}

function displayTransform(group, value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length === 16 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 4096)) group.applyMatrix4(new THREE.Matrix4().fromArray(value));
    return;
  }
  group.position.set(...vector(value.translation));
  const scale = vector(value.scale, [1, 1, 1]).map(n => Math.max(-128, Math.min(128, n))); group.scale.set(...scale);
  const quat = input => Array.isArray(input) && input.length === 4 && input.every(Number.isFinite) ? new THREE.Quaternion(...input).normalize() : new THREE.Quaternion();
  const left = quat(value.left_rotation), right = quat(value.right_rotation);
  group.matrix.compose(group.position, left, group.scale).multiply(new THREE.Matrix4().makeRotationFromQuaternion(right));
  group.matrixAutoUpdate = false;
}

function buildUnknown(root, entity, descriptor, layer) {
  const boxGeometry = new THREE.BoxGeometry(0.75, 1.1, 0.75).translate(0, 0.55, 0);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeometry), new THREE.LineBasicMaterial({ color: 0xf2bc65 }));
  boxGeometry.dispose(); root.add(edges);
  // A small visible solid provides reliable clicking without making the entire
  // volume opaque; the label explicitly identifies unsupported models.
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.18), layer.material(null, 0xf2bc65)); marker.position.y = 0.55; root.add(marker);
  const label = labelSprite(`${descriptor.label || entity.id} · 近似边界`); if (label) root.add(label);
  root.userData.placeholder = true;
}

/** Static entity previews. Coordinates match parseLitematic().entities[].position.
 * `ready` resolves after local PNG textures have decoded. No external URL is read.
 * Invisible/invalid entities keep their original array indices for NBT selection.
 */
export class EntityPreviewLayer {
  constructor(entities = [], assets = {}, options = {}) {
    this.group = new THREE.Group(); this.group.name = 'Litematic entity previews';
    this.entities = entities; this.assets = assets; this.options = options;
    this.textures = new Map(); this.materials = new Map(); this.promises = [];
    this.disposed = false; this.filter = { enabled: true };
    this.objects = entities.map((entity, index) => {
      if (!entity?.position || !['x', 'y', 'z'].every(axis => Number.isFinite(entity.position[axis]))) return null;
      const root = new THREE.Group(), descriptor = assets.entities?.[index] || { kind: 'unknown', label: entity.id };
      root.position.set(entity.position.x, entity.position.y, entity.position.z);
      root.rotation.y = -number(entity.rotation?.[0] ?? entity.nbt?.Rotation?.[0]) * DEG;
      root.name = `${descriptor.label || entity.id} #${index + 1}`;
      root.userData = { entityIndex: index, entity, descriptor };
      const kind = descriptor.kind;
      if (kind === 'item_frame') buildFrame(root, entity, descriptor, this);
      else if (kind === 'armor_stand') buildArmorStand(root, entity, descriptor, this);
      else if (kind === 'minecart') buildMinecart(root, entity, descriptor, this);
      else if (kind === 'boat') buildBoat(root, entity, descriptor, this);
      else if (kind === 'humanoid') buildHumanoid(root, entity, descriptor, this);
      else if (kind === 'creeper') buildCreeper(root, descriptor, this);
      else if (kind === 'quadruped') buildAnimal(root, entity, descriptor, this);
      else if (kind === 'chicken') buildChicken(root, entity, descriptor, this);
      else if (kind === 'item' || kind === 'item_display' || kind === 'block_display') {
        const content = new THREE.Group(); root.add(content);
        const item = kind === 'block_display' && descriptor.item ? box(content, [1, 1, 1], [0.5, 0.5, 0.5], this.material(descriptor.item.texture, 0xffffff)) : addItem(content, descriptor.item, this, kind === 'item' ? 0.4 : 1);
        if (!item) buildUnknown(content, entity, descriptor, this);
        if (kind === 'item') content.position.y = 0.2;
        else displayTransform(content, entity.nbt?.transformation);
      } else buildUnknown(root, entity, descriptor, this);
      root.traverse(object => { object.userData.entityIndex = index; });
      this.group.add(root);
      return root;
    });
    this.group.updateMatrixWorld(true);
    this.ready = Promise.all(this.promises).then(() => { if (!this.disposed) this.options.onChange?.(); return this; });
  }

  texture(id) {
    if (!id || !this.assets.textures?.[id]) return null;
    if (this.textures.has(id)) return this.textures.get(id);
    const data = this.assets.textures[id];
    if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) return null;
    const loader = this.options.textureLoader || new THREE.TextureLoader();
    let texture;
    const ready = new Promise(resolve => {
      texture = loader.load(data, () => resolve(), undefined, () => resolve());
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    this.textures.set(id, texture); this.promises.push(ready);
    return texture;
  }

  material(id, color = 0xffffff, options = {}) {
    const key = `${id || ''}/${color}/${JSON.stringify(options)}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const material = new THREE.MeshLambertMaterial({ map: this.texture(id), color, alphaTest: 0.08, side: THREE.FrontSide, ...options });
    this.materials.set(key, material);
    return material;
  }

  setVisible(value) {
    if (typeof value === 'boolean') this.setFilter({ enabled: value });
    else this.setFilter({ indices: value == null ? null : value });
  }

  setFilter(patch = {}) {
    Object.assign(this.filter, patch);
    const filter = this.filter;
    const allowed = filter.indices == null ? null : new Set(filter.indices);
    const layers = filter.layers == null ? null : new Set(filter.layers);
    this.group.visible = filter.enabled !== false;
    this.objects.forEach((object, index) => {
      if (!object) return;
      const y = Math.floor(this.entities[index].position.y);
      object.visible = (!allowed || allowed.has(index)) && (!layers || layers.has(y)) && (filter.minY == null || y >= filter.minY) && (filter.maxY == null || y <= filter.maxY);
    });
    this.options.onChange?.();
  }

  getVisibleIndices() {
    if (!this.group.visible) return [];
    return this.objects.flatMap((object, index) => object?.visible ? [index] : []);
  }

  pick(raycaster) {
    if (this.disposed || !this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(this.objects.filter(object => object?.visible), true);
    for (const hit of hits) {
      let object = hit.object, visible = true;
      while (object) { if (!object.visible) { visible = false; break; } object = object.parent; }
      if (!visible) continue;
      const index = hit.object.userData.entityIndex;
      if (Number.isInteger(index)) return { index, entity: this.entities[index], object: hit.object, distance: hit.distance, point: hit.point };
    }
    return null;
  }

  focusBounds(index) {
    const object = this.objects[index];
    if (!object) return null;
    this.group.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(object);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set(), materials = new Set(this.materials.values());
    this.group.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach(material => materials.add(material));
      else if (object.material) materials.add(object.material);
      object.userData.ownedTexture?.dispose();
    });
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.group.removeFromParent(); this.group.clear();
    this.objects = []; this.materials.clear(); this.textures.clear();
  }
}
