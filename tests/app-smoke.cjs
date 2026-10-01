const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {parseLitematic}=require('../src/core/litematic.cjs');
const {buildMaterialRows}=require('../src/core/view-model.cjs');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
const sample=process.env.LITEMATIC_SAMPLE;
const jarPath=process.env.MINECRAFT_JAR;
if(!sample||!jarPath){console.log('SKIP app smoke: set LITEMATIC_SAMPLE and MINECRAFT_JAR to local files.');process.exit(0);}
assert.ok(fs.statSync(sample).isFile(),'LITEMATIC_SAMPLE must be a file');
assert.ok(fs.statSync(jarPath).isFile(),'MINECRAFT_JAR must be a file');
const baseline=parseLitematic(fs.readFileSync(sample));
if(!baseline.blocks.length){console.log('SKIP app smoke: the schematic needs at least one non-air block.');process.exit(0);}
const layerCounts=new Map();for(const block of baseline.blocks)layerCounts.set(block.y,(layerCounts.get(block.y)||0)+1);
const layers=[...layerCounts.keys()].sort((a,b)=>a-b),singleLayer=[...layerCounts].sort((a,b)=>b[1]-a[1])[0][0];
const selectedLayers=[...new Set(layers.length>=5?[layers[0],layers[Math.floor(layers.length/2)],layers[layers.length-1]]:[layers[0],layers[layers.length-1]])];
const rangeMin=layers[Math.floor((layers.length-1)/4)],rangeMax=layers[Math.ceil((layers.length-1)*3/4)];
const blockNames=Object.keys(baseline.counts.byName).sort((a,b)=>baseline.counts.byName[b]-baseline.counts.byName[a]);
const nbtCount=baseline.blocks.filter(block=>block.nbt!=null).length,filledCount=baseline.blocks.filter(block=>block.container?.status==='filled').length;
const expectedMaterials=buildMaterialRows(baseline,new Set());
const executable=process.env.VIEWER_EXE||require('electron');
const errors=[],checks=[],skips=[];
let runningApp,activeStep='launch',failure=null;
const started=Date.now();
const log=s=>console.log(`[${((Date.now()-started)/1000).toFixed(1)}s] ${s}`);
function stage(s){activeStep=s;log('START '+s);}
const push=checks.push.bind(checks);checks.push=(...values)=>{values.forEach(v=>log('PASS '+v.name));return push(...values);};
function skip(name,reason){skips.push({name,reason});log(`SKIP ${name}: ${reason}`);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function killOwnApp(){const pid=runningApp?.process()?.pid;if(pid&&process.platform==='win32')spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});else runningApp?.process()?.kill('SIGKILL');}
function writeReport(){fs.writeFileSync(path.join(output,process.env.VIEWER_EXE?'packaged-report.json':'app-report.json'),JSON.stringify({date:new Date().toISOString(),executable,checks,skips,errors,failure,activeStep},null,2));}
const watchdog=setTimeout(()=>{failure='Total timeout during '+activeStep;log(failure);writeReport();killOwnApp();process.exit(1);},Number(process.env.VIEWER_TEST_TIMEOUT||240000));
async function waitForFile(file){for(let i=0;i<100;i++){if(fs.existsSync(file)&&fs.statSync(file).size>0)return;await pause(50);}throw new Error('Export not saved: '+file);}
async function savePath(app,file){if(fs.existsSync(file))fs.unlinkSync(file);await app.evaluate(({dialog},dest)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:dest});},file);}
async function pngStats(app,base64){const stats=await app.evaluate(({nativeImage},data)=>{const image=nativeImage.createFromBuffer(Buffer.from(data,'base64'));const pixels=image.toBitmap(),colors=new Set();let opaque=0,bright=0;const stride=Math.max(1,Math.floor(pixels.length/(4*15000)))*4;for(let i=0;i+3<pixels.length;i+=stride){if(pixels[i+3])opaque++;if(pixels[i]+pixels[i+1]+pixels[i+2]>90)bright++;colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]},${pixels[i+3]}`);}return {...image.getSize(),opaque,bright,colors:colors.size};},base64);assert.ok(stats.width>300&&stats.height>300);assert.ok(stats.opaque>1000&&stats.bright>50&&stats.colors>20,'Rendered non-black PNG: '+JSON.stringify(stats));return stats;}
async function screenshot(app,name){
 stage(name);
 // Windows may retain the last composited surface of an occluded native window.
 // Bring this test's window forward, draw, and allow two compositor frames before
 // capturing; reading DOM state alone does not prove that the image is current.
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];if(w.isMinimized())w.restore();w.show();w.focus();});
 const page=await app.firstWindow();
 await page.evaluate(async()=>{window.studio.viewer.capture();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 await pause(400);
 const base64=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:false,stayAwake:true})).toPNG().toString('base64'));
 await pngStats(app,base64);fs.writeFileSync(path.join(output,name),Buffer.from(base64,'base64'));log('PASS '+name);
}
async function main(){
 const profile=fs.mkdtempSync(path.join(output,'profile-app-'));
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({jarPath:path.resolve(jarPath),resourcePackPath:''}));
 const env={...process.env,LITEMATIC_STUDIO_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({executablePath:executable,args:process.env.VIEWER_EXE?[sample]:[root,sample],env,timeout:60000});
 runningApp=app;log('Launched PID '+app.process().pid);
 try{
  const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>{errors.push(e.message);log('PAGE ERROR '+e.message);});page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());log('CONSOLE ERROR '+m.text());}});
  stage('load sample');
  await page.waitForFunction(()=>window.studio?.getState().data&&!window.studio.getState().busy,null,{timeout:90000});
  const snapshot=await page.evaluate(()=>{const s=window.studio.getState();return {blocks:s.data.blocks.length,textures:Object.keys(s.assets.textures).length,visible:s.visible.length,warnings:s.assets.warnings,stats:window.studio.viewer.getStats()};});
  assert.equal(snapshot.blocks,baseline.blocks.length);assert.equal(snapshot.visible,baseline.blocks.length);assert.ok(snapshot.textures>0);checks.push({name:'load local schematic and game resources',...snapshot});
  await screenshot(app,'01-overview.png');stage('layers');
  await page.locator('[data-mode="single"]').click();await page.locator('#single-y').fill(String(singleLayer));
  await page.waitForFunction(({y,count})=>{const s=window.studio.getState();return s.visible.length===count&&s.visible.every(i=>s.data.blocks[i].y===y);},{y:singleLayer,count:layerCounts.get(singleLayer)});
  checks.push({name:'single layer',layer:singleLayer,count:layerCounts.get(singleLayer)});
  if(selectedLayers.length>1){
   await page.locator('[data-mode="custom"]').click();await page.locator('#custom-layers').fill(selectedLayers.join(','));await page.locator('#apply-layers').click();
   const expected=baseline.blocks.filter(block=>selectedLayers.includes(block.y)).length;
   await page.waitForFunction(({ys,count})=>{const s=window.studio.getState();return s.visible.length===count&&s.visible.every(i=>ys.includes(s.data.blocks[i].y));},{ys:selectedLayers,count:expected});checks.push({name:'multiple selected layers',layers:selectedLayers,count:expected});
  }else skip('multiple selected layers','The schematic has only one occupied layer.');
  await page.locator('[data-mode="range"]').click();await page.locator('#range-min').fill(String(rangeMin));await page.locator('#range-max').fill(String(rangeMax));
  await page.waitForFunction(({min,max,count})=>{const s=window.studio.getState();return s.visible.length===count&&s.visible.every(i=>s.data.blocks[i].y>=min&&s.data.blocks[i].y<=max);},{min:rangeMin,max:rangeMax,count:baseline.blocks.filter(block=>block.y>=rangeMin&&block.y<=rangeMax).length});checks.push({name:'range layers',range:[rangeMin,rangeMax],passed:true});
  await page.locator('#reset-filters').click();
  const blockRow=name=>page.locator(`.block-row[data-name=${JSON.stringify(name)}]`);
  await blockRow(blockNames[0]).locator('.only-button').click();
  assert.equal(await page.evaluate(()=>window.studio.getState().visible.length),baseline.counts.byName[blockNames[0]]);checks.push({name:'single block type',type:blockNames[0]});
  if(blockNames.length>1){
   await blockRow(blockNames[1]).locator('input').check();
   assert.equal(await page.evaluate(()=>window.studio.getState().visible.length),baseline.counts.byName[blockNames[0]]+baseline.counts.byName[blockNames[1]]);checks.push({name:'multiple block types',types:blockNames.slice(0,2)});
  }else skip('multiple block types','The schematic contains only one non-air block type.');
  await page.locator('#reset-filters').click();await page.locator('#nbt-only').check();
  assert.equal(await page.evaluate(()=>window.studio.getState().visible.length),nbtCount);checks.push({name:'NBT-only visibility',count:nbtCount});
  await page.locator('#reset-filters').click();await page.locator('#container-filter').selectOption('filled');
  assert.equal(await page.evaluate(()=>window.studio.getState().visible.length),filledCount);checks.push({name:'filled-container filter',count:filledCount});
  if(filledCount){
   await page.locator('[data-tab="containers"]').click();await page.locator('.container-row').first().click();
   assert.ok(await page.locator('#inspector pre.nbt').first().textContent());assert.ok(await page.locator('.item-row').count()>0);
   const selected=await page.evaluate(()=>{const s=window.studio.getState();return s.data.blocks[s.selected];});assert.equal(selected.container.status,'filled');checks.push({name:'filled containers and NBT inspector',position:[selected.x,selected.y,selected.z],items:selected.container.itemCount});
   await screenshot(app,'02-container-inspector.png');
   stage('NBT JSON export');
   const jsonPath=path.join(output,process.env.VIEWER_EXE?'packaged-container-nbt.json':'container-nbt.json');await savePath(app,jsonPath);await page.locator('#export-nbt').click();await waitForFile(jsonPath);const savedNBT=JSON.parse(fs.readFileSync(jsonPath,'utf8'));assert.deepEqual(savedNBT.nbt,selected.nbt);assert.deepEqual(savedNBT.types,selected.nbtTypes);checks.push({name:'complete NBT JSON export',passed:true});
  }else{
   skip('filled containers and NBT inspector','No container with saved items exists in this schematic.');
   skip('complete NBT JSON export','This UI subtest exports a filled container; none is available.');
  }
  stage('PNG export');
  await page.locator('#reset-filters').click();await page.locator('#fit').click();
  const pngPath=path.join(output,process.env.VIEWER_EXE?'packaged-export-view.png':'export-view.png');await savePath(app,pngPath);await page.locator('#screenshot').click();await waitForFile(pngPath);checks.push({name:'PNG export has rendered non-black pixels',...await pngStats(app,fs.readFileSync(pngPath).toString('base64'))});
  stage('zoom and canvas picking');
  const before=await page.evaluate(()=>window.studio.viewer.camera.position.distanceTo(window.studio.viewer.controls.target));await page.locator('#zoom-in').click();
  const after=await page.evaluate(()=>window.studio.viewer.camera.position.distanceTo(window.studio.viewer.controls.target));assert.ok(after<before);await page.locator('#zoom-out').click();checks.push({name:'zoom buttons',passed:true});
  await page.locator('#reset-filters').click();await page.locator('#fit').click();await page.locator('[data-view="top"]').click();
  const topLayer=layers[layers.length-1];
  await page.locator('[data-mode="single"]').click();await page.locator('#single-y').fill(String(topLayer));
  await page.waitForFunction(({y,count})=>{const s=window.studio.getState();return s.visible.length===count&&s.visible.every(i=>s.data.blocks[i].y===y);},{y:topLayer,count:layerCounts.get(topLayer)});await page.locator('#fit').click();
  const target=await page.evaluate(()=>{const v=window.studio.viewer,s=window.studio.getState(),canvas=v.renderer.domElement.getBoundingClientRect();v.setEntityVisible(false);v.onSelect?.(null,null);v.camera.updateMatrixWorld(true);for(const i of s.visible.slice(0,500)){const b=s.data.blocks[i];for(const dx of [.5,.0625,.9375])for(const dz of [.5,.0625,.9375]){const p=v.controls.target.clone().set(b.x+dx,b.y+.5,b.z+dz).project(v.camera);const x=canvas.x+(p.x+1)*canvas.width/2,y=canvas.y+(1-p.y)*canvas.height/2;if(x>canvas.x+70&&x<canvas.right-85&&y>canvas.y+75&&y<canvas.bottom-75){const index=v.pick({clientX:x,clientY:y});if(index!=null)return {x,y,index};}}}return null;});
  if(target){await page.mouse.click(target.x,target.y);assert.equal(await page.evaluate(()=>window.studio.getState().selected),target.index);checks.push({name:'real canvas click picking',passed:true});}
  else skip('real canvas click picking','No exposed pickable top face found among the first 500 visible blocks.');
  await page.waitForTimeout(300);
  await screenshot(app,'03-layer-selection.png');stage('CSV export');
  const csvPath=path.join(output,'materials.csv');
  await savePath(app,csvPath);
  await page.locator('[data-tab="materials"]').click();await page.locator('#material-scope').selectOption('all');await page.locator('#export-materials').click();
  await waitForFile(csvPath);const csv=fs.readFileSync(csvPath,'utf8');assert.ok(csv.includes('"材料","物品ID","数量"'));
  for(const row of expectedMaterials)assert.ok(csv.includes(`"${row.id.replaceAll('"','""')}","${row.total}",`),`CSV includes ${row.id} and its computed total`);
  if(!expectedMaterials.length)assert.equal(csv.trim().split(/\r?\n/).length,1);
  checks.push({name:'CSV export',materials:expectedMaterials.length,passed:true});stage('bad file recovery');
  const invalid=path.join(output,'broken.litematic');fs.writeFileSync(invalid,'not an NBT file');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},invalid);
  await page.locator('#open-button').click();await page.waitForFunction(()=>!window.studio.getState().busy);
  assert.match(await page.locator('#status').textContent(),/打开失败/);assert.equal(await page.evaluate(()=>window.studio.getState().data.blocks.length),baseline.blocks.length);checks.push({name:'bad file recovers without losing prior scene',passed:true});
  assert.deepEqual(errors,[]);
  activeStep='complete';writeReport();
  console.log(JSON.stringify({passed:checks.length,skipped:skips.length,errors,output},null,2));
 }finally{log('Closing test app');await Promise.race([app.close().catch(()=>{}),pause(5000).then(killOwnApp)]);clearTimeout(watchdog);}
}
main().catch(e=>{failure=activeStep+': '+(e.stack||e);console.error(failure);writeReport();killOwnApp();clearTimeout(watchdog);process.exitCode=1;});
