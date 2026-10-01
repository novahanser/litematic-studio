'use strict';

// Exercise the distributable NSIS portable wrapper itself, not win-unpacked.
// This test owns its wrapper PID, its CDP browser and a fresh temporary profile.
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'portable-report.json');
const executable = path.join(root, 'dist', `Litematic-Studio-${require('../package.json').version}-win-x64.exe`);
const sample = process.env.LITEMATIC_SAMPLE;
const jarPath = process.env.MINECRAFT_JAR;
if (!sample || !jarPath) { console.log('SKIP portable smoke: set LITEMATIC_SAMPLE and MINECRAFT_JAR to local files.'); process.exit(0); }
const {parseLitematic} = require('../src/core/litematic.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), executable, sample, passed: false, checks: [], errors: [] };

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  let processHandle, browser;
  let stderr = '', stdout = '';
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try {
    const binary = fs.readFileSync(executable);
    report.binaryBytes = binary.length;
    report.binarySha256 = crypto.createHash('sha256').update(binary).digest('hex');
    report.sampleSha256 = crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'litematic-portable-smoke-'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({jarPath: path.resolve(jarPath), resourcePackPath: ''}));
    report.testProfile = profile;
    const port = await unusedPort();
    const env = { ...process.env, LITEMATIC_STUDIO_TEST_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [sample, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
    report.launchArguments = args;
    const started = Date.now();
    processHandle = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    report.wrapperPid = processHandle.pid;
    let launchError;
    processHandle.once('error', error => { launchError = error; });
    processHandle.once('exit', (code, signal) => { report.wrapperExit = { code, signal, at: new Date().toISOString() }; });
    processHandle.stderr.on('data', buffer => { stderr = (stderr + buffer.toString()).slice(-16000); });
    processHandle.stdout.on('data', buffer => { stdout = (stdout + buffer.toString()).slice(-8000); });
    let lastError;
    for (let attempt = 0; Date.now() - started < 60000; attempt++) {
      if (launchError) throw launchError;
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1200 });
        report.connectionAttempts = attempt + 1;
        break;
      } catch (error) { lastError = error.message; await delay(500); }
    }
    assert.ok(browser, `Portable CDP endpoint did not appear within 60 seconds: ${lastError}`);
    report.connectedAfterMs = Date.now() - started;
    let page;
    while (Date.now() - started < 60000) {
      const pages = browser.contexts().flatMap(context => context.pages());
      page = pages.find(candidate => candidate.url().includes('/build/index.html')) || pages[0];
      if (page) break;
      await delay(250);
    }
    assert.ok(page, 'Portable application renderer exists');
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()); });
    await page.waitForFunction(() => window.studio?.getState().data && !window.studio.getState().busy, null, { timeout: 90000 });
    const snapshot = await page.evaluate(() => {
      const state = window.studio.getState();
      return {
        title: document.title,
        rendererUrl: location.href,
        filePath: state.filePath,
        blocks: state.data.blocks.length,
        textures: Object.keys(state.assets.textures).length,
        visible: state.visible.length,
        nbtBlocks: state.data.counts.tileEntities,
        bounds: state.data.bounds,
        assetsSource: state.assets.source || null,
        assetWarnings: state.assets.warnings,
        stats: window.studio.viewer.getStats(),
      };
    });
    const expected = parseLitematic(fs.readFileSync(sample));
    assert.equal(snapshot.blocks, expected.blocks.length);
    assert.equal(snapshot.visible, expected.blocks.length);
    assert.ok(snapshot.textures > 0);
    assert.equal(snapshot.nbtBlocks, expected.counts.tileEntities);
    assert.match(snapshot.rendererUrl, /app\.asar\/build\/index\.html/);
    assert.deepEqual(rendererErrors, []);
    report.checks.push({ name: 'Portable wrapper launches its packaged ASAR and worker, loads user sample and local game textures', passed: true, ...snapshot });
    const png = await page.evaluate(() => window.studio.viewer.capture());
    assert.match(png, /^data:image\/png;base64,/);
    const pngBytes = Buffer.from(png.substring(png.indexOf(',') + 1), 'base64');
    assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(pngBytes.length > 10000);
    report.checks.push({ name: 'Packaged WebGL renderer can export a PNG', passed: true, pngBytes: pngBytes.length,
      width: pngBytes.readUInt32BE(16), height: pngBytes.readUInt32BE(20) });
    report.elapsedMs = Date.now() - started;
    report.rendererErrors = rendererErrors;
    report.passed = true;
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
    process.exitCode = 1;
  } finally {
    // Disconnect this test's CDP session, then terminate only its owned PID tree.
    if (browser) {
      try { await browser.close(); } catch (error) { report.browserCloseError = error.message; }
    }
    if (processHandle?.pid && processHandle.exitCode === null) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
      const decode = buffer => new TextDecoder('gb18030').decode(buffer || Buffer.alloc(0));
      report.cleanup = { ownedWrapperPid: processHandle.pid, method: 'taskkill /PID <owned PID> /T /F', exitCode: killed.status,
        stdout: decode(killed.stdout), stderr: decode(killed.stderr) };
      await delay(200);
    }
    report.processStdout = stdout;
    report.processStderr = stderr;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errors: report.errors,
      binaryBytes: report.binaryBytes, binarySha256: report.binarySha256, output }, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
