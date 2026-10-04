import {SchematicViewer} from './viewer.js';
import {EntityPreviewLayer} from './entity-view.js';
import {parseLayers,buildMaterialRows,stacks64,csvCell,matchesSpecial} from '../core/view-model.cjs';
const $=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=value=>Number(value||0).toLocaleString('zh-CN');
const statusNames={filled:'有物品',empty:'已记录为空',unknown:'未知 / 未记录',loot:'待生成战利品'};
let data=null,assets=null,config={},filePath='',selected=null,visible=[],visibleSet=new Set(),selectedNames=new Set(),allNames=[],layerMode='all',customLayers=null,materialRows=[],busy=false,grid=true,toastTimer,filterTimer;
let entityAssets=null,entityLayer=null,selectedEntity=null,documentInfo={},catalog=[],visibleEntities=[];
let viewer;
try {viewer=new SchematicViewer($('viewport'),{onSelect:(_block,index)=>{selectedEntity=null;inspect(index);if(index!=null)showTab('inspect');},onSelectEntity:(_entity,index)=>{inspectEntity(index);showTab('entities');},onProjectionChange:projection=>{$('projection-toggle').textContent=projection==='orthographic'?'正交':'透视';},onStats:s=>{$('render-stats').textContent=`${num(s.meshes)} 批次 · ${num(s.triangles)} 三角形`;}});}catch(error){$('status').textContent='3D 初始化失败：'+error.message;toast('无法创建 3D 视图：'+error.message);}
function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function setBusy(value,text='正在读取…'){busy=value;$('loading').hidden=!value;$('loading-text').textContent=text;$('open-button').disabled=value;$('welcome-open').disabled=value;$('reload-resources').disabled=value;updateDocumentUI();}
function label(id){const key=id.replace(':','.');return assets?.lang?.['block.'+key]||assets?.lang?.['item.'+key]||id.replace(/^minecraft:/,'');}
function stateName(index){return data.palette[data.blocks[index].state].Name;}
function nameMatches(id,search){return !search||id.toLowerCase().includes(search)||label(id).toLowerCase().includes(search);}
function iconFor(id){const state=data?.palette.findIndex(x=>x.Name===id);const a=assets?.blocks?.[state];for(const part of a?.parts||[])for(const element of part.elements||[])for(const face of Object.values(element.faces||{})){const img=assets?.textures?.[face.texture];if(img)return img;}return '';}
function iconHtml(id){const src=iconFor(id);return src?`<img class="swatch" src="${escapeHtml(src)}" alt="">`:'<span class="swatch"></span>';}
function showTab(name){document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('.tab-content').forEach(el=>el.classList.toggle('active',el.id==='tab-'+name));}
async function accept(result,{preserveView=false}={}){
  if(!result)return;
  const cameraState=preserveView&&viewer?{position:viewer.camera.position.clone(),target:viewer.controls.target.clone(),up:viewer.camera.up.clone(),zoom:viewer.camera.zoom,orthoHeight:viewer.orthoHeight,near:viewer.camera.near,far:viewer.camera.far}:null;
  // Array indices may shift after a replacement removes blocks. Region-local
  // identities survive rebuilding the resource meshes and undo/redo.
  const selectedBlock=preserveView&&selected!=null?data?.blocks[selected]:null;
  const selectedObject=preserveView&&selectedEntity!=null?data?.entities[selectedEntity]:null;
  const previousNames=new Set(allNames),previousSelected=new Set(selectedNames),previousY={single:$('single-y').value,min:$('range-min').value,max:$('range-max').value,custom:$('custom-layers').value};
  $('loading-text').textContent='正在构建 3D 模型…';await new Promise(r=>setTimeout(r,30));
  if(viewer) await viewer.setData(result.schematic,result.assets);
  data=result.schematic;assets=result.assets;filePath=result.filePath;selected=null;selectedNames=new Set(data.palette.map(s=>s.Name));allNames=[...new Set(data.blocks.map(b=>data.palette[b.state].Name))].sort((a,b)=>(data.counts.byName[b]||0)-(data.counts.byName[a]||0));
  documentInfo=result.document||{};entityAssets=result.entityAssets||{textures:{},entities:[]};selectedEntity=null;
  entityLayer=new EntityPreviewLayer(data.entities||[],entityAssets,{onChange:()=>viewer?.invalidate()});await entityLayer.ready;viewer?.setEntityLayer(entityLayer);
  const min=data.bounds.min,max=data.bounds.max;
  for(const id of ['single-y','range-min','range-max','layer-slider']){$(id).min=min.y;$(id).max=max.y;}
  $('single-y').value=$('range-min').value=$('layer-slider').value=min.y;$('range-max').value=max.y;$('custom-layers').value=String(min.y);customLayers=new Set([min.y]);
  $('layer-bounds').textContent=`${min.y} — ${max.y}`;
  updateDocumentUI();
  $('file-subtitle').textContent=`${max.x-min.x+1} × ${max.y-min.y+1} × ${max.z-min.z+1} · ${num(data.blocks.length)} 方块 · ${data.regions.length} 区域`;
  $('welcome').hidden=true;
  updatePropertyKeys();
  if(preserveView){selectedNames=new Set(allNames.filter(n=>previousSelected.has(n)||!previousNames.has(n)));$('single-y').value=previousY.single;$('range-min').value=previousY.min;$('range-max').value=previousY.max;$('custom-layers').value=previousY.custom;applyFilters();}
  else resetFilters();
  if(cameraState&&viewer){viewer.stopInertia();viewer.camera.position.copy(cameraState.position);viewer.controls.target.copy(cameraState.target);viewer.camera.up.copy(cameraState.up);viewer.camera.zoom=cameraState.zoom;viewer.orthoHeight=cameraState.orthoHeight;viewer.camera.near=cameraState.near;viewer.camera.far=Math.max(cameraState.far,viewer.camera.far);viewer.resize();viewer.controls.update();viewer.invalidate();}
  inspect(null);$('entity-inspector').innerHTML='';
  if(selectedBlock){const index=data.blocks.findIndex(b=>b.region===selectedBlock.region&&b.localIndex===selectedBlock.localIndex);if(index>=0)inspect(index);}
  else if(selectedObject){const index=data.entities.findIndex(e=>e.region===selectedObject.region&&e.localIndex===selectedObject.localIndex);if(index>=0){inspectEntity(index);if(viewer)viewer.selectedEntityIndex=index;}}
  updateResourceUI();
  const nbtCount=data.blocks.filter(b=>b.nbt!=null).length;
  $('status').textContent=`已载入 ${num(data.blocks.length)} 个方块 · ${allNames.length} 种 · ${num(nbtCount)} 条方块 NBT`;
  $('resource-status').textContent=assets.source ? `材质：Minecraft ${assets.source.version}${assets.source.resourcePackPath?' + 资源包':''}`:'未配置材质 · 打开材质设置';
  const warnings=[...(data.warnings||[]),...(assets.warnings||[]),...(entityAssets.warnings||[])];
  if(warnings.length)toast(`投影已载入，${warnings.length} 条模型或文件提示可在「材质设置」查看。`);
}
async function performLoad(action,options){if(busy)return;setBusy(true);try{const result=await action();await accept(result,options);return result;}catch(error){$('status').textContent='打开失败：'+error.message;toast(error.message);}finally{setBusy(false);}}
function openFile(){return performLoad(()=>window.desktop.openFile());}
function resetFilters(){
  selectedNames=new Set(allNames);$('block-search').value='';$('nbt-only').checked=false;$('containers-only').checked=false;$('container-filter').value='all';$('special-filter').value='all';$('property-key').value='';updatePropertyValues();setLayerMode('all',false);applyFilters();
}
function setLayerMode(mode,apply=true){layerMode=mode;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));for(const m of ['single','range','custom'])$('layer-'+m).hidden=m!==mode;$('layer-error').hidden=true;if(apply)applyFilters();}
function layerPredicate(){
  const min=data.bounds.min.y,max=data.bounds.max.y;
  if(layerMode==='single'){
    const y=Number($('single-y').value);if(!Number.isInteger(y)||y<min||y>max)throw new Error(`层数必须在 ${min} 到 ${max} 之间。`);
    $('layer-slider').value=y;$('layer-summary').textContent=`只显示 Y = ${y}`;return b=>b.y===y;
  }
  if(layerMode==='range'){
    const a=Number($('range-min').value),b=Number($('range-max').value);if(!Number.isInteger(a)||!Number.isInteger(b)||a<min||b>max||a>b)throw new Error(`范围须递增，且位于 ${min} 到 ${max} 之间。`);
    $('layer-summary').textContent=`显示 Y = ${a} 至 ${b} · ${b-a+1} 层`;return block=>block.y>=a&&block.y<=b;
  }
  if(layerMode==='custom'){customLayers=parseLayers($('custom-layers').value,min,max);$('layer-summary').textContent=`显示 ${customLayers.size} 个所选层`;return b=>customLayers.has(b.y);}
  $('layer-summary').textContent=`显示全部 ${max-min+1} 层`;return()=>true;
}
function applyFilters(){
  if(!data)return;
  let yTest;try{yTest=layerPredicate();$('layer-error').hidden=true;}catch(error){$('layer-error').textContent=error.message;$('layer-error').hidden=false;return;}
  const nbt=$('nbt-only').checked,containers=$('containers-only').checked,status=$('container-filter').value,special=$('special-filter').value,key=$('property-key').value,value=$('property-value').value;
  visible=[];data.blocks.forEach((b,i)=>{const s=data.palette[b.state];if(selectedNames.has(s.Name)&&yTest(b)&&(!nbt||b.nbt!=null)&&(!containers||b.container)&&(status==='all'||b.container?.status===status)&&matchesSpecial(s,special)&&(!key||Object.hasOwn(s.Properties||{},key)&&(value===''||s.Properties[key]===value)))visible.push(i);});
  visibleSet=new Set(visible);viewer?.setVisible(visible);
  $('view-summary').textContent=`${num(visible.length)} / ${num(data.blocks.length)} 方块`;
  $('view-summary').title=`显示 ${num(visible.length)} 方块；${selectedNames.size} 种方块已勾选`;
  renderBlocks();materialRows=buildMaterialRows(data,visibleSet);renderMaterials();renderContainers();
  visibleEntities=(data.entities||[]).map((_,i)=>i).filter(i=>{const p=data.entities[i].position;return p&&['x','y','z'].every(a=>Number.isFinite(p[a]))?yTest({y:Math.floor(p.y)}):layerMode==='all';});viewer?.setEntityFilter({enabled:$('show-entities').checked,indices:visibleEntities});renderEntities();
  if(selected!=null)inspect(selected,false);
}
function scheduleFilters(){clearTimeout(filterTimer);filterTimer=setTimeout(applyFilters,80);}
function renderBlocks(){
  if(!data)return;
  const query=$('block-search').value.trim().toLowerCase();
  $('types-count').textContent=`${allNames.filter(n=>selectedNames.has(n)).length} / ${allNames.length}`;
  $('block-list').innerHTML=allNames.filter(id=>nameMatches(id,query)).map(id=>`<div class="block-row ${selectedNames.has(id)?'':'unchecked'}" data-name="${escapeHtml(id)}"><input type="checkbox" aria-label="显示 ${escapeHtml(label(id))}" ${selectedNames.has(id)?'checked':''}>${iconHtml(id)}<span class="block-name" title="${escapeHtml(id)}">${escapeHtml(label(id))}</span><span class="block-count">${num(data.counts.byName[id])}</span><button class="only-button" title="只显示此种方块">仅此</button></div>`).join('')||'<p class="empty-small">没有匹配的方块</p>';
}
function inspect(index,selectInViewer=true){
  selected=index;
  if(index==null||!data?.blocks[index]){$('inspector').innerHTML='<div class="empty-state"><span>⌖</span><h3>点选一个方块</h3><p>查看坐标、朝向、状态属性、<br>NBT 标签和容器内容。</p></div>';$('selection-badge').hidden=true;if(selectInViewer)viewer?.select(null);return;}
  const b=data.blocks[index],s=data.palette[b.state],container=b.container;
  if(selectInViewer)viewer?.select(index);
  for(const a of ['x','y','z'])$('jump-'+a).value=b[a];
  $('selection-badge').hidden=false;$('selection-badge').textContent=`${label(s.Name)} · ${b.x}, ${b.y}, ${b.z}${visibleSet.has(index)?'':' · 已被筛选隐藏'}`;
  let html=`<h2 class="block-title">${escapeHtml(label(s.Name))}</h2><div class="block-id">${escapeHtml(s.Name)}</div><div class="position-line"><span>X ${b.x}</span><span>Y ${b.y}</span><span>Z ${b.z}</span></div><div class="section-label">状态属性</div><div class="property-list">${Object.entries(s.Properties||{}).map(([k,v])=>`<div class="property-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('')||'<p class="hint">此方块没有额外状态属性。</p>'}</div><div class="property-row"><span>区域</span><span>${escapeHtml(typeof b.region==='number'?data.regions[b.region]?.name:b.region)}</span></div><button id="focus-selected" class="secondary wide">聚焦此方块</button>`;
  if(!visibleSet.has(index))html+='<p class="hint">此方块当前被筛选隐藏。可重置筛选后查看。</p>';
  const renderAsset=assets?.blocks?.[b.state];
  if(renderAsset?.resourceName&&renderAsset.resourceName!==s.Name)html+=`<div class="inspect-section"><div class="section-label">显示资源</div><div class="block-id">${escapeHtml(renderAsset.resourceName)}</div><p class="hint">使用兼容的资源名称显示；投影中的方块 ID 保持不变。</p></div>`;
  if(renderAsset?.fallbackReason)html+=`<div class="inspect-section"><div class="section-label">预览说明</div><p class="hint">${escapeHtml(renderAsset.fallbackReason)}</p></div>`;
  if(container){html+=`<div class="inspect-section"><div class="section-label">容器内容</div><span class="status-pill ${container.status}">${statusNames[container.status]}</span><p class="hint">${escapeHtml(container.reason||`${container.occupiedSlots} 个有物品槽位 · 共 ${num(container.itemCount)} 件物品`)}</p>${container.lootTable?`<div class="block-id">${escapeHtml(container.lootTable)}</div>`:''}${container.items.map(item=>`<div class="item-row"><span>槽 ${item.slot}</span><strong title="${escapeHtml(item.id)}">${escapeHtml(label(item.id))}</strong><em>×${num(item.count)}</em></div>`).join('')}</div>`;}
  html+=`<div class="inspect-section"><div class="section-label"><span>方块实体 NBT</span>${b.nbt!=null?'<button id="export-nbt" class="text-button">导出 JSON ↗</button>':''}</div>${b.nbt!=null?`<p class="hint">完整值保留；Long 以十进制字符串表示，原标签类型见下方。</p><pre class="nbt">${escapeHtml(JSON.stringify(b.nbt,null,2))}</pre><details><summary>查看原始 NBT 标签类型</summary><pre class="nbt">${escapeHtml(JSON.stringify(b.nbtTypes,null,2))}</pre></details>`:'<p class="hint">投影未记录此方块的方块实体 NBT。方块状态已显示在上方。</p>'}</div>`;
  $('inspector').innerHTML=html;
  $('focus-selected').onclick=()=>{viewer?.focus(index);if(!visibleSet.has(index))toast('该方块被当前筛选隐藏，可点击左侧「重置」。');};
  if($('export-nbt'))$('export-nbt').onclick=()=>saveExport({type:'json',name:`NBT_${b.x}_${b.y}_${b.z}`,content:JSON.stringify({position:{x:b.x,y:b.y,z:b.z},block:s,nbt:b.nbt,types:b.nbtTypes},null,2)});
}
function renderMaterials(){
  const scope=$('material-scope').value==='visible'?'visible':'total',query=$('material-search').value.trim().toLowerCase();
  const rows=materialRows.filter(r=>r[scope]>0&&nameMatches(r.id,query));
  $('material-summary').textContent=`${rows.length} 种材料 · ${num(rows.reduce((s,r)=>s+r[scope],0))} 件`;
  $('material-list').innerHTML=rows.map(r=>`<div class="material-row"><div class="material-name"><div class="name">${escapeHtml(label(r.id))}</div><small>${escapeHtml(r.id)}</small></div><div class="quantity"><strong>${num(r[scope])}</strong><small>${stacks64(r[scope])}</small></div></div>`).join('')||'<p class="empty-small">当前范围没有材料</p>';
}
let containerPageSize=180;
function renderContainers(){
  if(!data)return;
  const all=visible.filter(i=>data.blocks[i].container),filter=$('container-list-filter').value,q=$('container-search').value.trim().toLowerCase();
  const filled=all.filter(i=>data.blocks[i].container.status==='filled').length;
  const rows=all.filter(i=>{const b=data.blocks[i];return (filter==='all'||b.container.status===filter)&&(nameMatches(stateName(i),q)||`${b.x},${b.y},${b.z}`.includes(q));});
  $('container-summary').textContent=`${num(all.length)} 个可存物方块 · ${filled} 个有物品`;
  $('container-list').innerHTML=rows.slice(0,containerPageSize).map(i=>{const b=data.blocks[i],c=b.container;return `<button class="container-row" data-index="${i}"><b>${escapeHtml(label(stateName(i)))}</b><span class="status-pill ${c.status}">${statusNames[c.status]}</span><span class="item-count">${c.itemCount?num(c.itemCount)+' 件':''}</span><span class="position">X ${b.x} &nbsp; Y ${b.y} &nbsp; Z ${b.z}</span></button>`;}).join('')+(rows.length>containerPageSize?`<button id="more-containers" class="secondary wide">加载更多 (${num(rows.length-containerPageSize)})</button>`:'')||'<p class="empty-small">没有匹配的容器</p>';
  if($('more-containers'))$('more-containers').onclick=()=>{containerPageSize+=180;renderContainers();};
}
async function saveExport(request){try{const dest=await window.desktop.saveExport(request);if(dest)toast('已导出：'+dest);}catch(error){toast('导出失败：'+error.message);}}
function exportMaterials(){if(!data)return;const scope=$('material-scope').value==='visible'?'visible':'total';const rows=[['材料','物品ID','数量','整组(64)','余数','范围'],...materialRows.filter(r=>r[scope]>0).map(r=>[label(r.id),r.id,r[scope],Math.floor(r[scope]/64),r[scope]%64,scope==='visible'?'当前可见':'整个投影'])];saveExport({type:'csv',name:'材料列表_'+(scope==='visible'?'当前可见':'全部'),content:rows.map(r=>r.map(csvCell).join(',')).join('\r\n')});}
function updateResourceUI(){
  $('current-jar').textContent=config.jarPath||assets?.source?.path||'尚未选择';$('current-pack').textContent=config.resourcePackPath||'使用原版资源';
  const candidates=config.candidates||[];$('detected-jars').innerHTML=candidates.map((c,i)=>`<option value="${i}">${escapeHtml(c.version||c.path)}</option>`).join('')||'<option>没有自动检测到版本</option>';$('use-detected').disabled=!candidates.length;
  const warnings=[...(data?.warnings||[]),...(assets?.warnings||[]),...(entityAssets?.warnings||[])];$('warnings-count').textContent=warnings.length;$('warnings-list').innerHTML=warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join('')||'<li>暂无提示</li>';
}
function updateDocumentUI(){
  $('replace-button').disabled=!data||busy;$('save-document').disabled=!data||busy;$('undo-button').disabled=!documentInfo.canUndo||busy;$('redo-button').disabled=!documentInfo.canRedo||busy;
  if(filePath){$('file-title').textContent=(documentInfo.dirty?'● ':'')+filePath.split(/[\\/]/).pop();$('file-title').title=filePath;$('file-title').classList.toggle('unsaved',!!documentInfo.dirty);}
}
function updatePropertyKeys(){
  const previous=$('property-key').value,keys=[...new Set((data?.palette||[]).flatMap(s=>Object.keys(s.Properties||{})))].sort();
  $('property-key').innerHTML='<option value="">不限属性</option>'+keys.map(k=>`<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');if(keys.includes(previous))$('property-key').value=previous;updatePropertyValues();
}
function updatePropertyValues(){const key=$('property-key').value,previous=$('property-value').value,values=[...new Set((data?.palette||[]).map(s=>s.Properties?.[key]).filter(v=>v!=null))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));$('property-value').innerHTML='<option value="">任意值</option>'+values.map(v=>`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');if(values.includes(previous))$('property-value').value=previous;}
function entityLabel(index){return entityAssets?.entities?.[index]?.label||assets?.lang?.['entity.'+data.entities[index].id.replace(':','.')]||data.entities[index].id;}
function renderEntities(){
  if(!data)return;const q=$('entity-search').value.trim().toLowerCase();
  $('entity-summary').textContent=`${visibleEntities.length} / ${(data.entities||[]).length} 个实体`;
  $('entity-list').innerHTML=visibleEntities.filter(i=>!q||entityLabel(i).toLowerCase().includes(q)||data.entities[i].id.includes(q)).map(i=>{const e=data.entities[i],p=e.position,position=p?`${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`:'位置无效 · 可查看 NBT';return `<button class="entity-row ${selectedEntity===i?'active':''}" data-entity="${i}"><div>${escapeHtml(entityLabel(i))}<small>${position}</small></div><span>↗</span></button>`;}).join('')||'<p class="empty-small">投影中没有符合条件的已保存实体</p>';
}
function inspectEntity(index){
  if(!data?.entities?.[index])return;selectedEntity=index;selected=null;viewer?.select(null);const e=data.entities[index],p=e.position;
  $('selection-badge').hidden=false;$('selection-badge').textContent=`${entityLabel(index)} · ${p?`${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`:'位置无效，仅查看 NBT'}`;
  $('entity-inspector').innerHTML=`<div class="inspect-section"><h2 class="block-title">${escapeHtml(entityLabel(index))}</h2><div class="block-id">${escapeHtml(e.id)}</div><div class="section-label"><span>实体 NBT</span><button id="export-entity-nbt" class="text-button">导出 JSON ↗</button></div><pre class="nbt">${escapeHtml(JSON.stringify(e.nbt,null,2))}</pre><details><summary>原始标签类型</summary><pre class="nbt">${escapeHtml(JSON.stringify(e.nbtTypes,null,2))}</pre></details></div>`;
  $('export-entity-nbt').onclick=()=>saveExport({type:'json',name:`entity_${e.id.replace(':','_')}_${index}`,content:JSON.stringify(e,null,2)});renderEntities();
}
async function saveSchematic(){if(busy||!data)return;setBusy(true,'正在另存投影…');try{const result=await window.desktop.saveLitematic();if(result){documentInfo=result;filePath=result.filePath;updateDocumentUI();toast('已另存投影：'+result.savedPath);}}catch(e){toast('保存失败：'+e.message);}finally{setBusy(false);}}
async function editHistory(kind){if(busy)return;const result=await performLoad(()=>window.desktop.editHistory(kind),{preserveView:true});if(result)toast(kind==='undo'?'已撤销替换':'已重做替换');}
function replacementNames(){return $('replace-source').value==='__selected__'?[...selectedNames]:[$('replace-source').value];}
function replacementIndices(){if(!data)return[];const names=new Set(replacementNames()),base=$('replace-scope').value==='visible'?visible:data.blocks.map((_,i)=>i);return base.filter(i=>names.has(data.palette[data.blocks[i].state].Name));}
function targetEntry(){const text=$('replace-target').value.trim();return catalog.find(c=>c.id===text||c.id==='minecraft:'+text||label(c.id)===text);}
function updateReplaceSummary(){
  const indices=replacementIndices(),nbt=indices.filter(i=>data.blocks[i].nbt!=null).length,target=targetEntry();
  $('replace-summary').textContent=`将影响 ${num(indices.length)} 个方块${nbt?`，其中 ${num(nbt)} 个带有 NBT`:' '}。${target?'目标：'+label(target.id):'请选择有效的目标方块。'}`;
  $('apply-replace').textContent=`替换 ${num(indices.length)} 个方块`;$('apply-replace').disabled=!target||!indices.length||busy;
}
function updateTargetProperties(){const target=targetEntry();$('target-properties').innerHTML=target?Object.entries(target.properties).map(([key,values])=>`<label>${escapeHtml(key)}<select data-target-prop="${escapeHtml(key)}">${values.map(v=>`<option value="${escapeHtml(v)}" ${target.defaults[key]===v?'selected':''}>${escapeHtml(v)}</option>`).join('')}</select></label>`).join(''):'';updateReplaceSummary();}
async function openReplace(){
  if(!data||busy)return;try{catalog=await window.desktop.blockCatalog();$('replace-source').innerHTML='<option value="__selected__">左侧勾选的所有方块种类</option>'+allNames.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(label(n))} (${num(data.counts.byName[n])})</option>`).join('');$('replace-source').value=selected!=null?stateName(selected):selectedNames.size===1?[...selectedNames][0]:allNames[0];$('replace-scope').value='visible';$('block-catalog').innerHTML=catalog.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(label(c.id))}</option>`).join('');if(!targetEntry())$('replace-target').value='minecraft:stone';$('replace-error').hidden=true;updateTargetProperties();$('replace-dialog').showModal();}catch(e){toast('无法读取方块目录：'+e.message);}
}
async function applyReplacement(){
  const target=targetEntry();if(!target)return;const indices=replacementIndices();if(!indices.length)return;
  const properties=Object.fromEntries([...document.querySelectorAll('[data-target-prop]')].map(el=>[el.dataset.targetProp,el.value]));
  const request={fromNames:replacementNames(),to:{Name:target.id,Properties:properties},scope:$('replace-scope').value==='visible'?indices.map(i=>({region:data.blocks[i].region,localIndex:data.blocks[i].localIndex})):undefined,preserveProperties:$('preserve-properties').checked};
  $('replace-dialog').close();
  const result=await performLoad(()=>window.desktop.replaceBlocks(request),{preserveView:true});
  if(result){const summary=result.editSummary;toast(`已替换 ${num(summary.changed)} 个方块${summary.removedBlockEntities?`，移除 ${summary.removedBlockEntities} 条不兼容方块 NBT`:''}。可撤销，另存后写入磁盘。`);$('status').textContent=`已替换 ${num(summary.changed)} 个方块 · ${documentInfo.dirty?'尚未另存':'无内容变化'}`;}
}
async function changeResources(kind){try{const changed=await window.desktop.chooseResources(kind);if(changed){config={...config,...changed};updateResourceUI();}}catch(error){toast(error.message);}}
$('open-button').onclick=$('welcome-open').onclick=openFile;
$('reset-filters').onclick=resetFilters;
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>setLayerMode(b.dataset.mode));
for(const id of ['single-y','range-min','range-max'])$(id).addEventListener('input',scheduleFilters);
$('layer-slider').oninput=()=>{$('single-y').value=$('layer-slider').value;scheduleFilters();};
for(const [id,delta] of [['layer-prev',-1],['layer-next',1]])$(id).onclick=()=>{if(!data)return;const y=Math.max(data.bounds.min.y,Math.min(data.bounds.max.y,Number($('single-y').value)+delta));$('single-y').value=y;applyFilters();};
$('apply-layers').onclick=applyFilters;$('custom-layers').onkeydown=e=>{if(e.key==='Enter')applyFilters();};
for(const id of ['nbt-only','containers-only','container-filter','special-filter','property-value'])$(id).onchange=applyFilters;
$('property-key').onchange=()=>{updatePropertyValues();applyFilters();};
$('block-search').oninput=renderBlocks;
$('select-all').onclick=()=>{selectedNames=new Set(allNames);applyFilters();};$('select-none').onclick=()=>{selectedNames.clear();applyFilters();};
$('block-list').addEventListener('click',e=>{const row=e.target.closest('.block-row');if(!row)return;const id=row.dataset.name;if(e.target.closest('.only-button'))selectedNames=new Set([id]);else if(e.target.matches('input')||e.target.closest('.block-name')){if(selectedNames.has(id))selectedNames.delete(id);else selectedNames.add(id);}else return;applyFilters();});
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$('material-scope').onchange=$('material-search').oninput=renderMaterials;$('export-materials').onclick=exportMaterials;
$('container-list-filter').onchange=$('container-search').oninput=()=>{containerPageSize=180;renderContainers();};
$('container-list').onclick=e=>{const row=e.target.closest('[data-index]');if(row){const i=Number(row.dataset.index);inspect(i);showTab('inspect');viewer?.focus(i);}};
$('entity-search').oninput=renderEntities;$('show-entities').onchange=applyFilters;
$('entity-list').onclick=e=>{const row=e.target.closest('[data-entity]');if(row){const i=Number(row.dataset.entity);inspectEntity(i);viewer?.focusEntity(i);}};
$('entities-isolate').onclick=()=>{selectedNames.clear();$('show-entities').checked=true;applyFilters();};
$('replace-button').onclick=openReplace;$('save-document').onclick=saveSchematic;$('undo-button').onclick=()=>editHistory('undo');$('redo-button').onclick=()=>editHistory('redo');
$('replace-source').onchange=$('replace-scope').onchange=updateReplaceSummary;$('replace-target').oninput=updateTargetProperties;$('apply-replace').onclick=applyReplacement;
$('projection-toggle').onclick=()=>viewer?.setProjection(viewer.getProjection()==='perspective'?'orthographic':'perspective');$('navigation-help').onclick=()=>$('navigation-dialog').showModal();
$('jump-button').onclick=()=>{if(!data)return;const raw=['x','y','z'].map(a=>$('jump-'+a).value.trim()),coord=raw.map(Number);if(raw.some(x=>!x)||!coord.every(Number.isInteger)){toast('请输入完整的整数坐标');return;}const i=data.blocks.findIndex(b=>b.x===coord[0]&&b.y===coord[1]&&b.z===coord[2]);if(i<0){toast('此坐标没有非空气方块');return;}inspect(i);viewer?.focus(i);};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{viewer?.view(b.dataset.view);document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));});
$('zoom-in').onclick=()=>viewer?.zoom(1.3);$('zoom-out').onclick=()=>viewer?.zoom(1/1.3);$('fit').onclick=()=>viewer?.fit();
$('grid-toggle').onclick=()=>{grid=!grid;viewer?.setGrid(grid);$('grid-toggle').classList.toggle('active',grid);};
$('screenshot').onclick=()=>{if(!data||!viewer)return;try{saveExport({type:'png',name:'投影视图',content:viewer.capture()});}catch(error){toast('截图失败：'+error.message);}};
$('resources-button').onclick=()=>{updateResourceUI();$('resources-dialog').showModal();};
$('choose-jar').onclick=()=>changeResources('jar');$('choose-pack').onclick=()=>changeResources('pack');$('clear-pack').onclick=()=>changeResources('clear-pack');
$('use-detected').onclick=async()=>{const candidate=config.candidates?.[Number($('detected-jars').value)];if(candidate){try{config={...config,...await window.desktop.useResource(candidate.path)};updateResourceUI();}catch(error){toast(error.message);}}};
$('reload-resources').onclick=()=>{$('resources-dialog').close();if(filePath)performLoad(()=>window.desktop.reloadCurrent(),{preserveView:true});else toast('材质设置已保存，请打开投影。');};
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select')||document.querySelector('dialog[open]'))return;const key=e.key.toLowerCase();if(e.ctrlKey||e.metaKey){if(key==='o'){e.preventDefault();openFile();}else if(key==='s'){e.preventDefault();saveSchematic();}else if(key==='z'){e.preventDefault();editHistory(e.shiftKey?'redo':'undo');}else if(key==='y'){e.preventDefault();editHistory('redo');}return;}if(e.key==='+'||e.key==='=')viewer?.zoom(1.3);else if(e.key==='-')viewer?.zoom(1/1.3);else if(key==='f')viewer?.fit();});
let dragDepth=0;document.addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;$('drop-overlay').hidden=false;});document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;$('drop-overlay').hidden=true;}});document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;const file=e.dataTransfer.files[0];if(!file)return;const path=window.desktop.droppedPath(file);if(!/\.litematic$/i.test(path)){toast('请拖入 .litematic 投影文件');return;}performLoad(()=>window.desktop.loadFile(path));});
window.desktop.onProgress(text=>{$('loading-text').textContent=text;});
window.studio=Object.freeze({getState:()=>({data,assets,entityAssets,visible:[...visible],visibleEntities:[...visibleEntities],selected,selectedEntity,filePath,busy,layerMode,document:documentInfo}),viewer});
(async()=>{try{config=await window.desktop.getConfig();updateResourceUI();if(config.startupFile)await performLoad(()=>window.desktop.loadFile(config.startupFile));}catch(error){toast(error.message);}})();
