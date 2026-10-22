const test = require('node:test');
const assert = require('node:assert/strict');

const imports = Promise.all([import('../src/renderer/cursor-zoom.js'), import('three'), import('three/addons/controls/OrbitControls.js')]);
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const sameScreen = (point, before, camera) => { const after = point.clone().project(camera); close(after.x, before.x); close(after.y, before.y); };

function fixture(THREE, orthographic = false) {
  const camera = orthographic ? new THREE.OrthographicCamera(-7, 9, 6, -4, 0.05, 10000) : new THREE.PerspectiveCamera(42, 1.6, 0.05, 10000);
  const target = new THREE.Vector3(3, 1, -2);
  camera.position.set(17, 9, 20); camera.lookAt(target); camera.updateMatrixWorld(true);
  return { camera, target };
}

test('wheel deltas use Blender-sized steps and normalize continuous line/page/pinch modes', async () => {
  const [{ wheelZoomFactor }] = await imports;
  const input = wheelZoomFactor({ deltaY: -120 });
  close(input, 1.2); close(input * wheelZoomFactor({ deltaY: 120 }), 1);
  close(wheelZoomFactor({ deltaY: -2, deltaMode: 1 }), wheelZoomFactor({ deltaY: -32 }));
  close(wheelZoomFactor({ deltaY: 2, deltaMode: 2 }), wheelZoomFactor({ deltaY: 200 }));
  close(wheelZoomFactor({ deltaY: -4, ctrlKey: true }), wheelZoomFactor({ deltaY: -40 }));
  close(wheelZoomFactor({ deltaY: -4, ctrlKey: true }, 1, true), wheelZoomFactor({ deltaY: -4 }));
  assert.equal(wheelZoomFactor({ deltaY: NaN }), 1);
  assert.equal(wheelZoomFactor({ deltaY: -Infinity }), 1);
  assert.ok(Number.isFinite(wheelZoomFactor({ deltaY: -1e100 })));
  assert.ok(wheelZoomFactor({ deltaY: 1e100 }) > 0);
  close(wheelZoomFactor({ deltaY: -2400 }), wheelZoomFactor({ deltaY: -1200 }) ** 2);
  close(wheelZoomFactor({ deltaY: -120 }), wheelZoomFactor({ deltaY: -1.5 }) ** 80);
});

test('cursor coordinates use canvas position and CSS dimensions rather than drawing-buffer pixels', async () => {
  const [{ cursorNDC }] = await imports;
  const pointer = cursorNDC({ clientX: 300, clientY: 180 }, { left: 100, top: 80, width: 400, height: 200 });
  close(pointer.x, 0); close(pointer.y, 0);
  assert.equal(cursorNDC({ clientX: 0, clientY: 0 }, { left: 0, top: 0, width: 0, height: 2 }), null);
});

test('surface raycast wins over the much farther orbit-target plane', async () => {
  const [{ resolveCursorAnchor }, THREE] = await imports;
  const { camera, target } = fixture(THREE);
  const pointer = new THREE.Vector2(0.65, -0.3), raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.at(2, new THREE.Vector3());
  const anchor = resolveCursorAnchor(camera, target, pointer, hit);
  assert.equal(anchor.source, 'surface'); close(anchor.point.distanceTo(hit), 0);
  const fallback = resolveCursorAnchor(camera, target, pointer);
  assert.equal(fallback.source, 'target-plane'); assert.ok(fallback.point.distanceTo(camera.position) > 20);
  sameScreen(fallback.point, { x: pointer.x, y: pointer.y }, camera);
  const behind = camera.position.clone().sub(camera.getWorldDirection(new THREE.Vector3()));
  assert.equal(resolveCursorAnchor(camera, target, pointer, behind).source, 'target-plane');
});

