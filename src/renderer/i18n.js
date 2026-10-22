import {translate} from '../core/i18n.cjs';

// Preserve original UI text on each node, so a language change needs no DOM,
// filter or camera reset. Never visit user values, NBT, resource IDs or names.
const textSources = new WeakMap(), attributeSources = new WeakMap();
const skip = 'pre,code,script,style,svg,[data-i18n-skip],.block-id,.block-name,.block-title,.material-name,#file-title';
const attributes = ['title', 'placeholder', 'aria-label'];
function update(source, current, locale) {
  const original = source && source.rendered === current ? source.original : current;
  return {original, rendered: translate(original, locale)};
}
export function localizeTree(root, locale) {
  if (!root) return;
  if (root.nodeType === 3) {
    if (root.parentElement?.closest(skip)) return;
    const source = update(textSources.get(root), root.nodeValue, locale);
    textSources.set(root, source);
    if (source.rendered !== root.nodeValue) root.nodeValue = source.rendered;
    return;
  }
  if (![1,9,11].includes(root.nodeType) || root.nodeType === 1 && root.closest(skip)) return;
  if (root.nodeType === 1) {
    const sources = attributeSources.get(root) || {};
    for (const key of attributes) if (root.hasAttribute(key)) {
      const source = update(sources[key], root.getAttribute(key), locale); sources[key] = source;
      if (source.rendered !== root.getAttribute(key)) root.setAttribute(key, source.rendered);
    }
    attributeSources.set(root, sources);
  }
  for (const node of root.childNodes) localizeTree(node, locale);
}
export function observeTranslations(root, getLocale) {
  const observer = new MutationObserver(records => {
    const nodes = new Set();
    for (const r of records) if (r.type === 'childList') r.addedNodes.forEach(n => nodes.add(n)); else nodes.add(r.target);
    for (const node of nodes) if (node.isConnected) localizeTree(node, getLocale());
  });
  observer.observe(root, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:attributes});
  return observer;
}
