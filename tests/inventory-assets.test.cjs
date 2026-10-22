'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { loadInventoryAssets } = require('../src/core/inventory-assets.cjs');
const { inventoryKey } = require('../src/core/inventory-key.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const itemModel = name => `assets/minecraft/models/item/${name}.json`;
const item = name => `assets/minecraft/items/${name}.json`;
const texture = name => `assets/minecraft/textures/item/${name}.png`;
const model = name => ({ type: 'minecraft:model', model: `minecraft:item/${name}` });
const sprite = name => ({ parent: 'minecraft:item/generated', textures: { layer0: `minecraft:item/${name}` } });
function archive(filename, entries) {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) zip.addFile(name, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
  zip.writeZip(filename); return filename;
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = archive(path.join(root, 'fixture.jar'), {
    [itemModel('generated')]: { parent: 'builtin/generated', gui_light: 'front' },
    [itemModel('gem')]: sprite('gem'), [texture('gem')]: PNG,
    [itemModel('other')]: sprite('other'), [texture('other')]: PNG,
    'assets/minecraft/textures/gui/container/hopper.png': PNG,
    ...extra,
  });
  return { jar, root };
}

test('legacy inventory models retain sprite layers and native GUI resources', t => {
  const { jar } = fixture(t); const result = loadInventoryAssets(jar, ['minecraft:gem']);
  assert.equal(result.items['minecraft:gem'].kind, 'sprite');
  assert.equal(result.items['minecraft:gem'].layers[0].texture, 'minecraft:item/gem');
  assert.equal(result.items['minecraft:gem'].guiLight, 'front');
  assert.match(result.gui.hopper, /^data:image\/png;base64,/); assert.deepEqual(result.warnings, []);
});

test('modern component variants have different icons, including black and zero values', t => {
  const { jar } = fixture(t, { [item('gem')]: { model: { ...model('gem'), tints: [{ type: 'minecraft:dye', default: 16777215 }] } } });
  const stacks = [0, 0xff0000].map(rgb => ({ id: 'minecraft:gem', components: { 'minecraft:dyed_color': rgb } }));
  const result = loadInventoryAssets(jar, stacks);
  assert.notEqual(inventoryKey(stacks[0]), inventoryKey({ id: 'minecraft:gem' }));
  assert.notEqual(inventoryKey(stacks[0]), inventoryKey(stacks[1]));
  assert.equal(result.items[inventoryKey(stacks[0])].layers[0].color, 0);
  assert.equal(result.items[inventoryKey(stacks[1])].layers[0].color, 0xff0000);
  assert.equal(inventoryKey({ id: 'minecraft:gem', nbt: stacks[0] }), inventoryKey(stacks[0]));
  assert.notEqual(inventoryKey({ id: 'minecraft:gem', tag: { CustomModelData: 0 } }), 'minecraft:gem');
});

test('modern graph selects GUI context and component models without changing stack data', t => {
  const { jar } = fixture(t, { [item('gem')]: { model: { type: 'minecraft:select', property: 'minecraft:display_context', cases: [{ when: 'gui', model: { type: 'minecraft:range_dispatch', property: 'minecraft:custom_model_data', entries: [{ threshold: 2, model: model('other') }], fallback: model('gem') } }], fallback: model('other') } } });
  const stack = { id: 'minecraft:gem', components: { 'minecraft:custom_model_data': { floats: [3] } } }, before = JSON.stringify(stack);
  assert.equal(loadInventoryAssets(jar, [stack]).items[inventoryKey(stack)].layers[0].texture, 'minecraft:item/other');
  assert.equal(JSON.stringify(stack), before);
  assert.equal(loadInventoryAssets(jar, ['minecraft:gem']).items['minecraft:gem'].layers[0].texture, 'minecraft:item/gem');
});

test('inherits block item geometry, GUI pose and explicit per-face tint', t => {
  const display = { rotation: [30, 225, 0], translation: [0, 1, 0], scale: [.625, .625, .625] };
  const { jar } = fixture(t, {
    [item('gem')]: { model: { ...model('gem'), tints: [{ type: 'minecraft:constant', value: 0x804020 }] } },
    [itemModel('gem')]: { parent: 'minecraft:item/base', textures: { surface: 'minecraft:item/gem' } },
    [itemModel('base')]: { display: { gui: display }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { north: { texture: '#surface', tintindex: 0 } } }] },
  });
  const icon = loadInventoryAssets(jar, ['minecraft:gem']).items['minecraft:gem'];
  assert.equal(icon.kind, 'model'); assert.deepEqual(icon.display, display);
  assert.deepEqual(icon.parts[0].elements[0].faces.north.colorRGB, [128 / 255, 64 / 255, 32 / 255]);
  assert.deepEqual(icon.parts[0].elements[0].faces.north.uv, [0, 8, 16, 16]);
});

