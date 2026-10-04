'use strict';

// Run `npm run build` first, then set MINECRAFT_JAR and run this script. An
// optional LITEMATIC_SAMPLE is opened after the self-contained regression case.
// No personal paths, game textures, or user schematics are bundled here.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeNBT } = require('../src/core/document.cjs');
const { parseLitematic } = require('../src/core/litematic.cjs');

const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
const jarPath = process.env.MINECRAFT_JAR, sample = process.env.LITEMATIC_SAMPLE;
const report = { passed: false, checks: [], errors: [] };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let app, profile, page, watchdog, activeStep = 'setup';
const stage = name => { activeStep = name; console.log(name); };
const passed = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS ' + name); };
function writeReport() {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'v4-material-report.json'), JSON.stringify({ ...report, activeStep }, null, 2) + '\n');
}
function killOwnedApp() {
  const child = app?.process();
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  else child.kill('SIGKILL');
}

function createFixture(filename) {
  const width = 19, height = 4, depth = 10;
  const palette = [{ Name: 'minecraft:air', Properties: {} }], blocks = [], byState = new Map();
  const put = (x, y, z, id, Properties = {}) => {
    const state = { Name: 'minecraft:' + id, Properties }, key = JSON.stringify(state);
    if (!byState.has(key)) { byState.set(key, palette.length); palette.push(state); }
    blocks.push({ x, y, z, state: byState.get(key) });
  };
  const chains = [];
  for (const name of ['chain', 'iron_chain']) for (const axis of ['y', 'x', 'z']) {
    const x = 1 + chains.length * 3;
    put(x, 1, 1, name, { axis, waterlogged: 'false' });
    put(x, 1, 3, 'stone');
    put(x, 0, 1, 'polished_deepslate');
    chains.push({ x, y: 1, z: 1, Name: 'minecraft:' + name, axis, backing: [x, 1, 3] });
  }
  // A compact version of the reported comparator/concrete/trapdoor scene.
  for (let x = 1; x <= 4; x++) {
    put(x, 0, 7, 'stone');
    put(x, 1, 7, 'comparator', { facing: 'south', mode: 'compare', powered: 'true' });
    if (x === 1 || x === 4) put(x, 1, 6, 'iron_trapdoor', { facing: 'south', half: 'top', open: 'true', powered: 'true', waterlogged: 'false' });
    else put(x, 1, 6, 'white_concrete');
    put(x, 1, 8, x === 1 || x === 4 ? 'dispenser' : 'shulker_box', x === 1 || x === 4 ? { facing: x === 1 ? 'east' : 'west', triggered: 'false' } : { facing: 'up' });
  }
  const states = new Uint32Array(width * height * depth);
  blocks.forEach(b => { states[b.y * width * depth + b.z * width + b.x] = b.state; });
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length))), words = Array(Math.ceil(states.length * bits / 64)).fill(0n);
  states.forEach((n, i) => {
    const bit = i * bits, word = Math.floor(bit / 64), shift = bit % 64;
    words[word] |= BigInt(n) << BigInt(shift);
    if (shift + bits > 64) words[word + 1] |= BigInt(n) >> BigInt(64 - shift);
  });
  const tag = (type, value) => ({ value, types: { type } }), int = n => tag('int', n), str = s => tag('string', s);
  const compound = children => ({ value: Object.fromEntries(Object.entries(children).map(([k, v]) => [k, v.value])), types: { type: 'compound', children: Object.fromEntries(Object.entries(children).map(([k, v]) => [k, v.types])) } });
  const list = (elementType, items) => ({ value: items.map(v => v.value), types: { type: 'list', elementType, items: items.map(v => v.types) } });
  const vector = (x, y, z) => compound({ x: int(x), y: int(y), z: int(z) });
  const tree = compound({ Version: int(6), MinecraftDataVersion: int(4671), Metadata: compound({ Name: str('Material regression'), TotalBlocks: int(blocks.length) }), Regions: compound({ regression: compound({
    Position: vector(0, 0, 0), Size: vector(width, height, depth),
    BlockStatePalette: list('compound', palette.map(s => compound({ Name: str(s.Name), Properties: compound(Object.fromEntries(Object.entries(s.Properties).map(([k, v]) => [k, str(v)]))) }))),
    BlockStates: tag('long_array', words.map(w => BigInt.asIntN(64, w).toString())), TileEntities: list('compound', []), Entities: list('compound', []),
  }) }) });
  const bytes = writeNBT({ name: 'Materials', ...tree });
  fs.writeFileSync(filename, bytes);
  return { bytes, chains, blocks: blocks.length };
}

