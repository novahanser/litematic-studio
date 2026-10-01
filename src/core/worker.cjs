const {parentPort, workerData} = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const {parseLitematic} = require('./litematic.cjs');
const {loadAssets} = require('./assets.cjs');
const {loadEntityAssets} = require('./entity-assets.cjs');
const {readCatalog} = require('./catalog.cjs');
try {
  parentPort.postMessage({progress:'正在解析投影与方块实体…'});
  let buffer=workerData.buffer?Buffer.from(workerData.buffer):fs.readFileSync(workerData.filePath), editSummary;
  if(workerData.operation==='replace'){
    const {replaceBlocks}=require('./document.cjs');
    const original=parseLitematic(buffer),request=workerData.request;
    if(!request||!request.to||typeof request.to.Name!=='string')throw new Error('替换目标无效。');
    const catalog=readCatalog(workerData.jarPath,original.palette,workerData.resourcePackPath),target=catalog.find(x=>x.id===request.to.Name);
    if(!target)throw new Error('本地游戏资源中没有该目标方块。');
    for(const [k,v]of Object.entries(request.to.Properties||{}))if(!target.properties[k]?.includes(String(v)))throw new Error(`目标状态无效：${k}=${v}`);
    const changed=replaceBlocks(buffer,{...request,to:{Name:target.id,Properties:{...target.defaults,...request.to.Properties}},allowedProperties:target.properties});
    buffer=changed.buffer;const {buffer:_,...rest}=changed;editSummary=rest;
  }
  const schematic = parseLitematic(buffer, {fileName:path.basename(workerData.filePath)});
  parentPort.postMessage({progress:'正在读取本地游戏模型和材质…'});
  let assets;
  if (workerData.jarPath) assets = loadAssets(workerData.jarPath, schematic.palette, {resourcePackPath:workerData.resourcePackPath || undefined});
  else assets = {blocks:[], textures:{},lang:{},warnings:['尚未选择 Minecraft 游戏 JAR，当前为占位方块。请在材质设置中选择本地游戏 JAR。']};
  const entityAssets=workerData.jarPath?loadEntityAssets(workerData.jarPath,schematic.entities||[],{resourcePackPath:workerData.resourcePackPath}):{textures:{},entities:[],warnings:[]};
  parentPort.postMessage({result:{schematic,assets,entityAssets,filePath:workerData.filePath,documentBuffer:buffer,editSummary}});
} catch(error) {
  parentPort.postMessage({error:error.message, stack:error.stack});
}