test('local pack overrides item definitions, textures and native GUI backgrounds', t => {
  const { jar, root } = fixture(t); const alternate = Buffer.from(PNG); alternate[alternate.length - 1] ^= 1;
  const resourcePackPath = archive(path.join(root, 'pack.zip'), { [item('gem')]: { model: model('other') }, [texture('other')]: alternate, 'assets/minecraft/textures/gui/container/hopper.png': alternate });
  const result = loadInventoryAssets(jar, ['minecraft:gem'], { resourcePackPath });
  assert.equal(result.items['minecraft:gem'].layers[0].texture, 'minecraft:item/other');
  assert.equal(result.textures['minecraft:item/other'], `data:image/png;base64,${alternate.toString('base64')}`);
  assert.equal(result.gui.hopper, result.textures['minecraft:item/other']);
});

test('layered potion icons apply custom colors only to their tinted layer', t => {
  const { jar } = fixture(t, { [item('gem')]: { model: { ...model('gem'), tints: [{ type: 'minecraft:potion', default: 0xffffff }] } }, [itemModel('gem')]: { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/gem', layer1: 'minecraft:item/other' } } });
  const stack = { id: 'minecraft:gem', tag: { CustomPotionColor: 0x123456 } };
  const icon = loadInventoryAssets(jar, [stack]).items[inventoryKey(stack)];
  assert.deepEqual(icon.layers.map(l => l.color), [0x123456, 0xffffff]);
});

test('one broken model cannot suppress other icons or GUI resources', t => {
  const { jar } = fixture(t, { [itemModel('broken')]: { parent: 'minecraft:item/broken' } });
  const result = loadInventoryAssets(jar, ['minecraft:broken', 'minecraft:gem']);
  assert.equal(result.items['minecraft:broken'].kind, 'unsupported');
  assert.match(result.items['minecraft:broken'].reason, /Cyclic/);
  assert.equal(result.items['minecraft:gem'].kind, 'sprite'); assert.ok(result.gui.hopper);
});

test('invalid animated frame and UV inputs are rejected without creating bad geometry', t => {
  const { jar } = fixture(t, { [texture('gem') + '.mcmeta']: { animation: { width: -1 } }, [itemModel('other')]: { textures: { t: 'minecraft:item/other' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#t', uv: ['bad', 0, 16, 16] } } }] } });
  const result = loadInventoryAssets(jar, ['minecraft:gem', 'minecraft:other']);
  assert.match(result.items['minecraft:gem'].reason, /animation/); assert.match(result.items['minecraft:other'].reason, /UV/);
});

test('unsafe custom model resource paths are not accepted', t => {
  const { jar } = fixture(t); const stack = { id: 'minecraft:gem', components: { 'minecraft:item_model': 'minecraft:../../private' } };
  const result = loadInventoryAssets(jar, [stack]);
  assert.equal(result.items[inventoryKey(stack)].kind, 'unsupported');
  assert.ok(result.warnings.length);
});

test('visual keys retain arbitrary components and normalize object-key order', () => {
  const a={id:'minecraft:gem',components:{'minecraft:trim':{material:'minecraft:gold',pattern:'minecraft:coast'},'example:flag':{}}};
  const b={id:'minecraft:gem',components:{'example:flag':{},'minecraft:trim':{pattern:'minecraft:coast',material:'minecraft:gold'}}};
  assert.equal(inventoryKey(a),inventoryKey(b));assert.notEqual(inventoryKey(a),inventoryKey({id:a.id}));
  assert.notEqual(inventoryKey({id:a.id,components:{'minecraft:charged_projectiles':[{id:'minecraft:arrow'}]}}),inventoryKey({id:a.id}));
});

test('charge and trim properties choose saved component variants instead of idle icons', t => {
  const {jar}=fixture(t,{[item('gem')]:{model:{type:'minecraft:select',property:'minecraft:charge_type',cases:[{when:'arrow',model:model('other')}],fallback:model('gem')}},
    [item('armor')]:{model:{type:'minecraft:select',property:'minecraft:trim_material',cases:[{when:'minecraft:gold',model:model('other')}],fallback:model('gem')}}});
  const idle={id:'minecraft:gem'},charged={id:'minecraft:gem',components:{'minecraft:charged_projectiles':[{id:'minecraft:arrow'}]}},trimmed={id:'minecraft:armor',components:{'minecraft:trim':{material:'minecraft:gold'}}};
  const output=loadInventoryAssets(jar,[idle,charged,trimmed]);
  assert.equal(output.items[inventoryKey(idle)].layers[0].texture,'minecraft:item/gem');
  for(const stack of [charged,trimmed])assert.equal(output.items[inventoryKey(stack)].layers[0].texture,'minecraft:item/other');
});

test('vanilla potion palette matches the local 1.21.11 registry and unknown effects are explicit', t => {
  const {jar}=fixture(t,{[item('gem')]:{model:{...model('gem'),tints:[{type:'minecraft:potion',default:3694022}]}}});
  const cases=[['water',3694022],['healing',(-515037)&0xffffff],['swiftness',(-13374465)&0xffffff],['strong_turtle_master',(-7502362)&0xffffff]];
  const stacks=cases.map(([id])=>({id:'minecraft:gem',components:{'minecraft:potion_contents':{potion:'minecraft:'+id}}}));
  const unknown={id:'minecraft:gem',components:{'minecraft:potion_contents':{potion:'custom:magic',custom_effects:[{id:'custom:glow'}]}}};
  const output=loadInventoryAssets(jar,[...stacks,unknown]);
  stacks.forEach((stack,i)=>{assert.equal(output.items[inventoryKey(stack)].layers[0].color,cases[i][1]);assert.equal(output.items[inventoryKey(stack)].approximate,false);});
  assert.ok(output.items[inventoryKey(unknown)].limitations.includes('potion_effect_color'));
});

test('firework averages saved colors and enchanted icons disclose the omitted glint', t => {
  const {jar}=fixture(t,{[item('gem')]:{model:{...model('gem'),tints:[{type:'minecraft:firework',default:0}]}}});
  const stack={id:'minecraft:gem',components:{'minecraft:firework_explosion':{colors:[0xff0000,0x0000ff]},'minecraft:enchantments':{'minecraft:unbreaking':1}}};
  const descriptor=loadInventoryAssets(jar,[stack]).items[inventoryKey(stack)];
  assert.equal(descriptor.layers[0].color,0x7f007f);assert.ok(descriptor.limitations.includes('enchantment_glint'));
});

test('shield special model uses local entity texture and both native model cubes', t => {
  const {jar}=fixture(t,{[item('shield')]:{model:{type:'minecraft:special',base:'minecraft:item/shield',model:{type:'minecraft:shield'}}},
    [itemModel('shield')]:{gui_light:'front',display:{gui:{rotation:[15,-25,-5],translation:[2,3,0],scale:[.65,.65,.65]}}},
    'assets/minecraft/textures/entity/shield_base_nopattern.png':PNG});
  const descriptor=loadInventoryAssets(jar,['minecraft:shield']).items['minecraft:shield'];
  assert.equal(descriptor.kind,'model');assert.equal(descriptor.parts[0].elements.length,2);
  assert.deepEqual(descriptor.parts[0].elements[0].from,[-6,-11,-2]);
  assert.deepEqual(descriptor.parts[0].elements[0].to,[6,11,-1]);
  assert.ok(Object.values(descriptor.parts[0].elements[0].faces).every(face=>face.texture==='minecraft:entity/shield_base_nopattern'));
  assert.equal(descriptor.parts[0].elements[0].transform[5],-1);assert.equal(descriptor.parts[0].elements[0].transform[10],-1);
});

test('real local client provides inventory models and container screens', { skip: !process.env.MINECRAFT_JAR }, () => {
  const ids = ['stone', 'diamond', 'ice', 'oak_stairs', 'chest', 'potion', 'repeater', 'chain', 'shield', 'red_bed', 'red_shulker_box'].map(id => `minecraft:${id}`);
  const result = loadInventoryAssets(process.env.MINECRAFT_JAR, ids);
  assert.deepEqual(result.warnings, []);
  for (const id of ids) assert.notEqual(result.items[id].kind, 'unsupported', id);
  for (const key of ['generic_54', 'hopper', 'dispenser', 'furnace', 'brewing_stand', 'crafter']) assert.ok(result.gui[key], key);
  assert.equal(result.items['minecraft:red_bed'].parts.length,2,'Inventory bed contains both head and foot');
  assert.equal(result.items['minecraft:red_bed'].parts.flatMap(p=>p.elements).length,6,'Both mattress halves and all four legs');
  assert.equal(result.items['minecraft:red_shulker_box'].parts[0].x,0,'Native inventory shulker defaults to UP');
  const sitting={id:'minecraft:copper_golem_statue',components:{'minecraft:block_state':{copper_golem_pose:'sitting'}}};
  const poses=loadInventoryAssets(process.env.MINECRAFT_JAR,['minecraft:copper_golem_statue',sitting]);
  assert.notDeepEqual(poses.items['minecraft:copper_golem_statue'].parts,poses.items[inventoryKey(sitting)].parts);
});
