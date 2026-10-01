const {test}=require('node:test');const assert=require('node:assert/strict');
const {parseLayers,materialForState,buildMaterialRows,csvCell}=require('../src/core/view-model.cjs');
test('arbitrary non-contiguous and negative layers',()=>{assert.deepEqual([...parseLayers('-3--1,2,4-5',-5,8)],[-3,-2,-1,2,4,5]);assert.throws(()=>parseLayers('0,99',0,5));assert.throws(()=>parseLayers('oops',0,5));});
test('materials account for paired blocks and double slabs',()=>{assert.equal(materialForState({Name:'minecraft:oak_slab',Properties:{type:'double'}}).count,2);assert.equal(materialForState({Name:'minecraft:oak_door',Properties:{half:'upper'}}),null);assert.equal(materialForState({Name:'minecraft:redstone_wire'}).id,'minecraft:redstone');assert.equal(materialForState({Name:'minecraft:water'}),null);const s={palette:[{Name:'minecraft:stone'}],blocks:[{state:0},{state:0}]};assert.deepEqual(buildMaterialRows(s,new Set([1])),[{id:'minecraft:stone',total:2,visible:1}]);});
test('CSV escapes quotes and formulas',()=>{assert.equal(csvCell('a"b'),'"a""b"');assert.equal(csvCell('=bad'),'"\'=bad"');});
test('spaced layer ranges and non-inventory block names are handled',()=>{
  assert.deepEqual([...parseLayers('6 - 10, -3 - -1',-5,20)],[6,7,8,9,10,-3,-2,-1]);
  assert.deepEqual(materialForState({Name:'minecraft:powder_snow'}),{id:'minecraft:powder_snow_bucket',count:1});
  assert.deepEqual(materialForState({Name:'minecraft:turtle_egg',Properties:{eggs:'4'}}),{id:'minecraft:turtle_egg',count:4});
  assert.equal(materialForState({Name:'minecraft:player_wall_head'}).id,'minecraft:player_head');
});
