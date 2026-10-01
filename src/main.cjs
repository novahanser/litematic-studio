const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {discoverGameResources} = require('./core/assets.cjs');
const {DocumentSession}=require('./core/session.cjs');
const {readCatalog}=require('./core/catalog.cjs');
if (process.env.LITEMATIC_STUDIO_TEST_DATA) app.setPath('userData', process.env.LITEMATIC_STUDIO_TEST_DATA);
let win, config = {}, closing=false;
const session=new DocumentSession(()=>({jarPath:config.jarPath,resourcePackPath:config.resourcePackPath}),text=>win?.webContents.send('load-progress',text));
const configFile = () => path.join(app.getPath('userData'), 'settings.json');
function saveConfig() {fs.mkdirSync(app.getPath('userData'), {recursive:true}); fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));}
function realFile(file, extension) {
  if (typeof file !== 'string' || file.length > 32000 || !extension.test(file)) throw new Error('请选择正确的文件类型。');
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('所选路径不是文件。');
  if (stat.size > 512 * 1024 * 1024) throw new Error('文件超过 512 MB，暂不支持。');
  return resolved;
}
async function load(filePath) {
  const file = realFile(filePath, /\.litematic$/i);
  if(!await confirmDiscard())return null;
  const result=await session.load(file);config.lastFile=file;try{saveConfig();}catch{result.schematic.warnings.push('无法保存最近打开的文件设置。');}return result;
}
async function saveDocument(){
  session.requireCurrent();
  const current=session.current.filePath,name=path.basename(current,path.extname(current))+'_edited.litematic';
  const result=await dialog.showSaveDialog(win,{title:'另存替换后的投影',defaultPath:path.join(path.dirname(current),name),filters:[{name:'Litematica 投影',extensions:['litematic']}]});
  if(result.canceled)return null;
  const saved=await session.save(result.filePath);config.lastFile=result.filePath;try{saveConfig();}catch{}return saved;
}
async function confirmDiscard(){
  if(!session.info().dirty)return true;
  const answer=await dialog.showMessageBox(win,{type:'question',title:'当前投影有未保存的替换',message:'是否先另存修改后的投影？',buttons:['另存','放弃修改','取消'],defaultId:0,cancelId:2});
  return answer.response===1||answer.response===0&&!!await saveDocument();
}
function register() {
  ipcMain.handle('get-config', async () => {
    const discovered = await discoverGameResources();
    const candidates = Array.isArray(discovered) ? discovered : discovered.candidates || [];
    if (!config.jarPath || !fs.existsSync(config.jarPath)) {config.jarPath = candidates[0]?.path || ''; saveConfig();}
    const arg = process.argv.find(x => /\.litematic$/i.test(x));
    return {...config,candidates,startupFile:arg || (config.lastFile && fs.existsSync(config.lastFile) ? config.lastFile : '')};
  });
  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(win,{title:'打开 Litematica 投影',filters:[{name:'Litematica 投影',extensions:['litematic']}],properties:['openFile']});
    return result.canceled ? null : load(result.filePaths[0]);
  });
  ipcMain.handle('load-file', (_, file) => load(file));
  ipcMain.handle('reload-current',()=>session.reload());
  ipcMain.handle('replace-blocks',(_,request)=>session.replace(request));
  ipcMain.handle('edit-history',(_,kind)=>{if(!['undo','redo'].includes(kind))throw new Error('无效操作');return session.history(kind);});
  ipcMain.handle('save-litematic',()=>saveDocument());
  ipcMain.handle('block-catalog',()=>{session.requireCurrent();const {parseLitematic}=require('./core/litematic.cjs');return readCatalog(config.jarPath,parseLitematic(session.current.buffer).palette,config.resourcePackPath);});
  ipcMain.handle('choose-resources', async (_, kind) => {
    if (!['jar','pack','clear-pack'].includes(kind)) throw new Error('未知资源类型。');
    if (kind === 'clear-pack') {config.resourcePackPath = ''; saveConfig(); return {...config};}
    const result = await dialog.showOpenDialog(win,{title:kind === 'jar' ? '选择本地 Minecraft 客户端 JAR' : '选择资源包 ZIP',properties:['openFile'],filters:[{name:kind === 'jar' ? 'Minecraft 客户端 JAR' : 'Minecraft 资源包',extensions:[kind === 'jar' ? 'jar' : 'zip']}]});
    if (result.canceled) return null;
    config[kind === 'jar' ? 'jarPath' : 'resourcePackPath'] = realFile(result.filePaths[0], kind === 'jar' ? /\.jar$/i : /\.zip$/i);
    saveConfig(); return {...config};
  });
  ipcMain.handle('use-resource', async (_, file) => {config.jarPath=realFile(file,/\.jar$/i);saveConfig();return {...config};});
  ipcMain.handle('save-export', async (_, request) => {
    if (!request || !['csv','json','png'].includes(request.type)) throw new Error('未知导出格式。');
    const type=request.type;
    if (typeof request.content !== 'string' || request.content.length > 100*1024*1024) throw new Error('导出内容无效或过大。');
    const name=String(request.name || 'export').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,140);
    const result=await dialog.showSaveDialog(win,{defaultPath:`${name}.${type}`,filters:[{name:type.toUpperCase(),extensions:[type]}]});
    if (result.canceled) return null;
    const data=type==='png' ? Buffer.from(request.content.replace(/^data:image\/png;base64,/,''),'base64') : (type==='csv' ? '\ufeff' : '')+request.content;
    await fs.promises.writeFile(result.filePath,data);
    return result.filePath;
  });
  ipcMain.handle('show-export', (_, file) => {if (typeof file==='string' && fs.existsSync(file)) shell.showItemInFolder(file);});
}
app.whenReady().then(() => {
  try {config=JSON.parse(fs.readFileSync(configFile(),'utf8')); if (!config || typeof config !== 'object' || Array.isArray(config)) config={};} catch {config={};}
  register();
  win=new BrowserWindow({width:1540,height:980,minWidth:1050,minHeight:700,backgroundColor:'#0c131b',title:'Litematic Studio · 投影查看器',autoHideMenuBar:true,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}, (_details, callback) => callback({cancel:true}));
  win.setIcon(path.join(__dirname,'../resources/icon.png'));
  win.loadFile(path.join(__dirname,'../build/index.html'));
  win.once('ready-to-show', () => {if (!process.env.LITEMATIC_STUDIO_TEST_DATA) win.show();});
  win.on('close',event=>{if(!closing&&session.info().dirty){event.preventDefault();confirmDiscard().then(ok=>{if(ok){closing=true;win?.close();}}).catch(()=>{});}});
  win.on('closed',()=>{win=null;});
});
app.on('window-all-closed',()=>{session.dispose();app.quit();});
