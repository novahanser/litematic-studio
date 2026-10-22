'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const { normalizeContainer, buildContainerLayout } = require('../src/core/container-layout.cjs');
const entry = path.resolve(__dirname, '../src/renderer/container-view.js');
const bundle = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' } }).outputFiles[0].text;
const compiled = new Module(entry); compiled.paths = module.paths; compiled._compile(bundle, entry);
const { renderContainerView } = compiled.exports;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
function layout(name, nbt, properties = {}) {
  return buildContainerLayout({ palette: [{ Name: name, Properties: properties }], blocks: [{ state: 0, x: 0, y: 5, z: 2, region: 'main', nbt, container: normalizeContainer(nbt, name) }] }, 0);
}

test('slot HTML preserves exact sparse slot indices, counts and native GUI coordinate alignment', () => {
  const data = layout('minecraft:chest', { Items: [{ Slot: 26, id: 'minecraft:ice', Count: 64 }] });
  const html = renderContainerView(data, { locale: 'en_us', label: id => id === 'minecraft:ice' ? 'Ice' : id, itemAssets: { gui: { generic_54: PNG } }, selectedSlot: 26 });
  assert.equal((html.match(/data-container-slot=/g) || []).length, 27);
  assert.match(html, /data-container-slot="26"/); assert.match(html, /data-inventory-icon="minecraft:ice"/);
  assert.match(html, /container-stack-count">64/); assert.match(html, /Original item NBT/); assert.match(html, /Ice/);
  assert.match(html, /has-native-gui/); assert.match(html, /width:10\.227272727272728%/);
  assert.match(html, /aspect-ratio:176\/78/); assert(!/[\u4e00-\u9fff]/.test(html));
});

test('unrecorded and loot slots cannot be mistaken for confirmed empty inventory', () => {
  const unknown = renderContainerView(layout('minecraft:hopper', null), { locale: 'en_us' });
  assert.equal((unknown.match(/container-unknown/g) || []).length, 5); assert.match(unknown, /Unknown contents/); assert.match(unknown, /Block NBT was not saved/);
  const loot = renderContainerView(layout('minecraft:chest', { Items: [], LootTable: 'minecraft:chests/dungeon' }), { locale: 'zh_cn' });
  assert.equal((loot.match(/container-unknown/g) || []).length, 27); assert.match(loot, /待生成战利品/);
  const empty = renderContainerView(layout('minecraft:hopper', { Items: [] }), { locale: 'en_us' });
  assert.equal((empty.match(/container-unknown/g) || []).length, 0); assert.match(empty, /Recorded empty/);
});

test('container labels, identifiers and raw NBT are escaped in attributes and detail views', () => {
  const evil = '<img src=x onerror="attack()">';
  const data = layout('minecraft:barrel', { Items: [{ Slot: 0, id: evil, Count: 1, components: { name: '<script>attack()</script>' } }, { Slot: 500, id: 'minecraft:stone', count: 2 }] });
  const html = renderContainerView(data, { locale: 'en_us', label: () => evil, selectedSlot: 0 });
  assert(!html.includes('<script>')); assert(!html.includes('<img src=x'));
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Slot outside container range/); assert.match(html, /500/);
});

test('crafter disabled slots and duplicate stacks remain discoverable, while both locales are complete', () => {
  const data = layout('minecraft:crafter', { disabled_slots: [1], Items: [{ Slot: 1, id: 'minecraft:ice', count: 2 }, { Slot: 1, id: 'minecraft:stone', count: 3 }] });
  const en = renderContainerView(data, { locale: 'en_us', selectedSlot: 1 });
  assert.match(en, /disabled-slot/); assert.match(en, /container-conflict/); assert.match(en, /minecraft:ice/); assert.match(en, /minecraft:stone/);
  assert.match(en, /Multiple stacks use this slot/); assert.match(en, /recipe result preview/); assert(!/[\u4e00-\u9fff]/.test(en));
  const zh = renderContainerView(data, { locale: 'zh_cn', selectedSlot: 1 }); assert.match(zh, /已禁用/); assert.match(zh, /同一槽号/);
});

test('higher-resolution GUI replacements preserve reference sheet coordinates and unknown skins fall back clearly', () => {
  const data = layout('minecraft:furnace', { Items: [] });
  const a = renderContainerView(data, { itemAssets: { gui: { furnace: PNG }, guiSizes: { furnace: { width: 256, height: 256 } } } });
  const b = renderContainerView(data, { itemAssets: { gui: { furnace: PNG }, guiSizes: { furnace: { width: 1024, height: 1024 } } } });
  assert.equal(a, b);
  const noSkin = renderContainerView(data, { itemAssets: { gui: { furnace: 'https://invalid.example/external.png' } } });
  assert.match(noSkin, /css-gui/); assert(!noSkin.includes('https://'));
});

test('approximate icon details are localized and unsupported icon IDs remain explicit', () => {
  const data = layout('minecraft:barrel', { Items: [{ Slot: 0, id: 'minecraft:potion', count: 1 }] });
  const options = { locale: 'en_us', selectedSlot: 0, itemAssets: { items: { 'minecraft:potion': { kind: 'sprite', approximate: true, limitations: ['potion_effect_color', 'enchantment_glint'] } } } };
  const en = renderContainerView(data, options); assert.match(en, /inventory-approx-mark/); assert.match(en, /Custom potion effect color is not reproduced/); assert.match(en, /Enchantment glint is not drawn/);
  const zh = renderContainerView(data, { ...options, locale: 'zh_cn' }); assert.match(zh, /图标为近似外观/); assert.match(zh, /未绘制附魔光效/);
});

test('custom item names are plain escaped text and potion names can use local game translations', () => {
  const data = layout('minecraft:barrel', { Items: [
    {Slot:0,id:'minecraft:diamond',count:1,components:{'minecraft:custom_name':{text:'<Gem>',extra:[{text:' stash',clickEvent:{action:'run_command',value:'/example'}}]}}},
    {Slot:1,id:'minecraft:potion',count:1,components:{'minecraft:potion_contents':{potion:'minecraft:strong_healing'}}},
    {Slot:2,id:'minecraft:diamond',count:1,tag:{display:{Name:'{"text":"Old name"}'}}},
  ] });
  const label = id => id === 'minecraft:potion.effect.healing' ? 'Potion of Healing' : id;
  const html=renderContainerView(data,{locale:'en_us',label,selectedSlot:0});
  assert.match(html,/&lt;Gem&gt; stash/); assert(!html.includes('<Gem>')); assert.match(html,/Potion of Healing/); assert.match(html,/Old name/);
  assert.match(html,/minecraft:diamond/);
});
