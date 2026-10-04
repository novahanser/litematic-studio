const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('every registered water and waterlogged state builds finite static fluid surfaces', {
  skip: !(process.env.MINECRAFT_JAR && process.env.MINECRAFT_REGISTRY)
    && 'Set MINECRAFT_JAR and MINECRAFT_REGISTRY (vanilla reports/blocks.json) for exhaustive fluid validation.',
}, async t => {
  const { buildFluidGeometry } = await import('../src/renderer/fluid-geometry.js');
  const { loadAssets } = require('../src/core/assets.cjs');
  const registry = JSON.parse(fs.readFileSync(process.env.MINECRAFT_REGISTRY, 'utf8'));
  const states = [];
  for (const [Name, block] of Object.entries(registry)) for (const entry of block.states) {
    const Properties = entry.properties || {};
    if (Properties.waterlogged === 'true' || Name === 'minecraft:water' || Name === 'minecraft:bubble_column') states.push({ Name, Properties });
  }
  assert.ok(states.length > 1000, 'the audit requires the complete game registry, not a sample schematic');
  const assets = loadAssets(process.env.MINECRAFT_JAR, states);
  const atlas = { width: 32, height: 32, regions: Object.fromEntries(Object.keys(assets.textures).map(name => [name, { x: 2, y: 2, width: 16, height: 16, opaque: true }])) };
  const checked = new Map(), emptyNames = new Set(); let faces = 0, statesWithEmptyFluid = 0, porousStates = 0;
  for (let i = 0; i < states.length; i++) {
    const state = states[i], blockAsset = assets.blocks[i];
    const signature = JSON.stringify([state.Name, state.Properties.level, blockAsset.parts, blockAsset.fluidPorous, blockAsset.waterlogged]);
    let result = checked.get(signature);
    if (!result) {
      const geometry = buildFluidGeometry({ palette: [state], blocks: [{ x: 0, y: 0, z: 0, state: 0 }] }, [0], { ...assets, blocks: [blockAsset] }, atlas);
      const { position, normal, uv } = geometry.attributes;
      assert.equal(position.count, normal.count, state.Name); assert.equal(position.count, uv.count, state.Name);
      assert.equal(geometry.index.count % 6, 0, state.Name);
      assert.equal(geometry.userData.blockIndices.length * 4, position.count, state.Name);
      assert.ok(geometry.userData.blockIndices.every(index => index === 0), state.Name);
      for (let vertex = 0; vertex < position.count; vertex++) {
        for (const value of [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]) {
          assert.ok(Number.isFinite(value) && value >= -1e-6 && value <= 1 + 1e-6, `${state.Name} fluid outside its block: ${value}`);
        }
        const length = Math.hypot(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
        assert.ok(Math.abs(length - 1) < 1e-6, state.Name);
        assert.ok(uv.getX(vertex) > 2 / 32 && uv.getX(vertex) < 18 / 32, `${state.Name} fluid u`);
        assert.ok(uv.getY(vertex) > 1 - 18 / 32 && uv.getY(vertex) < 1 - 2 / 32, `${state.Name} fluid v`);
      }
      result = { faces: geometry.index.count / 6, porous: geometry.userData.porousBlocks > 0 };
      checked.set(signature, result); geometry.dispose();
    }
    faces += result.faces; if (result.porous) porousStates++;
    const solidDoubleSlab = state.Name.endsWith('_slab') && state.Properties.type === 'double';
    assert.equal(result.faces === 0, solidDoubleSlab,
      `${state.Name} ${JSON.stringify(state.Properties)}: only a full double slab may completely contain the fluid`);
    if (!result.faces) { statesWithEmptyFluid++; emptyNames.add(state.Name); }
  }
  t.diagnostic(JSON.stringify({ states: states.length, uniqueStateModels: checked.size, facesAcrossAllStates: faces,
    porousStates, statesWithEmptyFluid, emptyFluidBlockTypes: [...emptyNames].sort(),
    limitation: 'Static model-pixel occupancy validation; no flow simulation or texture-hole voxelization.' }));
});