async function capture(name) {
  const uri = await page.evaluate(() => window.studio.viewer.capture());
  fs.writeFileSync(path.join(output, name), Buffer.from(uri.split(',')[1], 'base64'));
}

async function main() {
  if (!jarPath) { console.log('SKIP v4 material smoke: set MINECRAFT_JAR to a local Minecraft client JAR; LITEMATIC_SAMPLE is optional. Run npm run build first.'); return; }
  assert.ok(fs.statSync(jarPath).isFile(), 'MINECRAFT_JAR must point to a file');
  if (sample) assert.ok(fs.statSync(sample).isFile(), 'LITEMATIC_SAMPLE must point to a file');
  if (!process.env.VIEWER_EXE) assert.ok(fs.existsSync(path.join(root, 'build/index.html')), 'Run npm run build first');
  fs.mkdirSync(output, { recursive: true });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-v4-material-'));
  const fixturePath = path.join(profile, 'materials.litematic'), fixture = createFixture(fixturePath), originalHash = sha256(fixture.bytes);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ jarPath: path.resolve(jarPath), resourcePackPath: '' }));
  const env = { ...process.env, LITEMATIC_STUDIO_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  watchdog = setTimeout(() => { report.errors.push('Timeout during ' + activeStep); writeReport(); killOwnedApp(); process.exit(1); }, Number(process.env.VIEWER_TEST_TIMEOUT || 240000));
  stage('launch isolated material fixture');
  app = await electron.launch({ executablePath: process.env.VIEWER_EXE || require('electron'), args: process.env.VIEWER_EXE ? [fixturePath] : [root, fixturePath], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.studio?.getState().data && !window.studio.getState().busy, null, { timeout: 120000 });

  stage('verify legacy/current chain models and source IDs');
  const chainModels = await page.evaluate(cases => {
    const { data, assets } = window.studio.getState(), v = window.studio.viewer;
    return { count: data.blocks.length, cases: cases.map(c => {
      const block = data.blocks.find(b => b.x === c.x && b.y === c.y && b.z === c.z), state = data.palette[block.state], asset = assets.blocks[block.state], geometry = v.stateGeometries.get(block.state);
      const faces = (asset.parts || []).flatMap(p => (p.elements || []).flatMap(e => Object.values(e.faces || {})));
      geometry.computeBoundingBox(); const dimensions = geometry.boundingBox.getSize(v.controls.target.clone()).toArray();
      return { Name: state.Name, axis: state.Properties.axis, dimensions, faces: faces.length, missing: faces.some(f => /(?:viewer:missing|__missing__)/.test(f.texture) || !assets.textures[f.texture]) };
    }), warnings: assets.warnings };
  }, fixture.chains);
  assert.equal(chainModels.count, fixture.blocks);
  chainModels.cases.forEach((actual, i) => {
    assert.equal(actual.Name, fixture.chains[i].Name, 'Resource aliases do not rewrite the schematic palette');
    assert.equal(actual.axis, fixture.chains[i].axis);
    assert.equal(actual.missing, false, actual.Name + ' has local textures');
    assert.ok(actual.faces > 0);
    const dimensions = actual.dimensions.slice().sort((a, b) => a - b);
    assert.ok(dimensions[0] < 0.8 && dimensions[1] < 0.8 && dimensions[2] > 0.9, 'Chain uses thin crossed geometry, not a fallback cube');
  });
  passed('old/new chain IDs, all axes, local textures and thin geometry', chainModels);
  await page.evaluate(() => { const v = window.studio.viewer; v.view('iso'); v.fit(); });
  await capture('v4-material-fixture.png');

  stage('raycast actual transparent chain texels onto the backing block');
  const picks = await page.evaluate(() => {
    const { data } = window.studio.getState(), v = window.studio.viewer;
    const chainIndex = data.blocks.findIndex(b => b.x === 1 && b.y === 1 && b.z === 1), backingIndex = data.blocks.findIndex(b => b.x === 1 && b.y === 1 && b.z === 3);
    v.setVisible([chainIndex, backingIndex]); v.setEntityVisible(false); v.setProjection('orthographic'); v.stopInertia();
    v.orthoHeight = 2.2; v.camera.zoom = 1; v.controls.target.set(1.5, 1.5, 1.5); v.camera.position.set(1.5, 1.5, -8.5); v.camera.up.set(0, 1, 0); v.resize(); v.controls.update(); v.capture(); v.scene.updateMatrixWorld(true);
    const rect = v.renderer.domElement.getBoundingClientRect(), canvas = v.atlas.texture.image, pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const hitIndex = hit => hit.object.isInstancedMesh ? hit.object.userData.blockIndices[hit.instanceId] : hit.object.geometry.userData.blockIndices?.[hit.object.geometry.userData.faceOrder?.[Math.floor(hit.faceIndex / 2)]];
    // This independent alpha lookup verifies that the tested ray intersects
    // the model's transparent texels, rather than merely passing beside it.
    const alpha = hit => {
      if (!hit.uv) return 1;
      const x = Math.min(canvas.width - 1, Math.max(0, Math.floor(hit.uv.x * canvas.width)));
      const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((1 - hit.uv.y) * canvas.height)));
      return pixels[(y * canvas.width + x) * 4 + 3] / 255;
    };
    const result = { chainIndex, backingIndex, hole: null, solid: null, testedRays: 0 };
    for (let iy = 0; iy < 96 && (!result.hole || !result.solid); iy++) for (let ix = 0; ix < 48 && (!result.hole || !result.solid); ix++) {
      const point = v.controls.target.clone().set(1.32 + (ix + 0.5) / 48 * 0.36, 1.02 + (iy + 0.5) / 96 * 0.96, 1.5).project(v.camera);
      const event = { clientX: rect.left + (point.x + 1) * rect.width / 2, clientY: rect.top + (1 - point.y) * rect.height / 2 };
      v.pointer.set(point.x, point.y); v.raycaster.setFromCamera(v.pointer, v.camera);
      const raw = v.raycaster.intersectObjects(v.meshes.filter(m => m.visible), false); result.testedRays++;
      if (!raw.length || hitIndex(raw[0]) !== chainIndex) continue;
      const back = raw.find(h => hitIndex(h) === backingIndex); if (!back) continue;
      const chainHits = raw.filter(h => hitIndex(h) === chainIndex && h.distance < back.distance);
      const transparent = chainHits.every(h => alpha(h) < (h.object.material.alphaTest || 0.08));
      if (transparent && !result.hole || !transparent && !result.solid) {
        const picked = v.pickTarget(event, false), entry = { x: event.clientX, y: event.clientY, rawIndex: hitIndex(raw[0]), pickedIndex: picked?.index ?? null, chainAlphas: chainHits.map(alpha) };
        if (transparent) result.hole = entry; else result.solid = entry;
      }
    }
    return result;
  });
  assert.ok(picks.hole, 'The selected game chain texture has a ray through an actual transparent texel');
  assert.ok(picks.solid, 'The chain also has an opaque texel that remains selectable');
  assert.equal(picks.hole.rawIndex, picks.chainIndex);
  assert.equal(picks.hole.pickedIndex, picks.backingIndex, 'Transparent chain holes reveal the backing block to picking');
  assert.equal(picks.solid.pickedIndex, picks.chainIndex, 'Opaque chain texels select the chain');
  await page.mouse.click(picks.hole.x, picks.hole.y);
  assert.equal(await page.evaluate(() => window.studio.getState().selected), picks.backingIndex, 'Real canvas click selects the backing block through the hole');
  passed('alpha-aware geometry hit and real pointer selection', picks);
  await capture('v4-chain-transparent-picking.png');

  stage('real wheel zoom in perspective and orthographic modes');
  await page.locator('#reset-filters').click();
  for (const projection of ['perspective', 'orthographic']) {
    await page.evaluate(mode => { const v = window.studio.viewer; v.setProjection(mode); v.view('iso'); v.fit(); v.capture(); }, projection);
    const anchor = await page.evaluate(() => {
      const v = window.studio.viewer, s = window.studio.getState(), r = v.renderer.domElement.getBoundingClientRect();
      for (const b of s.data.blocks.filter(b => ['minecraft:stone', 'minecraft:white_concrete'].includes(s.data.palette[b.state].Name))) {
        const q = v.controls.target.clone().set(b.x + 0.5, b.y + 0.5, b.z + 0.5).project(v.camera), x = r.left + (q.x + 1) * r.width / 2, y = r.top + (1 - q.y) * r.height / 2;
        const hit = v.pickTarget({ clientX: x, clientY: y });
        if (hit?.point && Math.hypot(q.x, q.y) > 0.12 && Math.abs(q.x) < 0.85 && Math.abs(q.y) < 0.85) return { x, y, point: hit.point.toArray(), distance: v.camera.position.distanceTo(hit.point), zoom: v.camera.zoom };
      }
      return null;
    });
    assert.ok(anchor, 'An off-center opaque surface is available for wheel zoom');
    await page.mouse.move(anchor.x, anchor.y); await page.mouse.wheel(0, -240); await page.waitForTimeout(220);
    const after = await page.evaluate(a => { const v = window.studio.viewer, r = v.renderer.domElement.getBoundingClientRect(), p = v.controls.target.clone().fromArray(a.point); v.camera.updateMatrixWorld(true); const q = p.clone().project(v.camera); return { x: r.left + (q.x + 1) * r.width / 2, y: r.top + (1 - q.y) * r.height / 2, distance: v.camera.position.distanceTo(p), zoom: v.camera.zoom }; }, anchor);
    const drift = Math.hypot(after.x - anchor.x, after.y - anchor.y);
    assert.ok(drift < 0.8, projection + ' keeps the zoom anchor within one pixel');
    if (projection === 'perspective') assert.ok(after.distance < anchor.distance); else assert.ok(after.zoom > anchor.zoom);
    passed(projection + ' real wheel zoom remains anchored', { driftPixels: drift });
  }

  stage('UI resource reload preserves orthographic framing and selection');
  await page.locator('[data-tab="inspect"]').click();
  for (const [axis, value] of Object.entries({ x: 1, y: 1, z: 1 })) await page.locator('#jump-' + axis).fill(String(value));
  await page.locator('#jump-button').click();
  await page.evaluate(() => {
    const v = window.studio.viewer; v.setProjection('orthographic'); v.stopInertia(); v.view('iso');
    // Fit() during reload must not silently replace this deliberately nondefault span.
    v.orthoHeight = 11.75; v.camera.zoom = 2.35; v.resize(); v.controls.update(); v.capture();
    window.__v4PreviousData = window.studio.getState().data;
  });
  const viewSnapshot = () => {
    const v = window.studio.viewer, s = window.studio.getState(), r = v.renderer.domElement.getBoundingClientRect(), b = s.data.blocks[s.selected];
    v.camera.updateMatrixWorld(true);
    const points = [[1.5, 1.5, 1.5], [4.5, 1.5, 1.5], [2.5, 1.5, 6.5]].map(values => { const p = v.controls.target.clone().fromArray(values).project(v.camera); return [r.left + (p.x + 1) * r.width / 2, r.top + (1 - p.y) * r.height / 2]; });
    return { info: v.getCameraInfo(), orthoHeight: v.orthoHeight, points, selected: b ? { region: b.region, localIndex: b.localIndex, Name: s.data.palette[b.state].Name, xyz: [b.x, b.y, b.z] } : null, viewerSelected: v.selectedIndex, badgeVisible: !document.getElementById('selection-badge').hidden };
  };
  const before = await page.evaluate(viewSnapshot);
  assert.ok(before.selected && before.badgeVisible);
  await page.locator('#resources-button').click(); await page.locator('#reload-resources').click();
  await page.waitForFunction(() => { const s = window.studio.getState(); return !s.busy && s.data !== window.__v4PreviousData; }, null, { timeout: 120000 });
  const after = await page.evaluate(viewSnapshot);
  assert.equal(after.info.projection, 'orthographic');
  for (const key of ['position', 'target']) after.info[key].forEach((value, i) => assert.ok(Math.abs(value - before.info[key][i]) < 1e-6, key + ' survives reload'));
  assert.ok(Math.abs(after.info.zoom - before.info.zoom) < 1e-8);
  assert.ok(Math.abs(after.orthoHeight - before.orthoHeight) < 1e-8, 'Orthographic span survives reload');
  after.points.forEach((p, i) => assert.ok(Math.hypot(p[0] - before.points[i][0], p[1] - before.points[i][1]) < 0.1, 'Projected coordinates remain stable'));
  assert.deepEqual(after.selected, before.selected, 'The selected block survives resource reload');
  assert.ok(after.badgeVisible && after.viewerSelected != null);
  assert.equal(sha256(fs.readFileSync(fixturePath)), originalHash, 'Viewing and resource aliases leave the source file unchanged');
  passed('resource dialog reload retains orthographic span, screen coordinates and selected block', { before, after });
  await capture('v4-resource-reload.png');

  if (sample) {
    stage('open optional real sample without modifying it');
    const bytes = fs.readFileSync(sample), original = sha256(bytes), baseline = parseLitematic(bytes), filename = path.resolve(sample);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename);
    await page.locator('#open-button').click();
    await page.waitForFunction(file => { const s = window.studio.getState(); return !s.busy && s.filePath === file; }, filename, { timeout: 120000 });
    const actual = await page.evaluate(() => { const s = window.studio.getState(); return { blocks: s.data.blocks.length, entities: s.data.entities.length, textures: Object.keys(s.assets.textures).length }; });
    assert.equal(actual.blocks, baseline.blocks.length); assert.equal(actual.entities, baseline.entities.length); assert.ok(actual.textures > 0);
    assert.equal(sha256(fs.readFileSync(sample)), original);
    await page.evaluate(() => { const v = window.studio.viewer; v.setProjection('perspective'); v.view('iso'); v.fit(); });
    await capture('v4-optional-sample.png'); passed('optional user sample loads without changing its bytes', actual);
  }
  assert.deepEqual(report.errors, []); report.passed = true; activeStep = 'complete'; writeReport();
}

if (require.main === module) main().catch(async error => {
  report.errors.push(`${activeStep}: ${error.stack || error.message}`);
  try { if (page) await capture('v4-failure.png'); } catch {}
  writeReport(); console.error(error); process.exitCode = 1;
}).finally(async () => {
  clearTimeout(watchdog);
  if (app) {
    let timer;
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(() => { killOwnedApp(); resolve(); }, 5000); })]);
    clearTimeout(timer);
  }
  // Remove only the exact fresh temporary profile created by this script.
  if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('litematic-v4-material-')) fs.rmSync(profile, { recursive: true, force: true });
});

module.exports = { createFixture };
