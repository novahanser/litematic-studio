import * as THREE from 'three';

const EPSILON = 1e-10;
const finiteVector = value => value && ['x', 'y', 'z'].every(axis => Number.isFinite(value[axis]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// A restored camera can begin outside new limits. Never reverse the requested
// direction or snap it to the opposite limit; let it return gradually.
const limitStep = (current, requested, min, max) => requested > current
  ? Math.min(requested, Math.max(current, max)) : Math.max(requested, Math.min(current, min));

/** Blender uses a 1.2x wheel step. Normalize the common 120-pixel notch while
 * retaining fractional trackpad input and OrbitControls' line/page/pinch units.
 * A factor greater than one zooms in. Equal total deltas give equal zooms,
 * regardless of how the browser coalesces the input into wheel events. */
export function wheelZoomFactor(event, speed = 1, controlPressed = false) {
  if (!Number.isFinite(event?.deltaY) || !Number.isFinite(speed) || speed <= 0) return 1;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  const pinch = event.ctrlKey && !controlPressed ? 10 : 1;
  const exponent = -event.deltaY * unit * pinch * speed * Math.log(1.2) / 120;
  return Math.exp(clamp(exponent, -50, 50));
}

export function cursorNDC(event, rect) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0 || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return null;
  return new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
}

/** The actual visible surface takes priority. Empty space uses a view-facing
 * plane through the orbit target; this stays finite in top and horizon views. */
export function resolveCursorAnchor(camera, target, pointer, hitPoint = null) {
  if (!camera || !finiteVector(target) || !Number.isFinite(pointer?.x) || !Number.isFinite(pointer?.y)) return null;
  if (!camera.isPerspectiveCamera && !camera.isOrthographicCamera) return null;
  camera.updateMatrixWorld(true);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const minDepth = Math.max(1e-5, camera.near * 1.01);
  const maxDepth = Number.isFinite(camera.far) ? camera.far * 0.99 : Infinity;
  if (finiteVector(hitPoint)) {
    const point = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
    const depth = point.clone().sub(camera.position).dot(forward);
    if (depth >= minDepth && depth <= maxDepth) return { point, source: 'surface' };
  }
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  let depth = target.clone().sub(camera.position).dot(forward);
  if (!Number.isFinite(depth) || depth < minDepth) depth = Math.max(1, camera.position.distanceTo(target));
  depth = clamp(depth, minDepth, maxDepth);
  const center = camera.position.clone().addScaledVector(forward, depth);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, center);
  const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  return finiteVector(point) ? { point, source: 'target-plane' } : null;
}

/** Auto Depth changes only the view-center depth, never the camera pose. This
 * also makes the next empty-space zoom use the last surface's view plane, rather
 * than jumping to an unrelated distant orbit center. The target stays on the
 * view axis so OrbitControls will not turn the camera toward the cursor. */
export function setOrbitDepthFromAnchor(camera, target, anchor, limits = {}) {
  if (!camera || !finiteVector(target) || !finiteVector(anchor)) return false;
  camera.updateMatrixWorld(true);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const depth = anchor.clone().sub(camera.position).dot(forward);
  if (!Number.isFinite(depth) || depth <= 0) return false;
  const minDistance = Math.max(1e-6, limits.minDistance ?? 0.2);
  const maxDistance = Math.max(minDistance, limits.maxDistance ?? 50000);
  const next = camera.position.clone().addScaledVector(forward, clamp(depth, minDistance, maxDistance));
  if (next.distanceToSquared(target) < EPSILON * EPSILON) return false;
  target.copy(next);
  return true;
}

/** Zoom about a world-space anchor without changing its screen position.
 * Perspective scales BOTH camera and target about the anchor. Orthographic
 * shifts both by the exact before/after unprojection difference, including
 * asymmetric frusta and view offsets. The camera must have no transformed parent.
 */
export function zoomAtAnchor(camera, target, anchor, factor, limits = {}) {
  const unchanged = { changed: false, appliedScale: 1 };
  if (!finiteVector(target) || !finiteVector(anchor) || !Number.isFinite(factor) || factor <= 0 || factor === 1) return unchanged;
  if (!camera?.isPerspectiveCamera && !camera?.isOrthographicCamera) return unchanged;
  camera.updateMatrixWorld(true);
  if (camera.isOrthographicCamera) {
    const oldZoom = camera.zoom;
    if (!Number.isFinite(oldZoom) || oldZoom <= 0) return unchanged;
    const minZoom = Math.max(1e-8, limits.minZoom ?? 0.0001);
    const maxZoom = Math.max(minZoom, limits.maxZoom ?? 100000);
    const zoom = limitStep(oldZoom, oldZoom * factor, minZoom, maxZoom);
    if (zoom === oldZoom) return unchanged;
    const projected = anchor.clone().project(camera);
    camera.zoom = zoom; camera.updateProjectionMatrix();
    const after = projected.unproject(camera);
    const translation = anchor.clone().sub(after);
    camera.position.add(translation); target.add(translation);
    camera.updateMatrixWorld(true);
    return { changed: true, appliedScale: oldZoom / zoom };
  }
  const distance = camera.position.distanceTo(target);
  if (!Number.isFinite(distance) || distance < EPSILON) return unchanged;
  const minDistance = Math.max(1e-6, limits.minDistance ?? 0.2);
  const maxDistance = Math.max(minDistance, limits.maxDistance ?? 50000);
  let scale = limitStep(distance, distance / factor, minDistance, maxDistance) / distance;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const depth = anchor.clone().sub(camera.position).dot(forward);
  if (!Number.isFinite(depth) || depth <= 0) return unchanged;
  // Never step through a hit surface or clip it with the camera's near plane.
  const clearance = Math.max(1e-5, camera.near * 1.05, limits.minAnchorDistance ?? 0);
  if (scale < 1) scale = Math.max(scale, Math.min(1, clearance / depth));
  if (scale > 1 && Number.isFinite(camera.far)) scale = Math.min(scale, Math.max(1, camera.far * 0.99 / depth));
  if (Math.abs(scale - 1) < EPSILON) return unchanged;
  camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
  target.sub(anchor).multiplyScalar(scale).add(anchor);
  camera.updateMatrixWorld(true);
  return { changed: true, appliedScale: scale };
}

