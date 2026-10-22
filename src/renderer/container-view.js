import './container-view.css';
import { inventoryKey } from '../core/inventory-key.cjs';
import { hydrateInventoryIcons } from './inventory-icons.js';

const TEXT = {
  zh_cn: { title: '容器内容', filled: '有物品', empty: '已记录为空', unknown: '内容未知', loot: '待生成战利品', mixed: '两侧记录不同', conflict: '槽位记录冲突',
    slot: '槽位', sourceSlot: '原槽位', recorded: '投影中已记录的内容；不是服务器实时库存。', count: '{slots} / {capacity} 个有物品槽位 · 共 {count} 件已记录物品',
    missing_nbt: '没有保存方块 NBT，无法判断内容。', missing_inventory: 'NBT 中没有物品列表，无法确认是否为空。', ender: '末影箱库存属于玩家数据，方块 NBT 不包含玩家物品。',
    invalid_inventory: '有无效物品记录，不能据此确认其余槽位为空。', loot_note: '保存了战利品表；尚未生成的物品不会显示成空槽。',
    no_screen: '此方块没有容器背包界面，按保存的槽位展示。', generic: '此类容器的容量未知；这里只展示保存的槽号，不能推断实际空槽数量。',
    missing_partner: '未找到同区域内匹配的另一半箱子；仅展示这一半的 27 个槽位。', ambiguous_partner: '同区域存在重叠箱子，无法可靠合并；仅展示当前半箱。',
    combined: '已合并同区域内相邻双箱：上 3 排来自 right，下 3 排来自 left。', right: 'right 半箱', left: 'left 半箱',
    input: '输入', fuel: '燃料', output: '输出', ingredient: '酿造材料', bottle: '药水瓶', disabled: '已禁用',
    select: '点击槽位查看名称、数量和原始物品 NBT。', empty_slot: '此槽位在已保存物品列表中为空。', unknown_slot: '未记录此槽位的内容。',
    loot_slot: '战利品尚未生成，无法判断此槽位。', anomalies: '异常记录（全部保留）', out_of_range: '槽号超出容器范围', duplicate_slot: '同一槽号出现多条物品记录',
    missing_slot: '未保存槽号，暂按列表顺序定位', disabled_occupied: '禁用槽内仍有保存的物品', invalid_item: '物品记录无效', invalid_list: '物品列表格式无效',
    item_nbt: '原始物品 NBT', raw_record: '原始记录', missing_icon: '没有可用的本地图标', crafter_result: '右侧为游戏的配方结果预览位置；投影没有保存配方计算结果。',
    total_records: '{count} 条记录', region: '区域', unknown_name: '未知物品', unavailable: '未记录', approximate_icon: '图标为近似外观',
    potion_effect_color: '未还原自定义药水效果的混合颜色', banner_patterns: '未绘制旗帜图案', player_profile: '未加载玩家皮肤',
    enchantment_glint: '未绘制附魔光效', special_model_pose: '特殊物品姿态为近似', unsupported_property: '部分物品显示属性尚未还原',
    armor_trim: '未绘制盔甲纹饰', dyed_color: '未还原染色', charged_projectiles: '未还原装填弹药外观',
    pot_decorations: '未绘制陶罐纹样', mixed_model_layers: '资源包的混合模型图层为近似', potion_palette_version: '此游戏版本的药水颜色尚未核验',
  },
  en_us: { title: 'Container contents', filled: 'Contains items', empty: 'Recorded empty', unknown: 'Unknown contents', loot: 'Loot not generated', mixed: 'Different records in each half', conflict: 'Conflicting slot records',
    slot: 'Slot', sourceSlot: 'Original slot', recorded: 'Saved schematic contents, not the live server inventory.', count: '{slots} / {capacity} occupied slots · {count} recorded items',
    missing_nbt: 'Block NBT was not saved, so the contents are unknown.', missing_inventory: 'NBT has no item list; empty contents cannot be confirmed.', ender: 'Ender chest inventory belongs to the player and is not stored in block NBT.',
    invalid_inventory: 'Invalid item records prevent confirming the remaining slots are empty.', loot_note: 'A loot table is saved. Ungenerated loot is not shown as empty slots.',
    no_screen: 'This block has no container inventory screen. Saved slots are shown below.', generic: 'The capacity of this container is unknown. Only saved slot numbers are shown; unused slots cannot be inferred.',
    missing_partner: 'No matching half was found in the same region. Only this half’s 27 slots are shown.', ambiguous_partner: 'Overlapping chests in this region make pairing ambiguous. Only the selected half is shown.',
    combined: 'Adjacent chests in the same region are combined: top 3 rows are right, bottom 3 rows are left.', right: 'right half', left: 'left half',
    input: 'Input', fuel: 'Fuel', output: 'Output', ingredient: 'Ingredient', bottle: 'Bottle', disabled: 'Disabled',
    select: 'Select a slot to inspect the item name, count and original NBT.', empty_slot: 'This slot is empty in the saved item list.', unknown_slot: 'The contents of this slot were not recorded.',
    loot_slot: 'Loot has not been generated; this slot is unknown.', anomalies: 'Unusual records (all preserved)', out_of_range: 'Slot outside container range', duplicate_slot: 'Multiple stacks use this slot',
    missing_slot: 'No slot number; provisionally placed by list order', disabled_occupied: 'A disabled slot contains a saved item', invalid_item: 'Invalid item record', invalid_list: 'Invalid inventory list',
    item_nbt: 'Original item NBT', raw_record: 'Original record', missing_icon: 'No local icon available', crafter_result: 'The right side is the game’s recipe result preview. The schematic does not contain a calculated recipe result.',
    total_records: '{count} records', region: 'Region', unknown_name: 'Unknown item', unavailable: 'Not recorded', approximate_icon: 'Approximate item appearance',
    potion_effect_color: 'Custom potion effect color is not reproduced', banner_patterns: 'Banner patterns are not drawn', player_profile: 'Player skin is not loaded',
    enchantment_glint: 'Enchantment glint is not drawn', special_model_pose: 'Special item pose is approximate', unsupported_property: 'Some item display properties are not reproduced',
    armor_trim: 'Armor trim is not drawn', dyed_color: 'Dyed color is not reproduced', charged_projectiles: 'Loaded projectile appearance is not reproduced',
    pot_decorations: 'Decorated pot patterns are not drawn', mixed_model_layers: 'Mixed resource-pack model layers are approximate', potion_palette_version: 'Potion colors have not been verified for this game version',
  },
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function context(options = {}) {
  const locale = options.locale === 'en_us' ? 'en_us' : 'zh_cn';
  return { locale, itemAssets: options.itemAssets, label: options.label || (id => id), number: n => Number(n || 0).toLocaleString(locale === 'en_us' ? 'en-US' : 'zh-CN'),
    t: (key, values = {}) => (TEXT[locale][key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '') };
}
function frameFor(layout, itemAssets) {
  const name = layout.sources[0]?.name?.split(':').pop() || '';
  let key, x = 0, y = 0, height, topHeight;
  if (layout.kind === 'storage' || layout.kind === 'double_chest') {
    key = name.endsWith('shulker_box') ? 'shulker_box' : 'generic_54'; x = 7; y = 17;
    topHeight = 17 + layout.height; height = topHeight + 7;
  } else if (layout.kind === 'hopper') { key = 'hopper'; x = 43; y = 19; height = 45; }
  else if (layout.kind === 'dispenser') { key = 'dispenser'; x = 61; y = 16; height = 78; }
  else if (layout.kind === 'crafter') { key = 'crafter'; x = 25; y = 16; height = 78; }
  else if (layout.kind === 'furnace') { key = ['blast_furnace', 'smoker'].includes(name) ? name : 'furnace'; x = 37; y = 16; height = 78; }
  else if (layout.kind === 'brewing') { key = 'brewing_stand'; x = 16; y = 16; height = 80; }
  const image = key && itemAssets?.gui?.[key];
  if (!image || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image)) return { width: Math.max(layout.width + 14, 32), height: layout.height + 14, x: 7, y: 7, local: false };
  // Menu blits use a 256-unit reference sheet even when a pack replaces the
  // PNG with a higher-resolution image. Do not shift slots for 2x/4x packs.
  return { width: 176, height, x, y, local: true, image, sourceWidth: 256, sourceHeight: 256,
    topHeight: key === 'generic_54' ? topHeight : height, bottomSourceY: 125 };
}
function plainName(value, depth = 0) {
  if (depth > 16 || value == null) return '';
  if (typeof value === 'string') { if (value.length > 4096) return value.slice(0, 4096); try { const parsed = JSON.parse(value); if (parsed !== value) return plainName(parsed, depth + 1); } catch {} return value; }
  if (Array.isArray(value)) return value.slice(0, 64).map(v => plainName(v, depth + 1)).join('').slice(0, 4096);
  if (typeof value === 'object') return ((typeof value.text === 'string' ? value.text : '') + plainName(value.extra, depth + 1)).slice(0, 4096);
  return '';
}
function itemLabel(item, ctx) {
  const raw = item.nbt || item, components = raw.components || {}, custom = plainName(components['minecraft:custom_name'] ?? raw.tag?.display?.Name);
  if (custom) return custom;
  const potion = components['minecraft:potion_contents']?.potion ?? raw.tag?.Potion;
  if (/^minecraft:(?:potion|splash_potion|lingering_potion|tipped_arrow)$/.test(item.id) && typeof potion === 'string' && potion.startsWith('minecraft:')) {
    const key = item.id + '.effect.' + potion.slice(10).replace(/^(?:long_|strong_)/, ''), label = ctx.label(key);
    if (label && label !== key && label !== key.replace(/^minecraft:/, '')) return label;
  }
  return ctx.label(item.id) || item.id;
}
function itemMark(item, ctx) {
  const id = item?.id || '', label = itemLabel(item, ctx);
  return `<span class="inventory-item" data-inventory-icon="${escape(inventoryKey(item))}" data-item-id="${escape(id)}" title="${escape(label)} · ${escape(id)}"><span class="inventory-icon-placeholder" aria-hidden="true">${escape(id.split(':').pop().slice(0, 4))}</span></span>`;
}
function itemDescriptor(item, ctx) { return ctx.itemAssets?.items?.[inventoryKey(item)] || ctx.itemAssets?.items?.[item.id]; }
function iconNote(item, ctx) {
  const descriptor = itemDescriptor(item, ctx);
  if (!descriptor || descriptor.kind === 'unsupported') return `<p class="container-icon-note">${ctx.t('missing_icon')} · <code>${escape(item.id)}</code></p>`;
  if (!descriptor.approximate) return '';
  const reasons = (descriptor.limitations || []).map(reason => TEXT[ctx.locale][reason] ? ctx.t(reason) : ctx.t('unsupported_property'));
  return `<p class="container-icon-note">≈ ${ctx.t('approximate_icon')}${reasons.length ? ': ' + escape([...new Set(reasons)].join('; ')) : ''}</p>`;
}
function slotDetail(layout, selectedSlot, ctx) {
  const slot = layout.slots.find(s => s.index === selectedSlot);
  if (!slot) return `<p class="container-note">${ctx.t('select')}</p>`;
  const source = layout.sources.find(s => s.index === slot.sourceIndex);
  const heading = `${ctx.t('slot')} ${slot.index}${slot.role ? ` · ${ctx.t(slot.role)}` : ''}${slot.disabled ? ` · ${ctx.t('disabled')}` : ''}`;
  let content = `<div class="container-detail-title">${escape(heading)}</div><div class="container-slot-source">${escape(ctx.t('sourceSlot'))} ${slot.sourceSlot} · ${escape(source?.region || '')} · X ${source?.position.x} Y ${source?.position.y} Z ${source?.position.z}</div>`;
  if (slot.items.length) content += slot.items.map(item => `<div class="container-detail-item">${itemMark(item, ctx)}<div><strong>${escape(itemLabel(item, ctx))}</strong><code>${escape(item.id)}</code></div><b>×${escape(ctx.number(item.count))}</b></div>${iconNote(item, ctx)}<details class="container-item-nbt"><summary>${ctx.t('item_nbt')}</summary><pre>${escape(JSON.stringify(item.nbt, null, 2))}</pre></details>`).join('');
  else content += `<p class="container-note">${ctx.t(slot.status === 'loot' ? 'loot_slot' : slot.status === 'unknown' ? 'unknown_slot' : 'empty_slot')}</p>`;
  return content;
}

export function renderContainerView(layout, options = {}) {
  if (!layout) return '';
  const ctx = context(options), frame = frameFor(layout, options.itemAssets), selectedSlot = Number.isInteger(options.selectedSlot) ? options.selectedSlot : null;
  const status = ctx.t(layout.status);
  const notes = [ctx.t('recorded')];
  if (layout.kind === 'double_chest') notes.push(ctx.t('combined'));
  if (!layout.hasGameScreen) notes.push(ctx.t('no_screen'));
  if (layout.inferredCapacity) notes.push(ctx.t('generic'));
  for (const flag of layout.flags || []) if (flag.key !== 'loot') notes.push(ctx.t(flag.key));
  for (const source of layout.sources) {
    if (source.reasonKey && source.reasonKey !== 'loot') notes.push(ctx.t(source.reasonKey));
    if (source.lootTable) notes.push(`${ctx.t('loot_note')} ${source.lootTable}`);
  }
  const stylePosition = (x, y, w, h) => `left:${x / frame.width * 100}%;top:${y / frame.height * 100}%;width:${w / frame.width * 100}%;height:${h / frame.height * 100}%`;
  let background = '';
  if (frame.local) {
    const css = `background-image:url('${frame.image}');background-size:${frame.sourceWidth / frame.width * 100}% ${frame.sourceHeight / frame.topHeight * 100}%`;
    background += `<div class="container-native-bg" style="${stylePosition(0, 0, frame.width, frame.topHeight)};${css}"></div>`;
    if (frame.topHeight < frame.height) background += `<div class="container-native-bg container-native-bottom" style="${stylePosition(0, frame.topHeight, frame.width, frame.height - frame.topHeight)};background-image:url('${frame.image}');background-size:100% auto"><img src="${frame.image}" alt="" style="width:${frame.sourceWidth / frame.width * 100}%;top:${-frame.bottomSourceY / (frame.height - frame.topHeight) * 100}%"></div>`;
  }
  const slots = layout.slots.map(slot => {
    const item = slot.items[0], name = item ? itemLabel(item, ctx) : ctx.t(slot.status), role = slot.role ? ` · ${ctx.t(slot.role)}` : '';
    const approximate = item && itemDescriptor(item, ctx)?.approximate;
    const title = `${ctx.t('slot')} ${slot.index}${role}: ${name}${item ? ` ×${ctx.number(item.count)}` : ''}${slot.disabled ? ` · ${ctx.t('disabled')}` : ''}${approximate ? ` · ${ctx.t('approximate_icon')}` : ''}`;
    return `<button type="button" class="container-slot ${slot.status}${slot.disabled ? ' disabled-slot' : ''}${slot.index === selectedSlot ? ' selected' : ''}" data-container-slot="${slot.index}" style="${stylePosition(frame.x + slot.x, frame.y + slot.y, 18, 18)}" title="${escape(title)}" aria-label="${escape(title)}" aria-pressed="${slot.index === selectedSlot}">
      ${item ? `${itemMark(item, ctx)}<span class="container-stack-count">${escape(ctx.number(item.count))}</span>` : ['unknown', 'loot'].includes(slot.status) ? '<span class="container-unknown">?</span>' : ''}
      ${approximate ? `<span class="inventory-approx-mark" title="${ctx.t('approximate_icon')}">≈</span>` : ''}${slot.items.length > 1 ? `<span class="container-conflict">!${slot.items.length}</span>` : ''}${slot.disabled ? '<span class="container-disabled-mark" aria-hidden="true">×</span>' : ''}</button>`;
  }).join('');
  const anomalyRows = (layout.anomalies || []).map(a => `<li><b>${escape(ctx.t(a.kind))}</b>${a.slot !== undefined ? ` · ${ctx.t('sourceSlot')} ${escape(a.slot)}` : ''}
    ${a.item ? `<div class="container-anomaly-item">${itemMark(a.item, ctx)}<span>${escape(itemLabel(a.item, ctx))}<code>${escape(a.item.id)}</code></span><b>×${escape(ctx.number(a.item.count))}</b></div>` : ''}
    ${a.raw !== undefined || a.item ? `<details><summary>${ctx.t('raw_record')}</summary><pre>${escape(JSON.stringify(a.raw ?? a.item?.nbt, null, 2))}</pre></details>` : ''}</li>`).join('');
  return `<section class="container-view" data-i18n-skip="true"><header class="container-view-header"><strong>${ctx.t('title')}</strong><span class="container-state ${escape(layout.status)}">${escape(status)}</span></header>
    <p class="container-summary">${ctx.t('count', { slots: ctx.number(layout.occupiedSlots), capacity: ctx.number(layout.slots.length), count: ctx.number(layout.itemCount) })}</p>
    <div class="container-board ${frame.local ? 'has-native-gui' : 'css-gui'} kind-${escape(layout.kind)}" style="--container-aspect:${frame.width}/${frame.height};--container-width:${frame.width};aspect-ratio:${frame.width}/${frame.height}">${background}${slots}</div>
    ${layout.kind === 'crafter' ? `<p class="container-note">${ctx.t('crafter_result')}</p>` : ''}
    <div class="container-slot-detail">${slotDetail(layout, selectedSlot, ctx)}</div>
    <div class="container-notes">${[...new Set(notes)].map(note => `<p>${escape(note)}</p>`).join('')}</div>
    ${anomalyRows ? `<details class="container-anomalies" open><summary>${ctx.t('anomalies')} · ${layout.anomalies.length}</summary><ul>${anomalyRows}</ul></details>` : ''}</section>`;
}

export function mountContainerView(element, layout, options = {}) {
  if (!element) return { selectedSlot: null, destroy() {} };
  element.__containerView?.destroy();
  let selectedSlot = Number.isInteger(options.selectedSlot) ? options.selectedSlot : null, destroyed = false, hydration = null;
  const refreshIcons = () => {
    try { hydration?.destroy?.(); hydration = hydrateInventoryIcons(element, options.itemAssets || {}, options); Promise.resolve(hydration).catch(() => {}); } catch { /* ID placeholders remain legible. */ }
  };
  element.innerHTML = renderContainerView(layout, { ...options, selectedSlot });
  const onClick = event => {
    const target = event.target.closest('[data-container-slot]'); if (!target || !element.contains(target) || destroyed) return;
    selectedSlot = Number(target.dataset.containerSlot);
    for (const button of element.querySelectorAll('[data-container-slot]')) { const active = Number(button.dataset.containerSlot) === selectedSlot; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); }
    element.querySelector('.container-slot-detail').innerHTML = slotDetail(layout, selectedSlot, context(options));
    options.onSelectSlot?.(selectedSlot); refreshIcons();
  };
  element.addEventListener('click', onClick); refreshIcons();
  const controller = { get selectedSlot() { return selectedSlot; }, destroy() { destroyed = true; element.removeEventListener('click', onClick); hydration?.destroy?.(); } };
  element.__containerView = controller; return controller;
}
