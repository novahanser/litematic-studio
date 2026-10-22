'use strict';
// Optional desktop regression. Set MINECRAFT_JAR and run npm run build first.
// Fixtures are synthetic; game resources and outputs remain local.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {_electron:electron}=require('playwright');
const {writeNBT}=require('../src/core/document.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'test-results','language-v140');
const report={passed:false,checks:[],errors:[]};
let app,page,profile,watchdog;
function fixture(filename){
  const tag=(type,value)=>({value,types:{type}}),int=n=>tag('int',n),str=s=>tag('string',s);
  const comp=children=>({value:Object.fromEntries(Object.entries(children).map(([k,v])=>[k,v.value])),types:{type:'compound',children:Object.fromEntries(Object.entries(children).map(([k,v])=>[k,v.types]))}});
  const list=(elementType,items)=>({value:items.map(v=>v.value),types:{type:'list',elementType,items:items.map(v=>v.types)}});
  const vec=(x,y,z)=>comp({x:int(x),y:int(y),z:int(z)});
  const state=(name,props={})=>comp({Name:str('minecraft:'+name),Properties:comp(Object.fromEntries(Object.entries(props).map(([k,v])=>[k,str(v)])))});
  const states=[1,2,0,0,0,0,3,0];let bits=0n;states.forEach((n,i)=>bits|=BigInt(n)<<BigInt(i*2));
  const tree=comp({Version:int(6),MinecraftDataVersion:int(4671),Metadata:comp({Name:str('Language regression')}),Regions:comp({region:comp({Position:vec(0,0,0),Size:vec(4,2,1),
    BlockStatePalette:list('compound',[state('air'),state('stone'),state('chest',{facing:'north',type:'single',waterlogged:'false'}),state('oak_slab',{type:'bottom',waterlogged:'true'})]),
    BlockStates:tag('long_array',[bits.toString()]),TileEntities:list('compound',[comp({id:str('minecraft:chest'),x:int(1),y:int(0),z:int(0),CustomName:str('原始名字：有物品'),Items:list('compound',[comp({id:str('minecraft:diamond'),Count:tag('byte',4),Slot:tag('byte',5)})])})]),
    Entities:list('compound',[comp({id:str('minecraft:pig'),Pos:list('double',[tag('double',2.5),tag('double',1),tag('double',1.5)]),CustomName:str('原始实体名')}),comp({id:str('example:unknown'),Pos:list('double',[tag('double',3.5),tag('double',1),tag('double',1.5)])})]),
  })})});fs.writeFileSync(filename,writeNBT({name:'Language',...tree}));
}
function check(name){report.checks.push(name);console.log('PASS '+name);}
function kill(){const child=app?.process();if(child?.pid&&child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});}
async function close(){if(!app)return;let timer;await Promise.race([app.close(),new Promise(resolve=>timer=setTimeout(()=>{kill();resolve();},5000))]);clearTimeout(timer);app=null;}
async function launch(file){
  const env={...process.env,LITEMATIC_STUDIO_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:process.env.VIEWER_EXE||require('electron'),args:process.env.VIEWER_EXE?[file]:[root,file],env,timeout:60000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]?.show());
  page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.waitForFunction(()=>window.studio?.getState().data&&!window.studio.getState().busy,null,{timeout:120000});
}
async function main(){
  if(!process.env.MINECRAFT_JAR){console.log('SKIP language smoke: set MINECRAFT_JAR to a local client JAR.');return;}
  fs.mkdirSync(output,{recursive:true});profile=fs.mkdtempSync(path.join(os.tmpdir(),'studio-language-'));
  const file=path.join(profile,'language.litematic');fixture(file);
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({jarPath:path.resolve(process.env.MINECRAFT_JAR),resourcePackPath:''}));
  watchdog=setTimeout(()=>{kill();process.exitCode=1;},240000);
  await launch(file);
  assert.match(await page.locator('#open-button').textContent(),/打开投影/);
  await page.locator('[data-mode="custom"]').click();await page.locator('#custom-layers').fill('0, 1');await page.locator('#apply-layers').click();
  for(const [axis,n]of [['x',1],['y',0],['z',0]])await page.locator('#jump-'+axis).fill(String(n));
  await page.locator('#jump-button').click();
  await page.locator('[data-container-slot="5"]').click();
  const search=await page.evaluate(()=>window.studio.getState().assets.langs.zh_cn['block.minecraft.stone']||'Stone');
  await page.locator('#block-search').fill(search);
  await page.evaluate(()=>{const v=window.studio.viewer;v.controls.enableDamping=false;v.setProjection('orthographic');v.stopInertia();v.view('iso');v.zoom(1.2);v.stopInertia();window.__languageData=window.studio.getState().data;});
  const before=await page.evaluate(()=>{const s=window.studio.getState(),v=window.studio.viewer;return{visible:s.visible,selected:s.selected,layer:s.layerMode,camera:v.getCameraInfo(),height:v.orthoHeight,custom:document.getElementById('custom-layers').value,nbt:document.querySelector('#inspector > .inspect-section > pre.nbt').textContent};});
  await page.locator('#language-select').selectOption('en_us');
  await page.waitForFunction(()=>window.studio.getState().locale==='en_us'&&document.getElementById('open-button').textContent.includes('Open'));
  const after=await page.evaluate(()=>{const s=window.studio.getState(),v=window.studio.viewer;return{visible:s.visible,selected:s.selected,layer:s.layerMode,camera:v.getCameraInfo(),height:v.orthoHeight,custom:document.getElementById('custom-layers').value,nbt:document.querySelector('#inspector > .inspect-section > pre.nbt').textContent};});
  assert.deepEqual(after,before);assert.equal(await page.evaluate(()=>window.__languageData===window.studio.getState().data),true);
  assert.equal(await page.locator('#inspector .block-title').textContent(),'Chest');
  assert.match(await page.locator('#inspector').textContent(),/Block entity NBT/);assert.match(after.nbt,/原始名字：有物品/);
  assert.equal(await page.locator('[data-container-slot="5"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('.container-slot-detail').textContent(),/Diamond/);
  const entityLabels=await page.evaluate(()=>{const labels=[];window.studio.viewer.entityLayer.group.traverse(o=>{if(o.userData.labelText)labels.push(o.userData.labelText);});return labels;});
  assert.deepEqual(entityLabels,['example:unknown · Approximate bounds']);
  assert.match(await page.locator('#layer-summary').textContent(),/2 selected layers/);
  assert.equal(await page.locator('#block-search').inputValue(),search);
  assert.deepEqual(await page.locator('#block-list .block-name').allTextContents(),['Stone']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).locale,'en_us');
  check('switch translates inspector and local names without changing view, selection, filters or raw NBT');

  await page.locator('[data-tab="entities"]').click();assert.match(await page.locator('#entity-list').textContent(),/Pig/);
  await page.locator('#entity-list [data-entity]').first().click();assert.match(await page.locator('#entity-inspector').textContent(),/Entity NBT/);
  assert.match(await page.locator('#entity-inspector pre').first().textContent(),/原始实体名/);
  const entitySelection=await page.evaluate(()=>window.studio.getState().selectedEntity);
  await page.locator('#language-select').selectOption('zh_cn');await page.waitForFunction(()=>window.studio.getState().locale==='zh_cn');
  await page.locator('#language-select').selectOption('en_us');await page.waitForFunction(()=>window.studio.getState().locale==='en_us');
  await page.locator('[data-tab="inspect"]').click();
  assert.equal(await page.locator('#container-view').count(),0);
  assert.equal(await page.locator('#inspector .empty-state h3').textContent(),'Select a block');
  assert.equal(await page.evaluate(()=>window.studio.getState().selectedEntity),entitySelection);
  assert.match(await page.locator('#selection-badge').textContent(),/Pig/);
  check('entity names use en_us while NBT remains unchanged');

  const csv=path.join(output,'materials-en.csv');
  await app.evaluate(({dialog},dest)=>{global.__languageDialogs=[];dialog.showSaveDialog=async(_win,options)=>{global.__languageDialogs.push(options);return{canceled:false,filePath:dest};};dialog.showOpenDialog=async(_win,options)=>{global.__languageDialogs.push(options);return{canceled:true,filePaths:[]};};},csv);
  await page.locator('[data-tab="materials"]').click();await page.locator('#export-materials').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Exported:'));
  const content=fs.readFileSync(csv,'utf8');assert.match(content,/'?"Material","Item ID","Quantity","Stacks \(64\)","Remainder","Range"/);assert.match(content,/'?"Stone","minecraft:stone"/);assert.doesNotMatch(content,/diamond/);
  await page.locator('#open-button').click();
  const dialogs=await app.evaluate(()=>global.__languageDialogs);assert.equal(dialogs[0].title,'Export file');assert.equal(dialogs[1].title,'Open Litematica schematic');
  check('CSV headers, localized material names and native dialogs use English');

  await page.locator('#replace-button').click();await page.locator('#replace-target').fill('minecraft:oak_stairs');
  await page.locator('[data-target-prop="waterlogged"]').selectOption('true');
  await page.evaluate(()=>window.studio.setLocale('zh_cn'));
  assert.equal(await page.locator('[data-target-prop="waterlogged"]').inputValue(),'true');
  assert.match(await page.locator('#replace-dialog h2').textContent(),/一键替换方块/);
  await page.evaluate(()=>window.studio.setLocale('en_us'));
  assert.equal(await page.locator('[data-target-prop="waterlogged"]').inputValue(),'true');
  assert.match(await page.locator('#replace-dialog h2').textContent(),/Replace blocks/);
  assert.match(await page.locator('#replace-source').textContent(),/Stone/);
  await page.evaluate(()=>document.getElementById('replace-dialog').close());
  check('language round trip preserves replacement choices and state properties');

  await page.locator('#replace-button').click();await page.locator('#replace-source').selectOption('minecraft:stone');
  await page.locator('#replace-target').fill('minecraft:cobblestone');await page.locator('#apply-replace').click();
  await page.waitForFunction(()=>window.studio.getState().document.dirty&&!window.studio.getState().busy);
  await page.locator('#language-select').selectOption('zh_cn');await page.waitForFunction(()=>window.studio.getState().locale==='zh_cn');
  await page.locator('#language-select').selectOption('en_us');await page.waitForFunction(()=>window.studio.getState().locale==='en_us');
  assert.equal(await page.evaluate(()=>window.studio.getState().document.dirty),true);
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async(_win,options)=>{global.__discardDialog=options;return{response:2};};});
  assert.equal(await page.evaluate(file=>window.desktop.loadFile(file),file),null);
  const discard=await app.evaluate(()=>global.__discardDialog);
  assert.equal(discard.title,'Unsaved schematic changes');assert.deepEqual(discard.buttons,['Save as','Discard changes','Cancel']);
  assert.equal(await page.evaluate(()=>window.studio.getState().document.dirty),true);
  await page.locator('#undo-button').click();await page.waitForFunction(()=>!window.studio.getState().document.dirty&&!window.studio.getState().busy);
  check('language changes preserve unsaved edits and the translated discard dialog protects them');
  await page.locator('#resources-button').click();await page.screenshot({path:path.join(output,'resources-en.png')});
  const warnings=await page.locator('#warnings-list').textContent();assert.doesNotMatch(warnings,/[\u3400-\u9fff]/);
  await page.evaluate(()=>document.getElementById('resources-dialog').close());
  await page.screenshot({path:path.join(output,'viewer-en.png')});
  await close();await launch(file);
  assert.equal(await page.locator('#language-select').inputValue(),'en_us');assert.match(await page.locator('#open-button').textContent(),/Open/);
  check('English preference survives application restart');
  assert.deepEqual(report.errors,[]);report.passed=true;
}
main().catch(e=>{report.errors.push(e.stack);console.error(e);process.exitCode=1;}).finally(async()=>{
  clearTimeout(watchdog);await close();if(profile){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('studio-language-'))fs.rmSync(profile,{recursive:true,force:true});}
});