test('auto depth changes only the orbit-center depth and carries it into empty space', async () => {
  const [{ setOrbitDepthFromAnchor, resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  for (const orthographic of [false, true]) {
    const { camera, target } = fixture(THREE, orthographic);
    const forward = camera.getWorldDirection(new THREE.Vector3()), position = camera.position.clone(), orientation = camera.quaternion.clone();
    const pointer = new THREE.Vector2(.7, -.4), raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const surface = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(forward, position.clone().addScaledVector(forward, 2)), new THREE.Vector3());
    assert.ok(camera.position.distanceTo(target) > 20);
    assert.equal(setOrbitDepthFromAnchor(camera, target, surface), true);
    close(camera.position.distanceTo(target), 2); close(camera.position.distanceTo(position), 0);
    assert.deepEqual(camera.quaternion.toArray(), orientation.toArray()); sameScreen(surface, pointer, camera);
    zoomAtAnchor(camera, target, surface, 1.2);
    const empty = resolveCursorAnchor(camera, target, pointer);
    close(empty.point.distanceTo(surface), 0);
    const movedPointer = new THREE.Vector2(-.75, .6), moved = resolveCursorAnchor(camera, target, movedPointer);
    sameScreen(moved.point, movedPointer, camera);
    close(moved.point.clone().sub(camera.position).dot(forward), surface.clone().sub(camera.position).dot(forward));
    assert.equal(setOrbitDepthFromAnchor(camera, target, position.clone().addScaledVector(forward, -100)), false);
  }
});

test('perspective zoom keeps a near surface under an off-centre cursor without stepping through it', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  const { camera, target } = fixture(THREE);
  const pointer = new THREE.Vector2(-0.7, 0.5), raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.ray.at(1.1, new THREE.Vector3());
  const anchor = resolveCursorAnchor(camera, target, pointer, hit).point;
  const before = anchor.clone().project(camera), orientation = camera.quaternion.clone();
  const start = camera.position.distanceTo(anchor);
  assert.equal(zoomAtAnchor(camera, target, anchor, 1.2).changed, true);
  close(camera.position.distanceTo(anchor), start / 1.2); sameScreen(anchor, before, camera);
  for (let i = 0; i < 100; i++) zoomAtAnchor(camera, target, anchor, 2);
  assert.ok(anchor.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) >= camera.near * 1.049);
  assert.ok(camera.position.distanceTo(target) >= 0.2 - 1e-8);
  sameScreen(anchor, before, camera); assert.deepEqual(camera.quaternion.toArray(), orientation.toArray());
});

test('reciprocal perspective zooms retain anchor, target and camera at ordinary distances', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  const { camera, target } = fixture(THREE);
  const anchor = resolveCursorAnchor(camera, target, new THREE.Vector2(0.6, 0.4)).point;
  const position = camera.position.clone(), originalTarget = target.clone(), before = anchor.clone().project(camera);
  for (let i = 0; i < 100; i++) { zoomAtAnchor(camera, target, anchor, 1.25); zoomAtAnchor(camera, target, anchor, 0.8); }
  close(camera.position.distanceTo(position), 0); close(target.distanceTo(originalTarget), 0); sameScreen(anchor, before, camera);
});

test('orthographic cursor zoom works with asymmetric frusta, view offsets, and zoom clamps', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  const { camera, target } = fixture(THREE, true);
  camera.setViewOffset(1600, 900, 100, 50, 1200, 700);
  camera.updateProjectionMatrix();
  const anchor = resolveCursorAnchor(camera, target, new THREE.Vector2(-0.8, 0.65)).point;
  const before = anchor.clone().project(camera), distance = camera.position.distanceTo(target);
  const limits = { minZoom: 0.25, maxZoom: 8 };
  zoomAtAnchor(camera, target, anchor, 2, limits); assert.equal(camera.zoom, 2); sameScreen(anchor, before, camera);
  zoomAtAnchor(camera, target, anchor, 100, limits); assert.equal(camera.zoom, 8); sameScreen(anchor, before, camera);
  zoomAtAnchor(camera, target, anchor, 0.0001, limits); assert.equal(camera.zoom, 0.25); sameScreen(anchor, before, camera);
  close(camera.position.distanceTo(target), distance);
  assert.equal(zoomAtAnchor(camera, target, anchor, 0.5, limits).changed, false);
});

test('blank-space fallback remains finite in near-horizon and straight-top views', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  for (const orthographic of [false, true]) for (const position of [[0, 0.00001, 20], [0, 20, 0.00001]]) {
    const { camera, target } = fixture(THREE, orthographic);
    target.set(0, 0, 0); camera.position.set(...position); camera.lookAt(target); camera.updateMatrixWorld(true);
    const pointer = new THREE.Vector2(0.9, -0.85), anchor = resolveCursorAnchor(camera, target, pointer);
    assert.equal(anchor.source, 'target-plane');
    zoomAtAnchor(camera, target, anchor.point, 1.6);
    sameScreen(anchor.point, pointer, camera);
    assert.ok([...camera.position.toArray(), ...target.toArray()].every(Number.isFinite));
  }
});

