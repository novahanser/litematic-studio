'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { registryStates, enumerateVisualStates, selectSource, inspectSourceModel, auditBlocks, discoverClasspath, generateRegistry } = require('../scripts/audit-blocks.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const cube = { from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['north', 'south', 'west', 'east', 'up', 'down'].map(d => [d, { texture: '#all', uv: [0, 0, 16, 16] }])) };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'block-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, 'game.jar'), zip = new AdmZip();
  const entries = {
    'version.json': { id: 'audit-fixture' },
    'assets/minecraft/lang/zh_cn.json': {},
    'assets/minecraft/textures/block/stone.png': PNG,
    'assets/minecraft/models/block/cube.json': { textures: { all: 'minecraft:block/stone' }, elements: [cube] },
    'assets/minecraft/models/block/empty.json': { elements: [] },
    'assets/minecraft/models/block/thin.json': { textures: { all: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 8], to: [16, 16, 8], rotation: { axis: 'y', angle: 45, origin: [8, 8, 8], rescale: true }, faces: { north: { texture: '#all', uv: [-4, 0, 20, 16] }, south: { texture: '#all', uv: [0, 0, 16, 16] } } }] },
    'assets/minecraft/models/block/alternative.json': { parent: 'minecraft:block/cube', textures: { all: 'minecraft:block/missing_texture' } },
    'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'minecraft:block/cube' } } },
    'assets/minecraft/blockstates/thin.json': { variants: { '': { model: 'minecraft:block/thin' } } },
    'assets/minecraft/blockstates/random.json': { variants: { '': [{ model: 'minecraft:block/cube', weight: 10 }, { model: 'minecraft:block/alternative', weight: 1 }, { model: 'minecraft:block/missing_model', weight: 1 }] } },
    'assets/minecraft/blockstates/disconnected.json': { multipart: [{ when: { connected: 'true' }, apply: { model: 'minecraft:block/cube' } }] },
  };
  Object.entries(entries).forEach(([name, value]) => zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))));
  zip.writeZip(jar);
  return { root, jar };
}

test('official registry preserves all legal state rows, invisible properties, IDs and defaults', () => {
  const report = { 'minecraft:stone': { properties: { hidden: ['0', '1'] }, states: [{ id: 9, properties: { hidden: '0' }, default: true }, { id: 11, properties: { hidden: '1' } }] } };
  const result = registryStates(report);
  assert.equal(result.completeLegalStates, true); assert.equal(result.states.length, 2);
  assert.deepEqual(result.states[1], { state: { Name: 'minecraft:stone', Properties: { hidden: '1' } }, registryId: 11, default: false });
  assert.throws(() => registryStates({ 'minecraft:stone': { states: [{ id: 1 }, { id: 1 }] } }), /duplicate/);
  assert.throws(() => registryStates({ 'minecraft:stone': { properties: { x: ['a'] }, states: [{ id: 1, properties: { x: 'b' } }] } }), /outside/);
});

test('visual inference explicitly disclaims legal-state completeness and limits Cartesian expansion', () => {
  const defs = new Map([['minecraft:example', { multipart: [{ when: { OR: [{ north: 'true' }, { axis: 'x|z' }] }, apply: { model: 'minecraft:block/cube' } }] }]]);
  const result = enumerateVisualStates(defs);
  assert.equal(result.completeLegalStates, false); assert.equal(result.states.length, 4);
  assert.ok(result.states.some(s => s.state.Properties.north === 'false'));
  assert.throws(() => enumerateVisualStates(defs, 2), /exceeds/);
});

test('source selection includes every weighted alternative and matching multipart condition', () => {
  const source = { variants: { 'facing=north': [{ model: 'a' }, { model: 'b' }], 'facing=south': { model: 'c' } }, multipart: [{ when: { AND: [{ powered: 'true' }, { OR: [{ facing: 'north' }, { facing: 'west' }] }] }, apply: [{ model: 'd' }, { model: 'e' }] }] };
  const result = selectSource(source, { facing: 'north', powered: 'true' });
  assert.deepEqual(result.selected.map(d => d.model), ['a', 'd']);
  assert.deepEqual(result.alternatives.map(d => d.model), ['a', 'b', 'd', 'e']);
  assert.deepEqual(result.multipartMatches, [0]);
});

