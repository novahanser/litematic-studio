import * as THREE from 'three';
import { buildStateGeometry, createAtlas } from './viewer.js';

const prepared = new WeakMap();
const hydration = new WeakMap();
const imageFrom = uri => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = uri; });

async function prepareIcons(assets) {
  const icons = new Map(), images = new Map();
  const descriptors = [...new Set(Object.values(assets.items || {}))];
  const aliases = new Map(descriptors.map(item => [item, []]));
  for (const [name, descriptor] of Object.entries(assets.items || {})) aliases.get(descriptor).push(name);
  const ids = new Set(descriptors.flatMap(item => [...(item.layers || []).map(l => l.texture), ...(item.parts || []).flatMap(p => p.elements.flatMap(e => Object.values(e.faces).map(f => f.texture)))]));
  await Promise.all([...ids].map(async id => { const uri = assets.textures?.[id]; if (uri) images.set(id, await imageFrom(typeof uri === 'string' ? uri : uri.dataURI)); }));
  const drawFrame = (context, id, width, height) => {
    const image = images.get(id); if (!image) return false;
    const meta = assets.textureMeta?.[id] || {}, w = Math.max(1, Math.min(image.width, meta.frameWidth || image.width)), h = Math.max(1, Math.min(image.height, meta.frameHeight || image.height));
    const columns = Math.max(1, Math.floor(image.width / w)), count = columns * Math.max(1, Math.floor(image.height / h)), frame = Math.max(0, Math.min(count - 1, meta.firstFrame || 0));
    context.drawImage(image, frame % columns * w, Math.floor(frame / columns) * h, w, h, 0, 0, width, height); return true;
  };
  let renderer, atlas;
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-.5, .5, .5, -.5, .01, 20);
  camera.position.set(0, 0, 4); camera.lookAt(0, 0, 0);
  const ambient = new THREE.AmbientLight(0xffffff, 1.5), key = new THREE.DirectionalLight(0xffffff, 1.8), fill = new THREE.DirectionalLight(0xffffff, .6);
  key.position.set(-3, 5, 4); fill.position.set(3, 1, -2); scene.add(ambient, key, fill);
  try {
    if (descriptors.some(item => item.kind === 'model')) {
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(1); renderer.setSize(64, 64, false); renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
        atlas = await createAtlas({ ...assets, textures: Object.fromEntries([...ids].filter(id => assets.textures?.[id]).map(id => [id, assets.textures[id]])) }, renderer.capabilities.maxTextureSize);
      } catch { renderer?.dispose(); renderer?.forceContextLoss(); renderer = null; }
    }
    for (const descriptor of descriptors) {
      try {
      let uri = '';
      if (descriptor.kind === 'sprite') {
        const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
        for (const layer of descriptor.layers || []) {
          const tile = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), tc = tile.getContext('2d'); tc.imageSmoothingEnabled = false;
          if (!drawFrame(tc, layer.texture, 64, 64)) continue;
          if (layer.color != null && layer.color !== 0xffffff) {
            // Multiplying an opaque canvas fill then masking changes the RGB
            // of partly transparent texels. Tint their channels directly and
            // preserve the original alpha, just like the model shader.
            const pixels = tc.getImageData(0,0,64,64), tint = new THREE.Color(layer.color), color = new THREE.Color();
            for (let i=0;i<pixels.data.length;i+=4) {
              color.setRGB(pixels.data[i]/255,pixels.data[i+1]/255,pixels.data[i+2]/255,THREE.SRGBColorSpace).multiply(tint).convertLinearToSRGB();
              pixels.data[i]=Math.round(color.r*255);pixels.data[i+1]=Math.round(color.g*255);pixels.data[i+2]=Math.round(color.b*255);
            }
            tc.putImageData(pixels,0,0);
          }
          ctx.drawImage(tile, 0, 0);
        }
        uri = canvas.toDataURL('image/png');
      } else if (descriptor.kind === 'model' && renderer && atlas) {
        const geometry = buildStateGeometry(descriptor, { Name: descriptor.id }, atlas); geometry.translate(-.5, -.5, -.5);
        const transparent = geometry.userData.hasTranslucentTexture && descriptor.renderType !== 'entity-cutout-no-cull';
        const parameters = { map: atlas.texture, vertexColors: true, alphaTest: .1, side: THREE.FrontSide, transparent, depthWrite: !transparent };
        const material = descriptor.guiLight === 'front' ? new THREE.MeshBasicMaterial(parameters) : new THREE.MeshLambertMaterial(parameters);
        const mesh = new THREE.Mesh(geometry, material), display = descriptor.display || {};
        const vector = (value, fallback) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback;
        mesh.rotation.set(...vector(display.rotation, [0, 0, 0]).map(n => n * Math.PI / 180));
        mesh.position.set(...vector(display.translation, [0, 0, 0]).map(n => n / 16)); mesh.scale.set(...vector(display.scale, [1, 1, 1]));
        try { scene.add(mesh); renderer.render(scene, camera); uri = renderer.domElement.toDataURL('image/png'); }
        finally { scene.remove(mesh); geometry.dispose(); material.dispose(); }
      }
      if (uri) for (const key of aliases.get(descriptor)) icons.set(key, uri);
      } catch { /* A bad item cannot prevent other inventory icons from loading. */ }
    }
  } finally { atlas?.texture.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); }
  return icons;
}

/** Installs nearest-filtered local sprites / actual GUI-model renders in slots. */
export async function hydrateInventoryIcons(root, assets, options = {}) {
  if (!root || !assets?.items) return;
  const token = {}; hydration.set(root, token);
  if (!prepared.has(assets)) prepared.set(assets, prepareIcons(assets).catch(() => new Map()));
  const icons = await prepared.get(assets);
  if (hydration.get(root) !== token) return;
  for (const element of root.querySelectorAll('[data-inventory-icon]')) {
    const key = element.dataset.inventoryIcon, uri = icons.get(key); if (!uri) continue;
    const image = document.createElement('img'); image.src = uri; image.alt = ''; image.draggable = false;
    image.className = 'inventory-item-icon'; image.style.cssText = 'width:100%;height:100%;object-fit:contain;image-rendering:pixelated;display:block';
    element.replaceChildren(image); element.dataset.iconLoaded = 'true';
  }
}
