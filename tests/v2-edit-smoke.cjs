'use strict';

// Run after `npm run build`, with LITEMATIC_SAMPLE and MINECRAFT_JAR pointing to
// your own files. No game assets or user schematics are bundled with this test.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseNBT, parseLitematic } = require('../src/core/litematic.cjs');
const { writeNBT, stateKey } = require('../src/core/document.cjs');

const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
const sample = process.env.LITEMATIC_SAMPLE, jarPath = process.env.MINECRAFT_JAR;
const report = { startedAt: new Date().toISOString(), passed: false, checks: [], errors: [] };
const started = Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableId = block => `${block.region}\0${block.localIndex}`;
let app, profile, watchdog, activeStep = 'setup';
const stage = name => { activeStep = name; console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`); };
const passed = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS ' + name); };
function writeReport() {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'v2-edit-report.json'), JSON.stringify({ ...report, activeStep, elapsedMs: Date.now() - started }, null, 2) + '\n');
}
function killOwnedApp() {
  const processHandle = app?.process(), pid = processHandle?.pid;
  if (!pid || processHandle.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
  else processHandle.kill('SIGKILL');
}

function createFixture(filename) {
  const tag = (type, value) => ({ value, types: { type } });
  const int = value => tag('int', value), str = value => tag('string', value);
  const compound = children => ({ value: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.value])), types: { type: 'compound', children: Object.fromEntries(Object.entries(children).map(([key, child]) => [key, child.types])) } });
  const list = (type, items) => ({ value: items.map(item => item.value), types: { type: 'list', elementType: type, items: items.map(item => item.types) } });
  const vector = (x, y, z) => compound({ x: int(x), y: int(y), z: int(z) });
  const state = (id, properties = {}) => compound({ Name: str(id), Properties: compound(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, str(value)]))) });
  const chest = x => compound({ id: str('minecraft:chest'), x: int(x), y: int(0), z: int(0), CustomName: str(`Container ${x}`),
    Items: list('compound', [compound({ id: str('minecraft:diamond'), Slot: tag('byte', 0), Count: tag('byte', 32) })]) });
  const tree = compound({ Version: int(6), MinecraftDataVersion: int(3700), Metadata: compound({ Name: str('UI edit fixture'), Author: str('Automated test'), TotalBlocks: int(4), TimeModified: tag('long', '123') }),
    UnknownTag: tag('long_array', ['-9223372036854775808', '9223372036854775807']),
    Regions: compound({ fixture: compound({ Position: vector(0, 0, 0), Size: vector(4, 1, 1),
      BlockStatePalette: list('compound', [state('minecraft:chest', { facing: 'north', type: 'single', waterlogged: 'false' }), state('minecraft:oak_stairs', { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' }), state('minecraft:stone')]),
      BlockStates: tag('long_array', ['144']), // [chest, chest, stairs, stone]
      TileEntities: list('compound', [chest(0), chest(1)]),
      Entities: list('compound', [compound({ id: str('minecraft:item_frame'), Pos: list('double', [1.5, 0.5, 0.03125].map(n => tag('double', n))), Rotation: list('float', [tag('float', 0), tag('float', 0)]), Item: compound({ id: str('minecraft:stone'), Count: tag('byte', 1) }) })]),
      PendingBlockTicks: list('compound', [compound({ Block: str('minecraft:stone'), x: int(3), y: int(0), z: int(0), Time: int(8) })]),
    }) }),
  });
  const buffer = writeNBT({ name: 'UI Fixture', ...tree }, 'gzip');
  fs.writeFileSync(filename, buffer); return buffer;
}

async function waitLoaded(page, timeout = 120000) {
  await page.waitForFunction(() => window.studio?.getState().data && !window.studio.getState().busy, null, { timeout });
}
async function dataAction(page, locator) {
  await page.evaluate(() => { window.__v2PreviousData = window.studio.getState().data; });
  await locator.click();
  await page.waitForFunction(() => {
    const state = window.studio.getState(); return !state.busy && state.data !== window.__v2PreviousData;
  }, null, { timeout: 120000 });
}
async function saveThroughUI(page, destination) {
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = () => new Promise(resolve => { globalThis.__finishTestSave = () => resolve({ canceled: false, filePath: file }); }); }, destination);
  await page.locator('#save-document').click();
  assert.equal(await page.evaluate(() => window.studio.getState().busy), true);
  for (const id of ['save-document', 'replace-button', 'undo-button', 'redo-button', 'open-button']) assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' stays disabled during save');
  await app.evaluate(() => { globalThis.__finishTestSave(); delete globalThis.__finishTestSave; });
  await page.waitForFunction(file => { const state = window.studio.getState(); return !state.busy && !state.document.dirty && state.filePath === file; }, destination, { timeout: 15000 });
  assert.ok(fs.existsSync(destination));
  return parseLitematic(fs.readFileSync(destination));
}
async function openReplacement(page, source, target, scope = 'visible') {
  await page.locator('#replace-button').click();
  await page.locator('#replace-dialog').waitFor({ state: 'visible' });
  await page.locator('#replace-source').selectOption(source);
  await page.locator('#replace-scope').selectOption(scope);
  await page.locator('#replace-target').fill(target);
  await page.waitForFunction(() => !document.getElementById('apply-replace').disabled);
}

function verifyScopedResult(before, after, layer) {
  const afterBlocks = new Map(after.blocks.map(block => [stableId(block), block]));
  assert.equal(after.blocks.length, before.blocks.length);
  let changed = 0;
  for (const block of before.blocks) {
    const next = afterBlocks.get(stableId(block)); assert.ok(next, 'Every original position is retained');
    const previousState = before.palette[block.state], nextState = after.palette[next.state];
    if (previousState.Name === 'minecraft:quartz_block' && block.y === layer) { assert.equal(nextState.Name, 'minecraft:stone'); changed++; }
    else assert.equal(stateKey(nextState), stateKey(previousState), 'Nonselected block state remains unchanged');
    assert.deepEqual([next.x, next.y, next.z], [block.x, block.y, block.z]);
    assert.deepEqual(next.nbt, block.nbt); assert.deepEqual(next.nbtTypes, block.nbtTypes);
  }
  assert.deepEqual(after.entities, before.entities);
  return changed;
}

async function main() {
  if (!sample || !jarPath) {
    console.log('SKIP v2 edit UI smoke: set LITEMATIC_SAMPLE and MINECRAFT_JAR to local files, then run npm run build and node tests/v2-edit-smoke.cjs.');
    return;
  }
  assert.ok(fs.statSync(sample).isFile(), 'LITEMATIC_SAMPLE must be a file');
  assert.ok(fs.statSync(jarPath).isFile(), 'MINECRAFT_JAR must be a file');
  assert.ok(fs.existsSync(path.join(root, 'build', 'index.html')), 'Run npm run build before this test');
  fs.mkdirSync(output, { recursive: true });
  const originalBytes = fs.readFileSync(sample), originalHash = sha256(originalBytes), baseline = parseLitematic(originalBytes);
  const quartzByLayer = new Map();
  for (const block of baseline.blocks) if (baseline.palette[block.state].Name === 'minecraft:quartz_block') quartzByLayer.set(block.y, (quartzByLayer.get(block.y) || 0) + 1);
  const quartzTotal = baseline.counts.byName['minecraft:quartz_block'] || 0;
  const choice = [...quartzByLayer].filter(([, count]) => count > 0 && count < quartzTotal).sort((a, b) => b[1] - a[1])[0];
  assert.ok(choice, 'LITEMATIC_SAMPLE needs quartz blocks on at least two layers for the partial replacement test');
  const [chosenLayer, expectedChanges] = choice;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-v2-ui-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ jarPath: path.resolve(jarPath), resourcePackPath: '' }));
  const env = { ...process.env, LITEMATIC_STUDIO_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  watchdog = setTimeout(() => { report.errors.push('Timeout during ' + activeStep); writeReport(); killOwnedApp(); process.exit(1); }, Number(process.env.VIEWER_TEST_TIMEOUT || 360000));
  stage('launch isolated profile and real sample');
  app = await electron.launch({ executablePath: process.env.VIEWER_EXE || require('electron'), args: process.env.VIEWER_EXE ? [path.resolve(sample)] : [root, path.resolve(sample)], env, timeout: 60000 });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await waitLoaded(page);
    const loaded = await page.evaluate(() => {
      const state = window.studio.getState(); window.__v2Baseline = state.data;
      return { blocks: state.data.blocks.length, entities: state.data.entities.length, textures: Object.keys(state.assets.textures).length, dirty: state.document.dirty };
    });
    assert.equal(loaded.blocks, baseline.blocks.length); assert.equal(loaded.entities, baseline.entities.length); assert.equal(loaded.dirty, false); assert.ok(loaded.textures > 0);
    passed('sample startup, local textures and entity data', loaded);

    stage('waterlogged and exact property filters');
    await page.locator('#special-filter').selectOption('waterlogged');
    const waterlogged = await page.evaluate(() => {
      const state = window.studio.getState(), expected = state.data.blocks.map((b, i) => state.data.palette[b.state].Properties?.waterlogged === 'true' ? i : null).filter(i => i !== null);
      return { actual: state.visible, expected };
    });
    assert.deepEqual(waterlogged.actual, waterlogged.expected);
    await page.locator('#reset-filters').click();
    const property = await page.evaluate(() => {
      const states = window.studio.getState().data.palette;
      const state = states.find(s => s.Properties?.waterlogged === 'false') || states.find(s => s.Properties?.facing) || states.find(s => Object.keys(s.Properties || {}).length);
      const key = state.Properties.waterlogged != null ? 'waterlogged' : state.Properties.facing != null ? 'facing' : Object.keys(state.Properties)[0];
      return { key, value: state.Properties[key] };
    });
    await page.locator('.advanced-filter > summary').click();
    await page.locator('#property-key').selectOption(property.key); await page.locator('#property-value').selectOption(property.value);
    const exact = await page.evaluate(({ key, value }) => {
      const state = window.studio.getState(), expected = state.data.blocks.map((b, i) => state.data.palette[b.state].Properties?.[key] === value ? i : null).filter(i => i !== null);
      return { actual: state.visible, expected };
    }, property);
    assert.deepEqual(exact.actual, exact.expected);
    passed('waterlogged and arbitrary exact state filters', { waterlogged: waterlogged.actual.length, property, exactMatches: exact.actual.length });

    stage('one-layer quartz to stone through replacement dialog');
    await page.locator('#reset-filters').click();
    await page.locator('.block-row[data-name="minecraft:quartz_block"] .only-button').click();
    await page.locator('[data-mode="single"]').click(); await page.locator('#single-y').fill(String(chosenLayer));
    await page.waitForFunction(({ layer, count }) => { const state = window.studio.getState(); return state.visible.length === count && state.visible.every(i => state.data.blocks[i].y === layer); }, { layer: chosenLayer, count: expectedChanges });
    await openReplacement(page, 'minecraft:quartz_block', 'minecraft:stone');
    assert.match(await page.locator('#replace-summary').textContent(), new RegExp(expectedChanges.toLocaleString('zh-CN').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await dataAction(page, page.locator('#apply-replace'));
    const scoped = await page.evaluate(layer => {
      const state = window.studio.getState(), previous = window.__v2Baseline, byIndex = new Map(state.data.blocks.map(b => [`${b.region}\0${b.localIndex}`, b]));
      let changed = 0, unexpected = 0;
      for (const b of previous.blocks) {
        const next = byIndex.get(`${b.region}\0${b.localIndex}`), oldState = previous.palette[b.state], newState = next && state.data.palette[next.state];
        const targeted = oldState.Name === 'minecraft:quartz_block' && b.y === layer;
        if (targeted && newState?.Name === 'minecraft:stone') changed++;
        else if (!next || JSON.stringify(newState) !== JSON.stringify(oldState)) unexpected++;
        if (JSON.stringify(b.nbt) !== JSON.stringify(next?.nbt)) unexpected++;
      }
      return { changed, unexpected, blocks: state.data.blocks.length, dirty: state.document.dirty, canUndo: state.document.canUndo,
        entitiesIntact: JSON.stringify(state.data.entities) === JSON.stringify(previous.entities) };
    }, chosenLayer);
    assert.equal(scoped.changed, expectedChanges); assert.equal(scoped.unexpected, 0); assert.equal(scoped.blocks, baseline.blocks.length); assert.equal(scoped.dirty, true); assert.equal(scoped.canUndo, true); assert.equal(scoped.entitiesIntact, true);
    assert.equal(sha256(fs.readFileSync(sample)), originalHash);
    passed('replacement affects only selected quartz layer', { layer: chosenLayer, changed: expectedChanges });

    stage('undo, redo, save, and saved-state dirty tracking');
    const customText = [...new Set(baseline.blocks.map(b => b.y))].sort((a,b)=>a-b).filter((_,i)=>i%2===0).join(',');
    await page.locator('[data-mode="custom"]').click();
    await page.locator('#custom-layers').fill(customText); await page.locator('#apply-layers').click();
    await dataAction(page, page.locator('#undo-button'));
    assert.equal(await page.locator('#custom-layers').inputValue(), customText);
    assert.equal(await page.evaluate(() => window.studio.getState().data.counts.byName['minecraft:quartz_block']), quartzTotal);
    assert.equal(await page.evaluate(() => window.studio.getState().document.dirty), false);
    await dataAction(page, page.locator('#redo-button'));
    assert.equal(await page.locator('#custom-layers').inputValue(), customText);
    assert.equal(await page.evaluate(() => window.studio.getState().data.counts.byName['minecraft:quartz_block']), quartzTotal - expectedChanges);
    const savedPath = path.join(output, 'v2-scope-edited.litematic'), saved = await saveThroughUI(page, savedPath);
    assert.equal(verifyScopedResult(baseline, saved, chosenLayer), expectedChanges);
    const originalNBT = parseNBT(originalBytes), savedNBT = parseNBT(fs.readFileSync(savedPath));
    for (const name of Object.keys(originalNBT.value.Regions)) for (const key of Object.keys(originalNBT.value.Regions[name]).filter(k => !['BlockStatePalette', 'BlockStates'].includes(k))) {
      assert.deepEqual(savedNBT.value.Regions[name][key], originalNBT.value.Regions[name][key]);
      assert.deepEqual(savedNBT.types.children.Regions.children[name].children[key], originalNBT.types.children.Regions.children[name].children[key]);
    }
    await dataAction(page, page.locator('#undo-button'));
    assert.equal(await page.evaluate(() => window.studio.getState().document.dirty), true);
    assert.equal(await page.evaluate(() => window.studio.getState().filePath), savedPath);
    await dataAction(page, page.locator('#redo-button'));
    assert.equal(await page.evaluate(() => window.studio.getState().document.dirty), false);
    assert.equal(sha256(fs.readFileSync(sample)), originalHash);
    passed('actual litematic save, undo/redo dirty flags and original SHA-256 protection', { saved: path.basename(savedPath), blocks: saved.blocks.length, entities: saved.entities.length });

    stage('synthetic NBT containers and target property dropdown defaults');
    const fixturePath = path.join(profile, 'containers.litematic'), fixtureBytes = createFixture(fixturePath), fixtureHash = sha256(fixtureBytes);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, fixturePath);
    await dataAction(page, page.locator('#open-button'));
    assert.equal(await page.evaluate(() => window.studio.getState().data.blocks.length), 4);
    await openReplacement(page, 'minecraft:chest', 'minecraft:stone_stairs', 'all');
    const defaults = await page.locator('[data-target-prop]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.targetProp, element.value])));
    assert.deepEqual(defaults, { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
    await page.locator('#replace-target').fill('minecraft:stone_slab');
    const slabDefaults = await page.locator('[data-target-prop]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.targetProp, element.value])));
    assert.deepEqual(slabDefaults, { type: 'bottom', waterlogged: 'false' });
    await page.locator('#replace-target').fill('minecraft:chest');
    await page.locator('#preserve-properties').uncheck();
    await page.locator('[data-target-prop="waterlogged"]').selectOption('true');
    await dataAction(page, page.locator('#apply-replace'));
    const containerState = await page.evaluate(() => {
      const state = window.studio.getState(), chests = state.data.blocks.filter(b => state.data.palette[b.state].Name === 'minecraft:chest');
      return { count: chests.length, properties: chests.map(b => state.data.palette[b.state].Properties), contents: chests.map(b => b.container.itemCount), names: chests.map(b => b.nbt.CustomName), dirty: state.document.dirty, entities: state.data.entities.length };
    });
    assert.equal(containerState.count, 2); assert.ok(containerState.properties.every(properties => properties.waterlogged === 'true'));
    assert.deepEqual(containerState.contents, [32, 32]); assert.deepEqual(containerState.names, ['Container 0', 'Container 1']); assert.equal(containerState.entities, 1); assert.equal(containerState.dirty, true);
    await page.locator('#special-filter').selectOption('waterlogged');
    assert.equal(await page.evaluate(() => window.studio.getState().visible.length), 2);
    const propertySave = path.join(output, 'v2-waterlogged-edited.litematic');
    const waterSaved = await saveThroughUI(page, propertySave), fixtureOriginal = parseLitematic(fixtureBytes);
    assert.deepEqual(waterSaved.entities, fixtureOriginal.entities);
    for (const b of fixtureOriginal.blocks) { const next = waterSaved.blocks.find(n => stableId(n) === stableId(b)); assert.deepEqual(next.nbt, b.nbt); assert.deepEqual(next.nbtTypes, b.nbtTypes); }
    assert.equal(sha256(fs.readFileSync(fixturePath)), fixtureHash); assert.equal(sha256(fs.readFileSync(sample)), originalHash);
    passed('same-ID waterlogged edit retains both inventories and entity NBT', { blocks: containerState.count, saved: path.basename(propertySave), stairsDefaults: defaults, slabDefaults });
    assert.deepEqual(report.errors, []);
    report.passed = true; activeStep = 'complete'; writeReport();
  } finally {
    if (app) { await Promise.race([app.close().catch(() => {}), pause(5000).then(killOwnedApp)]); }
    clearTimeout(watchdog);
    // Only the exact fresh directory created by this test is removed.
    if (profile && path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('litematic-v2-ui-')) fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(error => { report.errors.push(`${activeStep}: ${error.stack || error.message}`); writeReport(); killOwnedApp(); clearTimeout(watchdog); console.error(error); process.exitCode = 1; });
