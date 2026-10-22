'use strict';

function stackData(value) { return value?.nbt || value?.item || value || {}; }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function inventoryKey(value) {
  const stack = stackData(value), id = String(value?.id || stack.id || '');
  const c = stack.components || {}, tag = stack.tag || {};
  // Item models can inspect arbitrary components (has_component), not just tint
  // fields. Preserve those distinctions, including trims, charged projectiles,
  // banner patterns and profiles; normalize key order for stable cache reuse.
  const visual = { components: c, tag, ...(stack.Damage == null ? {} : { Damage: stack.Damage }) };
  return !Object.keys(c).length && !Object.keys(tag).length && stack.Damage == null ? id : id + '|' + JSON.stringify(canonical(visual));
}

module.exports = { inventoryKey, stackData };