test('distance clamps do not shift the perspective anchor and invalid factors are no-ops', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  const { camera, target } = fixture(THREE);
  const anchor = resolveCursorAnchor(camera, target, new THREE.Vector2(0.75, -0.25)).point, before = anchor.clone().project(camera);
  const limits = { minDistance: 2, maxDistance: 40 };
  zoomAtAnchor(camera, target, anchor, 0.001, limits); close(camera.position.distanceTo(target), 40); sameScreen(anchor, before, camera);
  zoomAtAnchor(camera, target, anchor, 10000, limits); close(camera.position.distanceTo(target), 2); sameScreen(anchor, before, camera);
  for (const factor of [0, -1, NaN, Infinity]) assert.equal(zoomAtAnchor(camera, target, anchor, factor, limits).changed, false);
});

test('limits never reverse zoom direction when a restored camera starts outside them', async () => {
  const [{ resolveCursorAnchor, zoomAtAnchor }, THREE] = await imports;
  for (const start of [1, 80]) {
    const { camera, target } = fixture(THREE);
    camera.position.sub(target).setLength(start).add(target); camera.updateMatrixWorld(true);
    const anchor = resolveCursorAnchor(camera, target, new THREE.Vector2(.5, .2)).point;
    const blocked = start < 2 ? 1.1 : 1 / 1.1, towardRange = 1 / blocked;
    assert.equal(zoomAtAnchor(camera, target, anchor, blocked, { minDistance: 2, maxDistance: 40 }).changed, false);
    zoomAtAnchor(camera, target, anchor, towardRange, { minDistance: 2, maxDistance: 40 });
    close(camera.position.distanceTo(target), start / towardRange);
  }
  for (const start of [.1, 16]) {
    const { camera, target } = fixture(THREE, true);
    camera.zoom = start; camera.updateProjectionMatrix();
    const anchor = resolveCursorAnchor(camera, target, new THREE.Vector2(.5, .2)).point;
    const blocked = start < .25 ? 1 / 1.1 : 1.1, towardRange = 1 / blocked;
    assert.equal(zoomAtAnchor(camera, target, anchor, blocked, { minZoom: .25, maxZoom: 8 }).changed, false);
    zoomAtAnchor(camera, target, anchor, towardRange, { minZoom: .25, maxZoom: 8 });
    close(camera.zoom, start * towardRange);
  }
});

class FakeElement {
  constructor() { this.listeners = new Map(); this.ownerDocument = this; this.modal = false; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  getBoundingClientRect() { return { left: 20, top: 30, width: 800, height: 600 }; }
  querySelector() { return this.modal ? {} : null; }
  emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
}

test('wheel adapter cancels residual damping without an anchor jump, preserves MMB config, and follows camera replacement', async () => {
  const [{ attachCursorZoom, resolveCursorAnchor, cursorNDC }, THREE, { OrbitControls }] = await imports;
  const { camera, target } = fixture(THREE);
  const controls = new OrbitControls(camera);
  controls.target.copy(target); controls.enableDamping = true;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null };
  controls.rotateLeft(0.3); // Leave a real nonzero OrbitControls damping residual.
  const element = new FakeElement(), event = { clientX: 620, clientY: 200, deltaY: -120, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  const anchor = resolveCursorAnchor(camera, controls.target, cursorNDC(event, element.getBoundingClientRect())).point;
  const before = anchor.clone().project(camera);
  let current = camera, changes = 0;
  const attachment = attachCursorZoom({ element, controls, getCamera: () => current, pick: () => ({ point: anchor }), invalidate: () => changes++ });
  const result = attachment.handleWheel(event);
  assert.equal(result.source, 'surface'); assert.ok(event.prevented && event.stopped); assert.equal(changes, 1);
  sameScreen(anchor, before, camera); controls.update(); sameScreen(anchor, before, camera);
  assert.equal(controls.enableDamping, true); assert.equal(controls.mouseButtons.MIDDLE, THREE.MOUSE.ROTATE);
  current = fixture(THREE, true).camera; controls.object = current;
  const oldZoom = current.zoom; attachment.handleWheel(event); assert.ok(current.zoom > oldZoom);
  element.emit('pointerdown', { pointerId: 7 }); assert.equal(attachment.handleWheel(event), null);
  element.emit('lostpointercapture', { pointerId: 7 }); assert.ok(attachment.handleWheel(event));
  element.modal = true; assert.equal(attachment.handleWheel(event), null);
  element.modal = false; controls.enableZoom = false; assert.equal(attachment.handleWheel(event), null);
  controls.enableZoom = true; attachment.dispose(); attachment.dispose(); assert.equal(attachment.handleWheel(event), null);
  assert.ok([...element.listeners.values()].every(listeners => listeners.size === 0));
});

test('real OrbitControls keeps a near-surface depth through blank pixels without accumulated drift', async () => {
  const [{ attachCursorZoom, cursorNDC }, THREE, { OrbitControls }] = await imports;
  for (const orthographic of [false, true]) {
    const { camera, target } = fixture(THREE, orthographic), controls = new OrbitControls(camera), element = new FakeElement();
    controls.target.copy(target); controls.update(); controls.enableDamping = true;
    controls.minDistance = .2; controls.maxDistance = 50000; controls.minZoom = .0001; controls.maxZoom = 100000;
    const event = { clientX: 620, clientY: 200, deltaY: -120 }, pointer = cursorNDC(event, element.getBoundingClientRect());
    const forward = camera.getWorldDirection(new THREE.Vector3()), raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, camera);
    const surface = raycaster.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(forward, camera.position.clone().addScaledVector(forward, 2)), new THREE.Vector3());
    let hit = surface;
    const attachment = attachCursorZoom({ element, controls, getCamera: () => camera, pick: () => hit && ({ point: hit }) });
    attachment.handleWheel(event); controls.update(); sameScreen(surface, pointer, camera);
    close(camera.position.distanceTo(controls.target), orthographic ? 2 : 2 / 1.2);
    const originalPosition = camera.position.clone(), originalTarget = controls.target.clone(), zoom = camera.zoom;
    hit = null; // An alpha hole or adjacent empty pixel must not restore the old far target.
    for (let i = 0; i < 200; i++) {
      const out = attachment.handleWheel({ ...event, deltaY: 1.5 });
      close(out.anchor.distanceTo(surface), 0); sameScreen(surface, pointer, camera);
      const back = attachment.handleWheel({ ...event, deltaY: -1.5 });
      close(back.anchor.distanceTo(surface), 0); sameScreen(surface, pointer, camera);
      controls.update();
    }
    close(camera.position.distanceTo(originalPosition), 0); close(controls.target.distanceTo(originalTarget), 0); close(camera.zoom, zoom);
    attachment.dispose();
  }
});

