'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeNBT } = require('../src/core/document.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-results');
const sample = process.env.LITEMATIC_SAMPLE, jarPath = process.env.MINECRAFT_JAR;
const checks = [], errors = [];

function createDisplayFixture(file) {
  const cases = [], add = (Name, Properties = {}) => cases.push({Name:'minecraft:'+Name, Properties});
  for(const type of ['bottom','top']) add('quartz_slab',{type,waterlogged:'true'});
  add('quartz_slab',{type:'bottom',waterlogged:'false'});
  for(const half of ['bottom','top']) for(const facing of ['north','east','south','west']) add('quartz_stairs',{half,facing,shape:'straight',waterlogged:'true'});
  for(const shape of ['inner_left','outer_right']) add('quartz_stairs',{half:'bottom',facing:'east',shape,waterlogged:'true'});
  add('cobblestone_wall',{up:'true',north:'low',south:'low',east:'none',west:'none',waterlogged:'true'});
  add('white_stained_glass_pane',{north:'true',south:'true',east:'false',west:'false',waterlogged:'true'});
  add('oak_fence',{north:'true',south:'false',east:'true',west:'false',waterlogged:'true'});
  add('oak_leaves',{distance:'7',persistent:'true',waterlogged:'true'});
  add('copper_grate',{waterlogged:'true'});
  for(const level of ['0','4','7']) add('water',{level});
  for(const facing of ['up','down','north','east','south','west']) add('purple_shulker_box',{facing});
  for(const facing of ['north','east','south','west']) for(const part of ['head','foot']) add('red_bed',{facing,part,occupied:'false'});
  for(const rotation of ['0','4','8','12']) add('oak_sign',{rotation,waterlogged:'false'});
  for(const facing of ['north','east','south','west']) add('oak_wall_sign',{facing,waterlogged:'false'});
  for(const facing of ['up','down','north','east','south','west']) add('observer',{facing,powered:'false'});
  const width=23, height=4, depth=Math.ceil(cases.length/8)*3, palette=[{Name:'minecraft:air'},{Name:'minecraft:polished_deepslate'},...cases];
  const states=new Uint32Array(width*height*depth);
  cases.forEach((_,i)=>{const x=(i%8)*3+1,z=Math.floor(i/8)*3+1;states[z*width+x]=1;states[width*depth+z*width+x]=i+2;});
  const bits=Math.max(2,Math.ceil(Math.log2(palette.length))),words=Array(Math.ceil(states.length*bits/64)).fill(0n);
  states.forEach((n,i)=>{const bit=i*bits,w=Math.floor(bit/64),shift=bit%64;words[w]|=BigInt(n)<<BigInt(shift);if(shift+bits>64)words[w+1]|=BigInt(n)>>BigInt(64-shift);});
  const tag=(type,value)=>({value,types:{type}}),str=v=>tag('string',v),int=v=>tag('int',v);
  const compound=o=>({value:Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v.value])),types:{type:'compound',children:Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v.types]))}});
  const list=(type,a)=>({value:a.map(x=>x.value),types:{type:'list',elementType:type,items:a.map(x=>x.types)}});
  const vector=(x,y,z)=>compound({x:int(x),y:int(y),z:int(z)});
  const tree=compound({Version:int(6),MinecraftDataVersion:int(4671),Metadata:compound({Name:str('Water and orientation preview'),TotalBlocks:int(cases.length*2)}),Regions:compound({preview:compound({Position:vector(0,0,0),Size:vector(width,height,depth),BlockStatePalette:list('compound',palette.map(s=>compound({Name:str(s.Name),Properties:compound(Object.fromEntries(Object.entries(s.Properties||{}).map(([k,v])=>[k,str(v)])))}))),BlockStates:tag('long_array',words.map(w=>BigInt.asIntN(64,w).toString())),TileEntities:list('compound',[]),Entities:list('compound',[])})})});
  fs.writeFileSync(file,writeNBT({name:'Display regression',...tree}));
  return cases.length;
}

