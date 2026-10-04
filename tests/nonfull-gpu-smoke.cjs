'use strict';

// Exhaustive optional GPU visibility check using locally generated vanilla
// registry reports. No game files or screenshots belong in the repository.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { loadAssets } = require('../src/core/assets.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'block-gpu');
const jar = process.env.MINECRAFT_JAR;
const registryFile = process.env.BLOCK_REGISTRY || path.join(root, 'test-results/vanilla-registry/reports/blocks.json');
const manifestFile = process.env.BLOCK_AUDIT_MANIFEST || path.join(root, 'test-results/block-audit/manifest.json');
const report = { passed: false, states: [], errors: [], scope: 'All supplied vanilla registry states; GPU visibility is not a pixel-for-pixel vanilla comparison.' };
let app, profile;
const save = () => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); };

async function main() {
  if (!jar || !fs.existsSync(registryFile)) { console.log('SKIP: set MINECRAFT_JAR and BLOCK_REGISTRY (vanilla reports/blocks.json).'); return; }
  assert.ok(fs.existsSync(manifestFile), 'Run scripts/audit-blocks.cjs first or set BLOCK_AUDIT_MANIFEST to its manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const stateKey = s => s.Name + JSON.stringify(Object.fromEntries(Object.entries(s.Properties || {}).sort(([a], [b]) => a.localeCompare(b))));
  const intentionalEmpty = new Set(manifest.states.filter(s => s.status === 'intentional-empty' && s.emptyReason).map(s => stateKey(s.state)));
  const requiresNBT = new Set(manifest.states.filter(s => s.status === 'unsupported' && s.state.Name === 'minecraft:moving_piston' && s.emptyReason === 'unsupported-entity-without-nbt').map(s => stateKey(s.state)));
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  let states = Object.entries(registry).flatMap(([Name, value]) => value.states.map(s => ({ Name, Properties: s.properties || {}, registryId: s.id, default: !!s.default })));
  if (process.env.BLOCK_GPU_FILTER) states = states.filter(s => new RegExp(process.env.BLOCK_GPU_FILTER).test(s.Name));
  assert.ok(states.length > 0, 'The requested GPU audit scope must contain states');
  report.types = new Set(states.map(s => s.Name)).size; report.expected = states.length;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-gpu-audit-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ jarPath: jar, resourcePackPath: '' }));
  const env = { ...process.env, LITEMATIC_STUDIO_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: process.env.VIEWER_EXE || require('electron'), args: process.env.VIEWER_EXE ? [] : [root], env, timeout: 60000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /WebGL|THREE|shader/i.test(message.text())) report.errors.push(message.text()); });
  await page.waitForFunction(() => window.studio?.viewer);
  await page.evaluate(() => {
    const v = window.studio.viewer;
    v.resizeObserver.disconnect(); v.onStats = null; v.setGrid(false); v.setProjection('orthographic');
    v.controls.enableDamping = false; v.renderer.setPixelRatio(1); v.renderer.setSize(96, 96, false);
    window.__auditSheets = {}; window.__auditRepresentatives = new Set();
  });
  const batchSize = Number(process.env.BLOCK_GPU_BATCH || 160), started = Date.now();
  for (let offset = 0; offset < states.length; offset += batchSize) {
    const batch = states.slice(offset, offset + batchSize);
    const palette = batch.map(({ Name, Properties }) => ({ Name, Properties }));
    const assets = loadAssets(jar, palette);
    const schematic = { palette, blocks: palette.map((_, state) => ({ state, x: state * 64, y: 0, z: 0, region: 'audit', localIndex: state })), entities: [] };
    const outcomes = await page.evaluate(async ({ schematic, assets, descriptors }) => {
      const v = window.studio.viewer;
      await v.setData(schematic, assets); v.setGrid(false); v.setEntityVisible(false);
      v.renderer.setSize(96, 96, false);
      const gl = v.renderer.getContext(), pixels = new Uint8Array(96 * 96 * 4);
      const directions = [[1, .8, 1], [-1, .8, -1], [1, -.8, -1], [-1, -.8, 1]];
      const results = [];
      for (let i = 0; i < schematic.blocks.length; i++) {
        v.setVisible([i]); v.stopInertia();
        const geometry = v.stateGeometries.get(i); geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const center = v.controls.target.clone().set(schematic.blocks[i].x + .5, .5, .5);
        let span = 1;
        if (!box.isEmpty()) { center.copy(box.getCenter(center)).x += schematic.blocks[i].x; span = Math.max(1, box.getSize(v.camera.position.clone()).length()); }
        if (assets.blocks[i]?.waterlogged || assets.blocks[i]?.fluid) span = Math.max(span, 2);
        const radius = span * .5, distance = radius * 3 + 2;
        v.camera.left = -span * .72; v.camera.right = span * .72; v.camera.top = span * .72; v.camera.bottom = -span * .72;
        v.camera.near = .01; v.camera.far = distance + radius * 2 + 1; v.camera.zoom = 1; v.camera.up.set(0, 1, 0); v.camera.updateProjectionMatrix();
        const counts = [], errors = [], snapshot = descriptors[i].default || /(?:_head|_skull|_statue|_banner|chest|bell|conduit|decorated_pot|pitcher_crop|heavy_core)$/.test(descriptors[i].Name) && !window.__auditRepresentatives.has(descriptors[i].Name);
        for (let view = 0; view < directions.length; view++) {
          v.controls.target.copy(center); v.camera.position.copy(center).addScaledVector(center.clone().set(...directions[view]).normalize(), distance);
          v.controls.update(); v.sortTransparent(); v.renderer.render(v.scene, v.camera);
          gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const background = pixels.slice(0, 3); let count = 0;
          for (let p = 0; p < pixels.length; p += 4) if (Math.max(Math.abs(pixels[p] - background[0]), Math.abs(pixels[p + 1] - background[1]), Math.abs(pixels[p + 2] - background[2])) > 8) count++;
          counts.push(count); const error = gl.getError(); if (error) errors.push(error);
          if (view === 0 && snapshot) {
            window.__auditRepresentatives.add(descriptors[i].Name);
            const sheetIndex = Math.floor((window.__auditRepresentatives.size - 1) / 80), slot = (window.__auditRepresentatives.size - 1) % 80;
            const sheet = window.__auditSheets[sheetIndex] ||= Object.assign(document.createElement('canvas'), { width: 1280, height: 1040 });
            const ctx = sheet.getContext('2d'), x = slot % 10 * 128, y = Math.floor(slot / 10) * 130;
            ctx.fillStyle = '#101722'; ctx.fillRect(x, y, 128, 130); ctx.drawImage(v.renderer.domElement, x + 16, y, 96, 96);
            ctx.fillStyle = '#ffffff'; ctx.font = '9px sans-serif';
            const label = descriptors[i].Name.replace('minecraft:', ''); ctx.fillText(label.slice(0, 23), x + 2, y + 109); ctx.fillText(label.slice(23), x + 2, y + 121);
          }
        }
        const triangles = v.getStats().triangles;
        results.push({ registryId: descriptors[i].registryId, state: schematic.palette[i], pixels: counts, triangles, renderMode: assets.blocks[i]?.renderMode, fallback: assets.blocks[i]?.fallback, emptyReason: assets.blocks[i]?.emptyReason, glErrors: errors });
      }
      return results;
    }, { schematic, assets, descriptors: batch });
    report.states.push(...outcomes);
    for (const result of outcomes) {
      result.expectedVisibility = requiresNBT.has(stateKey(result.state)) ? 'not-assessed-missing-moving-block-nbt' : intentionalEmpty.has(stateKey(result.state)) ? 'intentional-empty-or-contained-fluid' : 'visible';
      if (result.glErrors.length) report.errors.push(`GL errors in state ${result.registryId}: ${result.glErrors}`);
      if (result.triangles > 0 && result.pixels.every(n => n === 0)) report.errors.push(`No rendered pixels in state ${result.registryId} ${result.state.Name} ${JSON.stringify(result.state.Properties)}`);
      if (result.triangles === 0 && result.expectedVisibility === 'visible') report.errors.push(`Unexpected empty geometry in state ${result.registryId} ${result.state.Name} ${JSON.stringify(result.state.Properties)}`);
    }
    report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
    save(); console.log(`${report.states.length}/${states.length} states; ${report.errors.length} issues; ${report.elapsedSeconds}s`);
  }
  const sheets = await page.evaluate(() => Object.entries(window.__auditSheets).map(([i, canvas]) => [i, canvas.toDataURL('image/png')]));
  for (const [i, uri] of sheets) fs.writeFileSync(path.join(output, `contact-${i}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  report.rendered = report.states.filter(s => s.triangles > 0).length;
  report.empty = report.states.filter(s => s.triangles === 0).length;
  report.nbtDependentNotAssessed = report.states.filter(s => s.expectedVisibility === 'not-assessed-missing-moving-block-nbt').length;
  report.passed = report.errors.length === 0 && report.states.length === report.expected; save();
  assert.ok(report.passed, report.errors.slice(0, 20).join('\n'));
}
main().catch(e => { report.errors.push(e.stack); save(); console.error(e); process.exitCode = 1; }).finally(async () => {
  if (app) { const child = app.process(); let timeout; await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timeout = setTimeout(() => { if (child?.pid && child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); resolve(); }, 5000); })]); clearTimeout(timeout); }
  if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('litematic-gpu-audit-')) fs.rmSync(profile, { recursive: true, force: true });
});