test('coalesced and fractional wheel gestures produce the same camera and target in both projections', async () => {
  const [{ attachCursorZoom }, THREE, { OrbitControls }] = await imports;
  for (const orthographic of [false, true]) {
    const run = deltas => {
      const { camera, target } = fixture(THREE, orthographic), controls = new OrbitControls(camera), element = new FakeElement();
      controls.target.copy(target); controls.update();
      const attachment = attachCursorZoom({ element, controls, getCamera: () => camera });
      for (const deltaY of deltas) attachment.handleWheel({ clientX: 620, clientY: 200, deltaY });
      attachment.dispose(); return { position: camera.position, target: controls.target, zoom: camera.zoom };
    };
    const whole = run([-240]), fractional = run(Array(160).fill(-1.5));
    close(whole.position.distanceTo(fractional.position), 0); close(whole.target.distanceTo(fractional.target), 0); close(whole.zoom, fractional.zoom);
  }
});

test('repeated real wheel input at minimum and maximum limits stays still and reverses immediately', async () => {
  const [{ attachCursorZoom, cursorNDC, resolveCursorAnchor }, THREE, { OrbitControls }] = await imports;
  for (const orthographic of [false, true]) {
    const { camera, target } = fixture(THREE, orthographic), controls = new OrbitControls(camera), element = new FakeElement();
    controls.target.copy(target); controls.minDistance = 2; controls.maxDistance = 40; controls.minZoom = .25; controls.maxZoom = 8; controls.update();
    const event = { clientX: 620, clientY: 200 }, pointer = cursorNDC(event, element.getBoundingClientRect());
    const attachment = attachCursorZoom({ element, controls, getCamera: () => camera });
    for (const direction of [-1, 1]) {
      attachment.handleWheel({ ...event, deltaY: 20000 * direction });
      const position = camera.position.clone(), center = controls.target.clone(), zoom = camera.zoom;
      const anchor = resolveCursorAnchor(camera, controls.target, pointer).point;
      for (let i = 0; i < 40; i++) { attachment.handleWheel({ ...event, deltaY: 120 * direction }); controls.update(); }
      close(camera.position.distanceTo(position), 0); close(controls.target.distanceTo(center), 0); close(camera.zoom, zoom); sameScreen(anchor, pointer, camera);
      const back = attachment.handleWheel({ ...event, deltaY: -1.5 * direction });
      assert.ok(back.changed); sameScreen(anchor, pointer, camera);
    }
    attachment.dispose();
  }
});
