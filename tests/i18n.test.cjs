'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const AdmZip=require('adm-zip');
const {translate,normalizeLocale,gameLabel,matchesGameName}=require('../src/core/i18n.cjs');
const {loadAssets}=require('../src/core/assets.cjs');
const {createHash}=require('node:crypto');

test('all Chinese static UI text and tooltips have English translations',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8');
  const texts=[...html.matchAll(/>([^<>]+)</g)].map(m=>m[1].trim());
  for(const m of html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g))texts.push(m[1]);
  const untranslated=texts.filter(s=>/[\u3400-\u9fff]/.test(s)&&!['中文','Language / 语言'].includes(s)).filter(s=>/[\u3400-\u9fff]/.test(translate(s,'en_us')));
  assert.deepEqual(untranslated,[]);
});

test('UI messages translate numbers and preserve arbitrary paths, IDs and NBT values',()=>{
  assert.equal(normalizeLocale('unknown'),'zh_cn');
  assert.equal(translate('有物品','zh_cn'),'有物品');
  assert.equal(translate('  有物品 \n','en_us'),'  Has items \n');
  assert.equal(translate('1,234 / 5,678 方块','en_us'),'1,234 / 5,678 blocks');
  assert.equal(translate('已替换 3 个方块，移除 2 条不兼容方块 NBT。可撤销，另存后写入磁盘。','en_us'),'Replaced 3 blocks; removed 2 incompatible block NBT entries. Undo is available; save to write changes.');
  const filename='C:/schematics/测试工程.litematic';
  assert.equal(translate('已另存投影：'+filename,'en_us'),'Schematic saved: '+filename);
  assert.equal(translate('打开失败：不是有效的 .litematic 文件：缺少 Regions','en_us'),'Open failed: Invalid .litematic file: missing Regions.');
  assert.equal(translate('minecraft:stone: 缺失本地模型: example:模型','en_us'),'minecraft:stone: Missing local model: example:模型');
  const raw='{"CustomName":"有物品","id":"minecraft:chest","Long":"9223372036854775807"}';
  assert.equal(translate(raw,'en_us'),raw);
});

test('English game names never fall back to the Chinese-merged legacy table',()=>{
  const assets={langs:{en_us:{'block.minecraft.test':'English block','item.minecraft.test':'English item','entity.minecraft.test':'English entity'},zh_cn:{'block.minecraft.test':'中文方块'}},lang:{'block.minecraft.only_zh':'只有中文'}};
  assert.equal(gameLabel(assets,'minecraft:test','en_us'),'English block');
  assert.equal(gameLabel(assets,'minecraft:test','en_us','item'),'English item');
  assert.equal(gameLabel(assets,'minecraft:test','en_us','entity'),'English entity');
  assert.equal(gameLabel(assets,'minecraft:test','zh_cn'),'中文方块');
  assert.equal(gameLabel(assets,'minecraft:only_zh','en_us'),'only_zh');
  assert.equal(gameLabel(assets,'minecraft:only_zh','zh_cn'),'只有中文');
  assert.equal(gameLabel(assets,'example:unknown','en_us'),'example:unknown');
  assert.equal(matchesGameName(assets,'minecraft:test','中文方块'),true);
  assert.equal(matchesGameName(assets,'minecraft:test','ENGLISH BLOCK'),true);
  assert.equal(matchesGameName(assets,'minecraft:test','english item','item'),true);
  assert.equal(matchesGameName(assets,'minecraft:test','unrelated'),false);
});

test('entity label refresh retains objects, transforms and active entity filters',async()=>{
  const {EntityPreviewLayer}=await import('../src/renderer/entity-view.js');
  const entities=[{id:'example:unknown',position:{x:2,y:3,z:4},rotation:[45,0],nbt:{}},{id:'minecraft:pig',position:{x:5,y:6,z:7},nbt:{}}];
  const layer=new EntityPreviewLayer(entities,{entities:[{kind:'unknown',label:'未知'},{kind:'unknown',label:'猪'}],textures:{}});
  layer.setFilter({indices:[1]});
  const objects=layer.objects.slice(),matrix=objects.map(o=>o.matrix.toArray());
  layer.setLabels(index=>index?'Pig':'example:unknown','Approximate bounds');
  assert.equal(layer.objects[0],objects[0]);assert.equal(layer.objects[1],objects[1]);
  assert.deepEqual(layer.getVisibleIndices(),[1]);assert.deepEqual(layer.objects.map(o=>o.matrix.toArray()),matrix);
  assert.equal(layer.objects[1].name,'Pig #2');layer.dispose();
});

function languageFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-languages-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const game=path.join(root,'.minecraft'),version=path.join(game,'versions','fixture');fs.mkdirSync(version,{recursive:true});
  const jar=path.join(version,'fixture.jar'),packPath=path.join(root,'pack.zip'),zip=new AdmZip(),pack=new AdmZip();
  const entries={
    'version.json':{id:'fixture'},
    'assets/minecraft/blockstates/stone.json':{variants:{'':{model:'block/stone'}}},
    'assets/minecraft/blockstates/iron_chain.json':{variants:{'':{model:'block/stone'}}},
    'assets/minecraft/models/block/stone.json':{elements:[]},
    'assets/minecraft/lang/en_us.json':{'block.minecraft.stone':'Stone','item.minecraft.stone':'Stone item','entity.minecraft.pig':'Pig','block.minecraft.iron_chain':'Iron Chain','item.minecraft.iron_chain':'Iron Chain item','block.minecraft.base':'Base English'},
    'assets/minecraft/lang/zh_cn.json':{'block.minecraft.stone':'JAR 石头','block.minecraft.iron_chain':'铁链','item.minecraft.iron_chain':'铁链物品'},
  };
  for(const [name,value]of Object.entries(entries))zip.addFile(name,Buffer.from(JSON.stringify(value)));zip.writeZip(jar);
  pack.addFile('assets/minecraft/lang/en_us.json',Buffer.from(JSON.stringify({'block.minecraft.stone':'Pack Stone'})));
  pack.addFile('assets/minecraft/lang/zh_cn.json',Buffer.from(JSON.stringify({'item.minecraft.stone':'包内石头物品'})));pack.writeZip(packPath);
  const indexed=Buffer.from(JSON.stringify({'entity.minecraft.pig':'索引猪','block.minecraft.base':'索引中文','block.minecraft.stone':'索引石头'})),hash=createHash('sha1').update(indexed).digest('hex');
  fs.mkdirSync(path.join(game,'assets','indexes'),{recursive:true});fs.mkdirSync(path.join(game,'assets','objects',hash.slice(0,2)),{recursive:true});
  fs.writeFileSync(path.join(game,'assets','indexes','fixture.json'),JSON.stringify({objects:{'minecraft/lang/zh_cn.json':{hash}}}));
  fs.writeFileSync(path.join(game,'assets','objects',hash.slice(0,2),hash),indexed);
  fs.writeFileSync(path.join(version,'fixture.json'),JSON.stringify({assetIndex:{id:'fixture'}}));
  return {jar,packPath};
}
test('local archive and indexed languages merge per locale and key; resource pack is highest priority',t=>{
  const {jar,packPath}=languageFixture(t),assets=loadAssets(jar,['minecraft:stone','minecraft:chain'],{resourcePackPath:packPath});
  assert.equal(assets.langs.en_us['block.minecraft.stone'],'Pack Stone');
  assert.equal(assets.langs.en_us['entity.minecraft.pig'],'Pig');
  assert.equal(assets.langs.en_us['block.minecraft.base'],'Base English');
  assert.equal(assets.langs.zh_cn['block.minecraft.stone'],'JAR 石头');
  assert.equal(assets.langs.zh_cn['item.minecraft.stone'],'包内石头物品');
  assert.equal(assets.langs.zh_cn['entity.minecraft.pig'],'索引猪');
  assert.equal(assets.langs.en_us['block.minecraft.chain'],'Iron Chain');
  assert.equal(assets.langs.zh_cn['block.minecraft.chain'],'铁链');
  assert.equal(assets.lang['block.minecraft.stone'],'JAR 石头');
  assert.equal(assets.blocks[1].name,'minecraft:chain');
});

test('optional local game has distinct English block, item and entity labels',{skip:!process.env.MINECRAFT_JAR},()=>{
  const assets=loadAssets(process.env.MINECRAFT_JAR,['minecraft:stone']);
  assert.equal(gameLabel(assets,'minecraft:stone','en_us'),'Stone');
  assert.equal(gameLabel(assets,'minecraft:diamond','en_us','item'),'Diamond');
  assert.equal(gameLabel(assets,'minecraft:pig','en_us','entity'),'Pig');
  assert.equal(assets.langs.en_us['block.minecraft.stone'],'Stone');
  if(assets.langs.zh_cn['block.minecraft.stone'])assert.notEqual(assets.langs.en_us['block.minecraft.stone'],assets.langs.zh_cn['block.minecraft.stone']);
});
