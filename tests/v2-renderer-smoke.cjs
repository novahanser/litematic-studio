const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
// Optional visual regression: use a local schematic containing ice and entities,
// together with its matching installed Minecraft client JAR. No assets are bundled.
const sample = process.env.LITEMATIC_SAMPLE;
const jarPath = process.env.MINECRAFT_JAR;
const checks = [], errors = [];
async function main() {
  if (!sample || !jarPath) {
    console.log('SKIP v2 renderer UI smoke: set LITEMATIC_SAMPLE and MINECRAFT_JAR to local files, then run npm run build and node tests/v2-renderer-smoke.cjs.');
    return;
  }
  assert.ok(fs.statSync(sample).isFile(), 'LITEMATIC_SAMPLE must be a file');
  assert.ok(fs.statSync(jarPath).isFile(), 'MINECRAFT_JAR must be a file');
  assert.ok(fs.existsSync(path.join(root, 'build', 'index.html')), 'Run npm run build before this test');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'profile-render-v2-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ jarPath: path.resolve(jarPath), resourcePackPath: '' }));
  const env = { ...process.env, LITEMATIC_STUDIO_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.VIEWER_EXE || require('electron'), args: process.env.VIEWER_EXE ? [path.resolve(sample)] : [root, path.resolve(sample)], env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.studio?.getState().data && !window.studio.getState().busy, null, { timeout: 120000 });
    console.log(JSON.stringify(await page.evaluate(() => ({ stats: window.studio.viewer.getStats(), blocks: window.studio.getState().data.blocks.length }))));
    const canvas = page.locator('#viewport canvas');
    const rect = await canvas.boundingBox();
    const x = rect.x + rect.width * 0.5, y = rect.y + rect.height * 0.5;
    const info = () => page.evaluate(() => window.studio.viewer.getCameraInfo());
    let before = await info();
    await page.mouse.move(x, y); await page.mouse.down({ button: 'left' }); await page.mouse.move(x + 60, y + 15, { steps: 5 }); await page.mouse.up({ button: 'left' });
    assert.deepEqual((await info()).position, before.position); checks.push('left drag does not rotate');
    await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(x + 60, y + 15, { steps: 5 }); await page.mouse.up({ button: 'middle' }); await page.waitForTimeout(300);
    assert.notDeepEqual((await info()).position, before.position); checks.push('middle drag rotates');
    before = await info();
    await page.keyboard.down('Shift'); await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(x + 50, y + 10, { steps: 5 }); await page.mouse.up({ button: 'middle' }); await page.keyboard.up('Shift'); await page.waitForTimeout(300);
    assert.notDeepEqual((await info()).target, before.target); checks.push('Shift middle drag pans');
    before = await info();
    await page.keyboard.down('Control'); await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(x, y + 50, { steps: 5 }); await page.mouse.up({ button: 'middle' }); await page.keyboard.up('Control'); await page.waitForTimeout(300);
    assert.notEqual((await info()).distance, before.distance); checks.push('Control middle drag dollies');
    await page.keyboard.press('Numpad5'); assert.equal((await info()).projection, 'orthographic');
    assert.equal(await page.locator('#projection-toggle').textContent(), '正交');
    before = await info(); await page.mouse.wheel(0, -120); await page.waitForTimeout(300); assert.ok((await info()).zoom > before.zoom); checks.push('Numpad5 and orthographic wheel zoom');
    await page.locator('#jump-x').focus(); await page.keyboard.press('Numpad5');
    assert.equal((await info()).projection, 'orthographic');
    await page.locator('#navigation-help').click(); await page.keyboard.press('Numpad5');
    assert.equal((await info()).projection, 'orthographic');
    await page.locator('#navigation-dialog button[aria-label="关闭"]').click();
    await canvas.focus(); checks.push('inputs and dialogs suppress view shortcuts');
    await page.keyboard.press('Numpad1'); await page.keyboard.press('Control+Numpad3'); await page.keyboard.press('Home');
    assert.equal((await info()).projection, 'orthographic'); checks.push('Blender axis shortcuts and Home');
    await page.evaluate(() => { const v = window.studio.viewer; v.focus(0); });
    await page.keyboard.press('NumpadDecimal'); assert.equal(await page.evaluate(() => window.studio.viewer.selectedIndex), 0); checks.push('Numpad decimal focus');
    await page.evaluate(() => { const v = window.studio.viewer; v.setProjection('perspective'); v.view('iso'); v.fit(); });
    await page.waitForTimeout(350);
    fs.writeFileSync(path.join(output, 'v2-overview.png'), Buffer.from(await page.evaluate(() => window.studio.viewer.capture().split(',')[1]), 'base64'));
    const performance = await page.evaluate(() => {
      const v = window.studio.viewer, times = [];
      for (let i = 0; i < 5; i++) { v.camera.position.x += 1; const start = performance.now(); v.sortTransparent(); times.push(performance.now() - start); }
      const turnTimes = [], distance = v.camera.position.distanceTo(v.controls.target);
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        v.camera.position.copy(v.controls.target).add(v.controls.target.clone().set(Math.sin(angle) * distance, distance * 0.4, Math.cos(angle) * distance));
        v.camera.lookAt(v.controls.target);
        const start = performance.now(); v.sortTransparent(); turnTimes.push(performance.now() - start);
      }
      v.view('iso');
      const s = window.studio.getState();
      const index = s.data.blocks.map((block, index) => ({ block, index })).filter(({block}) => s.data.palette[block.state].Name === 'minecraft:ice').sort((a, b) => b.block.y - a.block.y)[0].index;
      const target = s.data.blocks[index];
      v.setVisible(s.data.blocks.map((block, index) => ({ block, index })).filter(({block}) => Math.abs(block.x - target.x) <= 6 && Math.abs(block.z - target.z) <= 6 && block.y >= target.y - 4 && block.y <= target.y + 6).map(({index}) => index));
      v.focus(index); v.zoom(0.6);
      return { sortMs: times, quarterTurnSortMs: turnTimes, iceIndex: index, stats: v.getStats() };
    });
    fs.writeFileSync(path.join(output, 'v2-ice-detail.png'), Buffer.from(await page.evaluate(() => window.studio.viewer.capture().split(',')[1]), 'base64'));
    await page.evaluate(() => {
      const v = window.studio.viewer;
      v.setVisible([]); v.setEntityVisible(true);
      v.setEntityFilter({ enabled: true, minY: null, maxY: null, layers: null, indices: [0] });
      v.focusEntity(0);
      // Item-frame content is on local +Z. Inspect its actual front, regardless
      // of the Facing tag, instead of approaching its opaque wooden back.
      const frame = v.entityLayer.objects[0];
      const direction = v.controls.target.clone().set(0.15, 0.1, 1).normalize().applyQuaternion(frame.quaternion);
      v.camera.position.copy(v.controls.target).addScaledVector(direction, 2.2);
      v.controls.update(); v.invalidate();
    });
    const entityTarget = await page.evaluate(() => {
      const v = window.studio.viewer, rect = v.renderer.domElement.getBoundingClientRect();
      v.camera.updateMatrixWorld(true); v.scene.updateMatrixWorld(true);
      const center = v.entityLayer.focusBounds(0).getCenter(v.controls.target.clone()).project(v.camera);
      const x = rect.left + (center.x + 1) * rect.width / 2, y = rect.top + (1 - center.y) * rect.height / 2;
      for (const dx of [0, 3, -3, 8, -8]) for (const dy of [0, 3, -3, 8, -8]) {
        const hit = v.pickTarget({ clientX: x + dx, clientY: y + dy });
        if (hit?.entity) return { x: x + dx, y: y + dy, index: hit.index };
      }
      return null;
    });
    assert.ok(entityTarget, 'entity preview is raycastable');
    await page.mouse.click(entityTarget.x, entityTarget.y);
    assert.equal(await page.evaluate(() => window.studio.viewer.selectedEntityIndex), entityTarget.index);
    fs.writeFileSync(path.join(output, 'v2-entity-detail.png'), Buffer.from(await page.evaluate(() => window.studio.viewer.capture().split(',')[1]), 'base64'));
    checks.push('entity preview, focus and real canvas selection');
    assert.deepEqual(errors, []);
    const report = { checks, performance, errors };
    fs.writeFileSync(path.join(output, 'render-v2-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
