'use strict';

// Source-level Electron smoke test: no Minecraft JAR, schematic, or app build
// required. A generated test texture and the real viewer exercise browser input.
const { _electron: electron } = require('playwright');
const { build } = require('esbuild');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const report = { checks: [], errors: [] };
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-cursor-'));
  fs.mkdirSync(output, { recursive: true });
  await build({ stdin: { contents: `
    import * as THREE from 'three';
    import { SchematicViewer } from './src/renderer/viewer.js';
    const v = window.viewer = new SchematicViewer(document.getElementById('viewport'));
    const tile = document.createElement('canvas'); tile.width = tile.height = 16;
    const ctx = tile.getContext('2d'); ctx.fillStyle = '#318ea3'; ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#65c4b3'; for(let y=0;y<16;y+=4)for(let x=0;x<16;x+=4)if((x+y)%8)ctx.fillRect(x,y,4,4);
    await v.setData({ palette: [{Name:'minecraft:stone',Properties:{}}], blocks:[{x:0,y:0,z:0,state:0}] },
      { textures:{stone:tile.toDataURL()}, blocks:[{parts:[{elements:[{from:[0,0,0],to:[16,16,16],
        faces:Object.fromEntries(['up','down','north','south','east','west'].map(d=>[d,{texture:'stone'}]))}]}]}] });
    v.setGrid(false);
    window.setup = mode => {
      v.stopInertia(); v.setProjection(mode); v.camera.zoom = 1;
      v.camera.position.set(-1,.5,-3); v.controls.target.set(-1,.5,45);
      v.controls.minDistance = .2; v.controls.maxDistance = 50000;
      v.controls.minZoom = .0001; v.controls.maxZoom = 100000;
      if(v.camera.isOrthographicCamera){v.orthoHeight=4;v.resize();}
      v.camera.updateProjectionMatrix();v.controls.update();v.capture();
    };
    window.project = point => {
      const p = new THREE.Vector3(...point).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
      return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};
    };
    window.pose = () => ({position:v.camera.position.toArray(),target:v.controls.target.toArray(),
      quaternion:v.camera.quaternion.toArray(),distance:v.camera.position.distanceTo(v.controls.target),zoom:v.camera.zoom});
    window.ready = true;
  `, resolveDir: root, sourcefile: 'cursor-zoom-smoke-entry.js' }, bundle: true, format: 'esm', outfile: path.join(profile, 'renderer.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(profile, 'index.html'), '<!doctype html><style>html,body,#viewport{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style><div id="viewport"></div><script type="module" src="renderer.js"></script>');
  fs.writeFileSync(path.join(profile, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1000,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(profile, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(profile, 'main.cjs')], env, timeout: 60000 });
  const watchdog = setTimeout(() => {
    const pid = app.process()?.pid;
    if (pid && process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else app.process()?.kill('SIGKILL');
  }, 120000);
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => window.ready);
    for (const projection of ['perspective', 'orthographic']) {
      await page.evaluate(mode => window.setup(mode), projection);
      const surface = [.5, .5, 0], at = await page.evaluate(p => window.project(p), surface);
      assert.equal(await page.evaluate(p => window.viewer.pickTarget({clientX:p.x,clientY:p.y})?.index, at), 0);
      await page.mouse.move(at.x, at.y); await page.mouse.wheel(0, -120); await page.waitForTimeout(100);
      const after = await page.evaluate(p => ({ screen:window.project(p),pose:window.pose() }), surface);
      const surfaceDrift = Math.hypot(after.screen.x-at.x,after.screen.y-at.y);
      assert.ok(surfaceDrift < .5, JSON.stringify({projection,at,after,surfaceDrift})); close(after.pose.distance, projection === 'perspective' ? 2.5 : 3);
      if (projection === 'orthographic') close(after.pose.zoom, 1.2);

      const blank = [.5, -.2, 0], blankAt = await page.evaluate(p => window.project(p), blank);
      assert.equal(await page.evaluate(p => window.viewer.pickTarget({clientX:p.x,clientY:p.y}), blankAt), null);
      await page.mouse.move(blankAt.x, blankAt.y); await page.mouse.wheel(0, -120); await page.waitForTimeout(100);
      const emptyAfter = await page.evaluate(p => ({ screen:window.project(p),pose:window.pose() }), blank);
      const blankDrift = Math.hypot(emptyAfter.screen.x-blankAt.x,emptyAfter.screen.y-blankAt.y);
      assert.ok(blankDrift < .5, JSON.stringify({projection,blankAt,emptyAfter,blankDrift})); close(emptyAfter.pose.distance, projection === 'perspective' ? 2.5/1.2 : 3);

      const original = await page.evaluate(() => window.pose());
      for(let i=0;i<12;i++){await page.mouse.wheel(0,1.5);await page.mouse.wheel(0,-1.5);}
      await page.waitForTimeout(150);
      const restored = await page.evaluate(() => window.pose());
      for (const field of ['position','target','quaternion']) original[field].forEach((value,index) => close(value,restored[field][index]));
      close(original.zoom,restored.zoom);

      // A physically held Control key must not be interpreted as a trackpad pinch.
      await page.keyboard.down('Control'); await page.mouse.wheel(0,-120); await page.keyboard.up('Control'); await page.waitForTimeout(100);
      const ctrl = await page.evaluate(() => window.pose());
      if(projection==='orthographic')close(ctrl.zoom/restored.zoom,1.2);else close(restored.distance/ctrl.distance,1.2);
      report.checks.push({ name:projection+' real wheel: surface → empty space → fractional round trips → Control modifier', surfaceDriftPixels:surfaceDrift, blankDriftPixels:blankDrift });
    }

    await page.evaluate(() => window.setup('perspective'));
    const before = await page.evaluate(() => window.pose());
    await page.mouse.move(450,350);await page.mouse.down({button:'middle'});await page.mouse.move(510,380,{steps:8});await page.mouse.up({button:'middle'});await page.waitForTimeout(250);
    const orbit = await page.evaluate(() => {window.viewer.stopInertia();return window.pose();});
    assert.ok(orbit.quaternion.some((value,i)=>Math.abs(value-before.quaternion[i])>.001));
    await page.keyboard.down('Shift');await page.mouse.down({button:'middle'});await page.mouse.move(555,400,{steps:8});await page.mouse.up({button:'middle'});await page.keyboard.up('Shift');await page.waitForTimeout(250);
    const pan = await page.evaluate(() => {window.viewer.stopInertia();return window.pose();});
    orbit.quaternion.forEach((value,i)=>close(value,pan.quaternion[i],.00001));
    assert.ok(pan.target.some((value,i)=>Math.abs(value-orbit.target[i])>.01));
    await page.keyboard.down('Control');await page.mouse.down({button:'middle'});await page.mouse.move(555,460,{steps:8});await page.mouse.up({button:'middle'});await page.keyboard.up('Control');await page.waitForTimeout(250);
    const dolly = await page.evaluate(() => window.pose());
    assert.ok(Math.abs(dolly.distance-pan.distance)>.1);
    report.checks.push({name:'real MMB orbit, Shift+MMB pan and Control+MMB dolly remain available'});
    await page.evaluate(() => window.setup('perspective'));
    await page.screenshot({path:path.join(output,'cursor-zoom-source-smoke.png')});
    assert.deepEqual(report.errors,[]);
    console.log(JSON.stringify(report,null,2));
  } finally {
    clearTimeout(watchdog);
    await app.close();
    fs.writeFileSync(path.join(output,'cursor-zoom-smoke-report.json'),JSON.stringify(report,null,2)+'\n');
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