async function main() {
  if(!sample||!jarPath){console.log('SKIP display smoke: set LITEMATIC_SAMPLE and MINECRAFT_JAR.');return;}
  fs.mkdirSync(output,{recursive:true});
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'litematic-display-'));
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({jarPath:path.resolve(jarPath),resourcePackPath:''}));
  const env={...process.env,LITEMATIC_STUDIO_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({executablePath:process.env.VIEWER_EXE||require('electron'),args:process.env.VIEWER_EXE?[sample]:[root,sample],env,timeout:60000});
  try {
    const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>window.studio?.getState().data&&!window.studio.getState().busy,null,{timeout:120000});
    const snapshot=await page.evaluate(()=>({stats:window.studio.viewer.getStats(),blocks:window.studio.getState().data.blocks.length}));
    assert.ok(snapshot.stats.waterFaces>0,'Representative sample has visible water');checks.push({name:'sample water and waterlogged geometry',...snapshot});
    for(const projection of ['perspective','orthographic']) {
      await page.evaluate(mode=>{const v=window.studio.viewer;v.setProjection(mode);v.view('iso');v.fit();v.capture();},projection);
      const target=await page.evaluate(()=>{
        const v=window.studio.viewer,r=v.renderer.domElement.getBoundingClientRect();
        for(const fx of [.68,.35,.76,.25])for(const fy of [.6,.53,.7,.42]){
          const x=r.left+r.width*fx,y=r.top+r.height*fy,hit=v.pickTarget({clientX:x,clientY:y});
          if(hit?.point)return {x,y,point:hit.point.toArray(),before:v.camera.position.distanceTo(hit.point)};
        }return null;
      });
      assert.ok(target,'An off-center surface is available for wheel zoom');
      await page.mouse.move(target.x,target.y);await page.mouse.wheel(0,-240);await page.waitForTimeout(220);
      const after=await page.evaluate(t=>{const v=window.studio.viewer,r=v.renderer.domElement.getBoundingClientRect(),p=v.controls.target.clone().fromArray(t.point);v.camera.updateMatrixWorld(true);const q=p.clone().project(v.camera);return {x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2,distance:v.camera.position.distanceTo(p),zoom:v.camera.zoom};},target);
      assert.ok(Math.hypot(after.x-target.x,after.y-target.y)<.8,projection+' keeps the pointed surface under the cursor');
      if(projection==='perspective')assert.ok(after.distance<target.before);else assert.ok(after.zoom>1);
      checks.push({name:projection+' real wheel anchors to off-center surface',driftPixels:Math.hypot(after.x-target.x,after.y-target.y)});
    }
    await page.locator('#special-filter').selectOption('waterlogged');
    const filtered=await page.evaluate(()=>{const s=window.studio.getState();return {visible:s.visible.length,valid:s.visible.every(i=>s.data.palette[s.data.blocks[i].state].Properties.waterlogged==='true'),stats:window.studio.viewer.getStats()};});
    assert.ok(filtered.valid&&filtered.visible>0&&filtered.stats.waterFaces>0);checks.push({name:'water follows special-state visibility',...filtered});

    const fixture=path.join(profile,'display.litematic'),caseCount=createDisplayFixture(fixture);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},fixture);
    await page.locator('#open-button').click();
    await page.waitForFunction(file=>{const s=window.studio.getState();return !s.busy&&s.filePath===file;},fixture,{timeout:120000});
    await page.evaluate(()=>{const v=window.studio.viewer;v.setProjection('perspective');v.view('iso');v.fit();v.setEntityVisible(false);});
    const capture=async name=>{const png=await page.evaluate(()=>window.studio.viewer.capture());fs.writeFileSync(path.join(output,name),Buffer.from(png.split(',')[1],'base64'));};
    await capture('v3-display-fixture.png');
    await page.evaluate(()=>{const s=window.studio.getState(),v=window.studio.viewer;const i=s.data.blocks.findIndex(b=>s.data.palette[b.state].Name==='minecraft:quartz_stairs');v.focus(i);v.zoom(1.6);});
    await capture('v3-waterlogged-detail.png');
    const fixtureState=await page.evaluate(()=>({stats:window.studio.viewer.getStats(),warnings:window.studio.getState().assets.warnings}));
    assert.ok(fixtureState.stats.waterFaces>0);assert.equal(fixtureState.stats.total,caseCount*2);
    assert.ok(!fixtureState.warnings.some(w=>/缺失或无效的本地材质|缺失本地模型/.test(w)),JSON.stringify(fixtureState.warnings));
    checks.push({name:'synthetic orientations, partial water and local special-block textures',caseCount,...fixtureState});
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'display-v3-report.json'),JSON.stringify({checks,errors},null,2));
    console.log(JSON.stringify({checks,errors},null,2));
  } finally {await app.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