/** Connect only the wheel; Blender MMB rotate/pan/dolly remains OrbitControls'.
 * Integration:
 *   attachCursorZoom({ element: canvas, getCamera: () => this.camera,
 *     controls: this.controls, pick: event => this.pickTarget(event),
 *     beforeZoom: () => this.stopInertia(), invalidate: () => this.invalidate() })
 * Call dispose() before disposing OrbitControls. Keep controls.zoomToCursor=false:
 * Three's built-in option also changes Ctrl+MMB and cannot use surface depth.
 */
export function attachCursorZoom({ element, getCamera, controls, pick, beforeZoom, invalidate, isEnabled }) {
  if (!element?.addEventListener || typeof getCamera !== 'function' || !controls) throw new TypeError('Cursor zoom needs an element, getCamera and OrbitControls.');
  const owner = element.ownerDocument || element;
  const pointers = new Set();
  let disposed = false, controlPressed = false;
  const pointerDown = event => pointers.add(event.pointerId ?? 0);
  const pointerUp = event => pointers.delete(event.pointerId ?? 0);
  const keyDown = event => { if (event.key === 'Control') controlPressed = true; };
  const keyUp = event => { if (event.key === 'Control') controlPressed = false; };
  const blur = () => { pointers.clear(); controlPressed = false; };
  const wheel = event => {
    if (disposed || controls.enabled === false || controls.enableZoom === false || pointers.size || event.buttons || isEnabled?.() === false) return null;
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],dialog') || owner.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"]')) return null;
    const pointer = cursorNDC(event, element.getBoundingClientRect());
    const factor = wheelZoomFactor(event, controls.zoomSpeed ?? 1, controlPressed);
    const camera = getCamera();
    if (!pointer || !camera || factor === 1) return null;
    // Capture phase prevents OrbitControls from applying a second, centered zoom.
    event.preventDefault?.(); event.stopImmediatePropagation?.();
    const position = camera.position.clone(), target = controls.target.clone(), quaternion = camera.quaternion.clone(), zoom = camera.zoom;
    const damping = controls.enableDamping, autoRotate = controls.autoRotate;
    controls.enableDamping = false; controls.autoRotate = false;
    try {
      // Clear residual orbit/pan inertia, then restore the visible pose. Merely
      // flushing damping before picking would make the cursor anchor jump first.
      if (beforeZoom) beforeZoom(); else controls.update();
      camera.position.copy(position); camera.quaternion.copy(quaternion); camera.zoom = zoom;
      controls.target.copy(target); camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      // OrbitControls clamps the camera itself in update(). If a restored pose
      // is outside its distance limits, repair the center depth first instead,
      // so the next update cannot move the camera opposite the wheel direction.
      const distance = camera.position.distanceTo(controls.target);
      if (distance < controls.minDistance || distance > controls.maxDistance) {
        setOrbitDepthFromAnchor(camera, controls.target, controls.target, controls);
      }
      const hit = pick?.(event);
      const anchor = resolveCursorAnchor(camera, controls.target, pointer, hit?.point || (hit?.isVector3 ? hit : null));
      if (!anchor) return null;
      if (anchor.source === 'surface') setOrbitDepthFromAnchor(camera, controls.target, anchor.point, controls);
      const result = { ...zoomAtAnchor(camera, controls.target, anchor.point, factor, controls), anchor: anchor.point, source: anchor.source, factor };
      controls.update();
      if (result.changed) invalidate?.(result);
      return result;
    } finally {
      controls.enableDamping = damping; controls.autoRotate = autoRotate;
    }
  };
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  element.addEventListener('pointerdown', pointerDown, true);
  element.addEventListener('pointercancel', pointerUp, true);
  element.addEventListener('lostpointercapture', pointerUp, true);
  owner.addEventListener('pointerup', pointerUp, true);
  owner.addEventListener('keydown', keyDown, true);
  owner.addEventListener('keyup', keyUp, true);
  owner.defaultView?.addEventListener('blur', blur);
  return {
    handleWheel: wheel,
    dispose() {
      if (disposed) return;
      disposed = true; blur();
      element.removeEventListener('wheel', wheel, true);
      element.removeEventListener('pointerdown', pointerDown, true);
      element.removeEventListener('pointercancel', pointerUp, true);
      element.removeEventListener('lostpointercapture', pointerUp, true);
      owner.removeEventListener('pointerup', pointerUp, true);
      owner.removeEventListener('keydown', keyDown, true);
      owner.removeEventListener('keyup', keyUp, true);
      owner.defaultView?.removeEventListener('blur', blur);
    },
  };
}