test('source audit follows texture variables including unprefixed vanilla slots and detects cycles', () => {
  const m = { textures: { all: '#side', side: 'minecraft:block/stone' }, elements: [{ ...cube, faces: { north: { texture: 'all' } } }] };
  assert.deepEqual(inspectSourceModel('minecraft:block/test', m, { hasTexture: id => id === 'minecraft:block/stone' }).issues, []);
  m.textures.side = '#all';
  assert.equal(inspectSourceModel('minecraft:block/test', m, { hasTexture: () => true }).issues[0].code, 'source-invalid-texture');
});

test('full audit detects a missing unchosen weighted model/texture, thin geometry and legal empty multipart', async t => {
  const { jar } = fixture(t);
  const registry = { 'minecraft:stone': { states: [{ id: 0 }] }, 'minecraft:thin': { states: [{ id: 1 }] }, 'minecraft:random': { states: [{ id: 2 }] }, 'minecraft:disconnected': { states: [{ id: 3, properties: { connected: 'false' } }, { id: 4, properties: { connected: 'true' } }] } };
  const result = await auditBlocks({ jarPath: jar, registry, batchSize: 2 });
  assert.equal(result.summary.states, 5); assert.equal(result.summary.completeLegalStates, true);
  const stone = result.states.find(r => r.state.Name === 'minecraft:stone');
  assert.equal(stone.status, 'pass'); assert.equal(stone.nonFullCandidate, false); assert.equal(stone.geometry.finite, true);
  const empty = result.states.find(r => r.state.Name === 'minecraft:disconnected' && r.state.Properties.connected === 'false');
  assert.equal(empty.hasFaces, false); assert.equal(empty.emptyReason, 'multipart-no-parts-match'); assert.equal(empty.status, 'intentional-empty');
  const random = result.states.find(r => r.state.Name === 'minecraft:random');
  assert.ok(random.issues.some(i => i.code === 'source-model-error'));
  assert.ok(random.issues.some(i => i.code === 'source-missing-texture'));
  assert.equal(random.sourceSelection.unrenderedChoices, 2);
  assert.equal(result.summary.unrenderedWeightedChoicesAcrossStates, 2);
  const thin = result.states.find(r => r.state.Name === 'minecraft:thin');
  assert.equal(thin.details.zeroThickness.length, 1); assert.deepEqual(thin.details.zeroThickness[0].faces, ['north', 'south']);
  assert.equal(thin.details.rescaled.length, 1); assert.equal(thin.details.uvOutOfBounds.length, 1);
  assert.ok(thin.issues.some(i => i.code === 'uv-out-of-bounds')); assert.equal(thin.geometry.finite, true);
});

test('classpath discovery resolves installed launcher libraries without downloading or launching anything', t => {
  const { root } = fixture(t), game = path.join(root, '.minecraft'), version = path.join(game, 'versions', 'fixture');
  fs.mkdirSync(version, { recursive: true });
  const jar = path.join(version, 'fixture.jar'), library = path.join(game, 'libraries', 'example', 'lib', '1', 'lib-1.jar');
  fs.writeFileSync(jar, ''); fs.mkdirSync(path.dirname(library), { recursive: true }); fs.writeFileSync(library, '');
  fs.writeFileSync(path.join(version, 'fixture.json'), JSON.stringify({ libraries: [{ name: 'example:lib:1' }, { name: 'not.installed:missing:1' }] }));
  assert.deepEqual(discoverClasspath(jar).split(path.delimiter), [jar, library]);
});

test('datagen uses native Unicode argv and a relative output, not platform-encoded Java argfiles', t => {
  const { root } = fixture(t), outputDirectory = path.join(root, '中文 folder'), classpath = path.join(root, '本地 游戏.jar');
  let calls = 0;
  const filename = generateRegistry({ jarPath: 'unused.jar', outputDirectory, classpath, runJava: (exe, argv, options) => {
    calls++;
    assert.equal(exe, 'java'); assert.deepEqual(argv, ['-classpath', classpath, 'net.minecraft.data.Main', '--reports', '--output', 'vanilla-registry']);
    assert.equal(options.cwd, outputDirectory); assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
    const directory = path.join(options.cwd, 'vanilla-registry', 'reports'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'blocks.json'), JSON.stringify({ 'minecraft:stone': { states: [{ id: 1, default: true }] } }));
    return { status: 0, stdout: 'generated', stderr: '' };
  } });
  assert.equal(calls, 1); assert.equal(filename, path.join(outputDirectory, 'vanilla-registry', 'reports', 'blocks.json'));
});
