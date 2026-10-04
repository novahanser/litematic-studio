'use strict';

// Development-only, offline audit. The application itself never executes Java.
// Example: node scripts/audit-blocks.cjs --jar <client.jar> --generate-registry
// Reuse:   node scripts/audit-blocks.cjs --jar <client.jar> --registry <blocks.json>
// Without --registry, coverage is explicitly limited to inferred visual states.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { loadAssets, _test: assetHelpers } = require('../src/core/assets.cjs');

const DIRECTIONS = ['north', 'south', 'west', 'east', 'up', 'down'];
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
const INVISIBLE = new Set([...AIR, 'minecraft:barrier', 'minecraft:light', 'minecraft:moving_piston']);
const FLUID = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:bubble_column']);
const stableKey = state => `${state.Name}[${Object.keys(state.Properties || {}).sort().map(k => `${k}=${state.Properties[k]}`).join(',')}]`;
const resourceId = value => assetHelpers.resourceId(value);
const resourcePath = (id, kind) => { const [ns, name] = resourceId(id).split(':'); return `assets/${ns}/${kind}/${name}.json`; };
const faceArea = (element, direction) => {
  const axes = ['east', 'west'].includes(direction) ? [1, 2] : ['up', 'down'].includes(direction) ? [0, 2] : [0, 1];
  return Math.abs((element.to[axes[0]] - element.from[axes[0]]) * (element.to[axes[1]] - element.from[axes[1]]));
};

function registryStates(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Registry report must be the official reports/blocks.json object');
  const states = [], ids = new Set(), keys = new Set();
  for (const [Name, block] of Object.entries(report).sort(([a], [b]) => a.localeCompare(b))) {
    resourceId(Name);
    if (!Array.isArray(block.states) || !block.states.length) throw new Error(`Registry has no states: ${Name}`);
    for (const item of block.states) {
      if (!Number.isInteger(item.id) || item.id < 0 || ids.has(item.id)) throw new Error(`Invalid or duplicate registry state ID: ${item.id}`);
      const state = { Name, Properties: {} };
      for (const [key, value] of Object.entries(item.properties || {})) {
        if (typeof value !== 'string') throw new Error(`Invalid registry property: ${Name}.${key}`);
        if (block.properties?.[key] && !block.properties[key].includes(value)) throw new Error(`Registry property outside its declared domain: ${Name}.${key}`);
        state.Properties[key] = value;
      }
      const key = stableKey(state);
      if (keys.has(key)) throw new Error(`Duplicate registry state: ${key}`);
      keys.add(key); ids.add(item.id);
      states.push({ state, registryId: item.id, default: item.default === true });
    }
  }
  if (!states.length) throw new Error('Registry report is empty');
  return { mode: 'official-registry', completeLegalStates: true, states, limitations: ['All legal registered states are enumerated, including states not normally placed in survival.', 'No world simulation, animation, NBT-dependent appearance, or GPU correctness is established by this resource audit.'] };
}

function resourceReader(jarPath, resourcePackPath) {
  const entries = new Map(), cache = new Map(), models = new Map(), textureNames = new Set();
  for (const filename of [jarPath, resourcePackPath].filter(Boolean)) {
    if (fs.statSync(filename).size > 768 * 1024 * 1024) throw new Error('Resource archive exceeds 768 MiB');
    for (const entry of new AdmZip(filename).getEntries()) {
      if (entry.isDirectory) continue;
      if (/^assets\/[a-z0-9_.-]+\/textures\/[a-z0-9_./-]+\.png$/.test(entry.entryName)) { assetHelpers.cleanZipPath(entry.entryName); textureNames.add(entry.entryName); continue; }
      if (!/^assets\/[a-z0-9_.-]+\/(?:blockstates|models)\/[a-z0-9_./-]+\.json$/.test(entry.entryName)) continue;
      assetHelpers.cleanZipPath(entry.entryName); entries.set(entry.entryName, entry);
    }
  }
  const json = filename => {
    if (!cache.has(filename)) {
      const entry = entries.get(filename);
      if (entry?.header.size > 16 * 1024 * 1024) throw new Error(`JSON resource exceeds limit: ${filename}`);
      cache.set(filename, entry ? JSON.parse(entry.getData().toString('utf8').replace(/^\uFEFF/, '')) : null);
    }
    return cache.get(filename);
  };
  function model(id, trail = []) {
    id = resourceId(id);
    if (models.has(id)) return models.get(id);
    if (trail.includes(id) || trail.length > 48) throw new Error(`Model inheritance cycle/depth: ${id}`);
    const raw = json(resourcePath(id, 'models'));
    if (!raw) throw new Error(`Missing source model: ${id}`);
    let parent = {};
    if (raw.parent && !/^(?:minecraft:)?builtin\//.test(raw.parent)) parent = model(raw.parent, [...trail, id]);
    const resolved = { ...parent, ...raw, textures: { ...parent.textures, ...raw.textures }, elements: raw.elements === undefined ? parent.elements : raw.elements };
    models.set(id, resolved); return resolved;
  }
  const definitions = new Map();
  for (const filename of entries.keys()) {
    const match = filename.match(/^assets\/([^/]+)\/blockstates\/(.+)\.json$/);
    if (match) definitions.set(match[1] + ':' + match[2], json(filename));
  }
  return { definitions, model, json, models, hasTexture: id => { const [ns, name] = resourceId(id).split(':'); return textureNames.has(`assets/${ns}/textures/${name}.png`); } };
}

function inspectSourceModel(id, model, reader) {
  const result = { id, parent: model.parent || null, elements: (model.elements || []).length, hasFaces: (model.elements || []).some(e => Object.keys(e.faces || {}).length), zeroThickness: [], rescaled: [], textures: [], issues: [], error: null };
  const textures = new Set();
  for (const [elementIndex, element] of (model.elements || []).entries()) {
    if (![element.from, element.to].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) result.issues.push({ code: 'source-invalid-coordinates', element: elementIndex });
    const zeroAxes = ['x', 'y', 'z'].filter((_, axis) => element.from?.[axis] === element.to?.[axis]);
    if (zeroAxes.length) result.zeroThickness.push({ element: elementIndex, axes: zeroAxes, faces: Object.keys(element.faces || {}), degenerateFaces: Object.keys(element.faces || {}).filter(d => faceArea(element, d) === 0) });
    if (element.rotation?.rescale) result.rescaled.push({ element: elementIndex, rotation: element.rotation });
    for (const [direction, face] of Object.entries(element.faces || {})) {
      try {
        let reference = face.texture, seen = new Set();
        // Vanilla face texture slots accept a key both with and without '#'.
        while (typeof reference === 'string' && (reference.startsWith('#') || Object.hasOwn(model.textures || {}, reference))) {
          if (seen.has(reference)) throw new Error('Cyclic texture reference');
          seen.add(reference); reference = model.textures?.[reference.replace(/^#/, '')];
        }
        if (typeof reference !== 'string') throw new Error('Unresolved texture variable');
        const texture = resourceId(reference); textures.add(texture);
        if (!reader.hasTexture(texture)) result.issues.push({ code: 'source-missing-texture', element: elementIndex, direction, texture });
      } catch (error) { result.issues.push({ code: 'source-invalid-texture', element: elementIndex, direction, message: error.message }); }
      if (face.uv !== undefined && (!Array.isArray(face.uv) || face.uv.length !== 4 || !face.uv.every(Number.isFinite))) result.issues.push({ code: 'source-invalid-uv', element: elementIndex, direction });
    }
  }
  result.textures = [...textures]; return result;
}

function enumerateVisualStates(definitions, maxStates = 200000) {
  const states = [], limitations = new Set(['Visual blockstate property domains are inferred from JSON; omitted properties and unmentioned values are unknown.', 'Combinations are not proven legal registry states. Use --registry or --generate-registry for complete legal-state coverage.']);
  for (const [Name, definition] of [...definitions].sort(([a], [b]) => a.localeCompare(b))) {
    const domains = new Map();
    const add = (key, value) => {
      if (typeof value !== 'string' && typeof value !== 'boolean') return;
      const values = String(value).split('|');
      if (values.some(v => v.startsWith('!'))) { limitations.add(`Negated condition has unknown domain: ${Name}.${key}`); return; }
      if (!domains.has(key)) domains.set(key, new Set());
      values.forEach(v => domains.get(key).add(v));
      if (values.every(v => ['true', 'false'].includes(v))) { domains.get(key).add('true'); domains.get(key).add('false'); }
    };
    const visit = when => { for (const [k, v] of Object.entries(when || {})) { if (k === 'OR' || k === 'AND') { if (Array.isArray(v)) v.forEach(visit); } else add(k, v); } };
    for (const key of Object.keys(definition.variants || {})) for (const term of key.split(',')) { const split = term.indexOf('='); if (split > 0) add(term.slice(0, split).trim(), term.slice(split + 1).trim()); }
    (definition.multipart || []).forEach(piece => visit(piece.when));
    let combinations = [{}];
    for (const [key, values] of [...domains].sort(([a], [b]) => a.localeCompare(b))) {
      if (combinations.length * values.size + states.length > maxStates) throw new Error(`Visual enumeration exceeds ${maxStates} states at ${Name}; provide a registry report`);
      combinations = combinations.flatMap(p => [...values].sort().map(value => ({ ...p, [key]: value })));
    }
    states.push(...combinations.map(Properties => ({ state: { Name, Properties }, registryId: null, default: false })));
    if (states.length > maxStates) throw new Error(`Visual enumeration exceeds ${maxStates} states`);
  }
  return { mode: 'inferred-visual-properties', completeLegalStates: false, states, limitations: [...limitations] };
}

function conditionMatches(when, properties) {
  if (!when) return true;
  return Object.entries(when).every(([key, value]) => {
    if (key === 'OR') return Array.isArray(value) && value.some(v => conditionMatches(v, properties));
    if (key === 'AND') return Array.isArray(value) && value.every(v => conditionMatches(v, properties));
    const text = String(value), negate = text.startsWith('!'), choices = (negate ? text.slice(1) : text).split('|');
    return negate !== choices.includes(String(properties[key]));
  });
}
function selectSource(definition, properties) {
  if (!definition) return { variantMatches: [], multipartMatches: [], selected: [], alternatives: [], missing: true };
  const variantMatches = Object.entries(definition.variants || {}).filter(([key]) => !key || key.split(',').every(term => { const index = term.indexOf('='); return index > 0 && conditionMatches({ [term.slice(0, index).trim()]: term.slice(index + 1).trim() }, properties); }));
  const multipartMatches = (definition.multipart || []).map((piece, index) => ({ piece, index })).filter(({ piece }) => conditionMatches(piece.when, properties));
  const groups = [...variantMatches.slice(0, 1).map(([, value]) => value), ...multipartMatches.map(({ piece }) => piece.apply)].map(value => Array.isArray(value) ? value : [value]);
  return { variantMatches: variantMatches.map(([key]) => key), multipartMatches: multipartMatches.map(x => x.index), selected: groups.map(g => g[0]).filter(Boolean), alternatives: groups.flat().filter(Boolean), missing: false };
}

function isSimpleFullCube(parts) {
  return parts.length === 1 && (parts[0].elements || []).length === 1 && (() => {
    const e = parts[0].elements[0];
    return !e.rotation && e.from.every(v => v === 0) && e.to.every(v => v === 16) && DIRECTIONS.every(d => e.faces?.[d]);
  })();
}

async function auditBlocks({ jarPath, resourcePackPath, registry, batchSize = 2048, onProgress = () => {} }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32768) throw new Error('batchSize must be 1..32768');
  const reader = resourceReader(jarPath, resourcePackPath), coverage = registry ? registryStates(registry) : enumerateVisualStates(reader.definitions);
  const [{ buildStateGeometry }, { faceVertexUVs }] = await Promise.all([import('../src/renderer/viewer.js'), import('../src/renderer/model-uv.js')]);
  const rows = [], warnings = new Set(), modelRows = new Map(), renderedModelIds = new Set();
  const geometryCache = new Map(), sourceVariantCache = new Map();
  let version = null;
  for (let start = 0; start < coverage.states.length; start += batchSize) {
    const batch = coverage.states.slice(start, start + batchSize), assets = loadAssets(jarPath, batch.map(entry => entry.state), { resourcePackPath });
    version ||= assets.source.version; assets.warnings.forEach(w => warnings.add(w));
    const atlas = { width: 64, height: 64, regions: Object.fromEntries(Object.keys(assets.textures).map(id => [id, { x: 2, y: 2, width: 16, height: 16 }])) };
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i], state = entry.state, asset = assets.blocks[i], issues = [], details = { uvOutOfBounds: [], zeroThickness: [], rescaled: [] };
      const selected = selectSource(reader.definitions.get(asset.resourceName || state.Name), state.Properties);
      const expected = [], sourceModels = [];
      for (const definition of selected.alternatives) {
        if (!definition?.model) { issues.push({ code: 'invalid-model-definition' }); continue; }
        const id = resourceId(definition.model); sourceModels.push(id);
        if (!modelRows.has(id)) {
          try {
            const model = reader.model(id);
            modelRows.set(id, inspectSourceModel(id, model, reader));
          } catch (error) { modelRows.set(id, { id, error: error.message }); }
        }
        if (modelRows.get(id).error) issues.push({ code: 'source-model-error', model: id, message: modelRows.get(id).error });
        for (const problem of modelRows.get(id).issues || []) issues.push({ ...problem, model: id });
        const variantKey = JSON.stringify([id, definition.x || 0, definition.y || 0, !!definition.uvlock]);
        if (!sourceVariantCache.has(variantKey)) {
          const problems = [];
          if (!modelRows.get(id).error) {
            const model = reader.model(id);
            for (const [elementIndex, element] of (model.elements || []).entries()) for (const [direction, face] of Object.entries(element.faces || {})) {
              try {
                const uv = faceVertexUVs(direction, face.uv || assetHelpers.defaultUv(direction, element.from, element.to), face.rotation || 0, definition);
                if (uv.flat().some(n => n < -1e-6 || n > 16 + 1e-6)) problems.push({ code: 'source-variant-uv-out-of-bounds', model: id, element: elementIndex, direction, uv, x: definition.x || 0, y: definition.y || 0, uvlock: !!definition.uvlock });
              } catch (error) { problems.push({ code: 'source-variant-invalid-uv', model: id, element: elementIndex, direction, message: error.message }); }
            }
          }
          sourceVariantCache.set(variantKey, problems);
        }
        issues.push(...sourceVariantCache.get(variantKey));
      }
      for (const definition of selected.selected) {
        if (definition.model) renderedModelIds.add(resourceId(definition.model));
        try { const model = reader.model(definition.model); if (model.elements?.length) expected.push({ x: definition.x || 0, y: definition.y || 0, uvlock: !!definition.uvlock, elements: model.elements.length }); } catch {}
      }
      if (selected.variantMatches.length > 1) issues.push({ code: 'ambiguous-variant-selection', matches: selected.variantMatches });
      if (selected.missing && !AIR.has(state.Name) && !FLUID.has(state.Name)) issues.push({ code: 'missing-blockstate' });
      if (!asset.fallback && asset.modelKind !== 'json-and-entity' && !AIR.has(state.Name) && !FLUID.has(state.Name) && asset.parts.length && JSON.stringify(expected) !== JSON.stringify(asset.parts.map(p => ({ x: p.x || 0, y: p.y || 0, uvlock: !!p.uvlock, elements: p.elements.length })))) issues.push({ code: 'variant-parts-mismatch', expected });
      let faceCount = 0, declaredFaceCount = 0, degenerateFaceCount = 0;
      for (const [partIndex, part] of asset.parts.entries()) for (const [elementIndex, element] of (part.elements || []).entries()) {
        const location = { part: partIndex, element: elementIndex, model: selected.selected[partIndex]?.model || null };
        const zeroAxes = ['x', 'y', 'z'].filter((_, axis) => element.from[axis] === element.to[axis]);
        if (zeroAxes.length) details.zeroThickness.push({ ...location, axes: zeroAxes, faces: Object.keys(element.faces || {}), degenerateFaces: Object.keys(element.faces || {}).filter(d => faceArea(element, d) === 0) });
        if (element.rotation?.rescale) details.rescaled.push({ ...location, rotation: element.rotation });
        for (const [direction, face] of Object.entries(element.faces || {})) {
          declaredFaceCount++;
          if (faceArea(element, direction) > 0) faceCount++; else degenerateFaceCount++;
          if (face.texture === 'viewer:missing' || !assets.textures[face.texture]) issues.push({ code: 'missing-texture', ...location, direction, texture: face.texture });
          try {
            const uv = faceVertexUVs(direction, face.uv, face.rotation || 0, part);
            if (uv.flat().some(n => !Number.isFinite(n))) issues.push({ code: 'nonfinite-uv', ...location, direction });
            if (uv.flat().some(n => n < -1e-6 || n > 16 + 1e-6)) details.uvOutOfBounds.push({ ...location, direction, uv });
          } catch (error) { issues.push({ code: 'invalid-uv', ...location, direction, message: error.message }); }
        }
      }
      if (details.uvOutOfBounds.length) issues.push({ code: 'uv-out-of-bounds', count: details.uvOutOfBounds.length });
      const hasFaces = faceCount > 0;
      const sourceExplicitlyEmpty = selected.selected.length > 0 && selected.selected.every(d => { try { const m = reader.model(d.model); return Array.isArray(m.elements) && m.elements.length === 0; } catch { return false; } });
      let emptyReason = null;
      if (!hasFaces) emptyReason = asset.modelKind === 'unsupported' ? 'unsupported-entity-without-nbt'
        : asset.modelKind === 'invisible' || INVISIBLE.has(state.Name) ? 'intentional-invisible-block'
        : reader.definitions.get(state.Name)?.multipart && !selected.selected.length ? 'multipart-no-parts-match'
        : sourceExplicitlyEmpty || asset.modelKind === 'empty-json' ? 'source-explicit-empty-model'
        : declaredFaceCount ? 'only-degenerate-faces' : 'no-visible-faces';
      if (!hasFaces && emptyReason === 'no-visible-faces' && !asset.invisible) issues.push({ code: 'unexplained-empty-model' });
      if (!hasFaces && emptyReason === 'only-degenerate-faces') issues.push({ code: 'only-degenerate-faces' });
      const genericFallback = !!asset.fallback && /材质立方体/.test(asset.fallbackReason || '');
      if (genericFallback && !INVISIBLE.has(state.Name)) issues.push({ code: 'generic-cube-fallback', reason: asset.fallbackReason });
      if (sourceExplicitlyEmpty && hasFaces) issues.push({ code: 'empty-source-rendered-as-geometry' });
      let geometry;
      // Inert state properties often share identical preview geometry. Cache only
      // validation results, never state selection or source coverage information.
      const geometryKey = crypto.createHash('sha256').update(JSON.stringify([asset.parts, state.Name, state.Name === 'minecraft:redstone_wire' ? state.Properties.power : null])).digest('hex');
      if (geometryCache.has(geometryKey)) geometry = geometryCache.get(geometryKey);
      else {
        try {
          const built = buildStateGeometry(asset, state, atlas);
          geometry = { vertices: built.attributes.position?.count || 0, triangles: (built.index?.count || 0) / 3, finite: Object.values(built.attributes).every(a => [...a.array].every(Number.isFinite)), bounds: built.attributes.position?.count ? { min: built.boundingBox.min.toArray(), max: built.boundingBox.max.toArray() } : null };
          built.dispose();
        } catch (error) { geometry = { finite: false, error: error.message }; }
        geometryCache.set(geometryKey, geometry);
      }
      if (!geometry.finite) issues.push({ code: 'invalid-built-geometry', message: geometry.error || 'NaN/Infinity attribute' });
      const renderMode = asset.modelKind || (!hasFaces ? 'empty' : FLUID.has(state.Name) ? 'fluid' : genericFallback ? 'generic-cube-fallback' : asset.fallback ? 'static-special-approximation' : 'model');
      rows.push({ state, registryId: entry.registryId, default: entry.default, renderMode, hasFaces, emptyReason,
        status: issues.length ? 'issue' : asset.modelKind === 'unsupported' ? 'unsupported' : !hasFaces ? 'intentional-empty' : asset.fallback || asset.modelKind === 'approximate-entity' ? 'approximation' : 'pass',
        nonFullCandidate: !hasFaces || !isSimpleFullCube(asset.parts) || !!asset.fallback || !!asset.fluid,
        issues, faceCount, declaredFaceCount, degenerateFaceCount, geometry, sourceSelection: { variantMatches: selected.variantMatches, multipartMatches: selected.multipartMatches, selectedModels: selected.selected.map(d => d.model), allAlternativeModels: [...new Set(sourceModels)], alternativeChoices: selected.alternatives.length, unrenderedChoices: selected.alternatives.length - selected.selected.length }, details,
        ...(asset.fallback ? { approximation: asset.fallbackReason } : {}) });
    }
    onProgress({ processed: rows.length, total: coverage.states.length });
  }
  const summary = { version, coverage: coverage.mode, completeLegalStates: coverage.completeLegalStates, blockTypes: new Set(rows.map(r => r.state.Name)).size, states: rows.length,
    nonFullCandidates: rows.filter(r => r.nonFullCandidate).length, status: {}, renderModes: {}, issueCounts: {}, issueBlockTypes: {}, uniqueBuiltGeometries: geometryCache.size, sourceModels: modelRows.size,
    sourceModelRotationCases: sourceVariantCache.size, degenerateDeclaredFacesAcrossStates: rows.reduce((n, row) => n + row.degenerateFaceCount, 0),
    unrenderedWeightedChoicesAcrossStates: rows.reduce((n, row) => n + row.sourceSelection.unrenderedChoices, 0), modelsOnlyInUnrenderedChoices: [...modelRows.keys()].filter(id => !renderedModelIds.has(id)), limitations: coverage.limitations };
  for (const row of rows) {
    summary.status[row.status] = (summary.status[row.status] || 0) + 1; summary.renderModes[row.renderMode] = (summary.renderModes[row.renderMode] || 0) + 1;
    for (const code of new Set(row.issues.map(i => i.code))) { summary.issueCounts[code] = (summary.issueCounts[code] || 0) + 1; (summary.issueBlockTypes[code] ||= new Set()).add(row.state.Name); }
  }
  summary.issueBlockTypes = Object.fromEntries(Object.entries(summary.issueBlockTypes).map(([k, v]) => [k, [...v].sort()]));
  return { summary, states: rows, models: [...modelRows.values()], warnings: [...warnings] };
}

function discoverClasspath(jarPath) {
  const jar = path.resolve(jarPath), versionDir = path.dirname(jar), gameRoot = path.dirname(path.dirname(versionDir));
  const versions = [], seen = new Set(); let filename = path.join(versionDir, path.basename(jar, '.jar') + '.json');
  while (fs.existsSync(filename) && !seen.has(filename)) {
    seen.add(filename); const value = JSON.parse(fs.readFileSync(filename, 'utf8')); versions.push(value);
    if (!value.inheritsFrom) break;
    filename = path.join(gameRoot, 'versions', value.inheritsFrom, value.inheritsFrom + '.json');
  }
  if (!versions.length) throw new Error('Cannot find launcher version JSON; provide --classpath explicitly');
  const files = new Set([jar]);
  for (const version of versions) for (const library of version.libraries || []) {
    // Only plain library artifacts; native binaries and launcher entry points
    // are unnecessary for vanilla's headless data generator.
    let relative = library.downloads?.artifact?.path;
    if (!relative && typeof library.name === 'string') { const [group, artifact, ver, classifier] = library.name.split(':'); if (group && artifact && ver) relative = `${group.replace(/\./g, '/')}/${artifact}/${ver}/${artifact}-${ver}${classifier ? '-' + classifier : ''}.jar`; }
    if (!relative) continue;
    const candidate = path.resolve(gameRoot, 'libraries', relative);
    if (!candidate.startsWith(path.resolve(gameRoot, 'libraries') + path.sep)) throw new Error('Unsafe launcher library path');
    if (fs.existsSync(candidate)) files.add(candidate);
  }
  return [...files].join(path.delimiter);
}

function generateRegistry({ jarPath, outputDirectory, java = 'java', classpath, runJava = spawnSync }) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const directory = path.join(outputDirectory, 'vanilla-registry');
  // Native argv preserves Unicode on Windows. Java @argfiles can be decoded
  // using a legacy platform code page and corrupt a Chinese workspace path.
  const argv = ['-classpath', classpath || discoverClasspath(jarPath), 'net.minecraft.data.Main', '--reports', '--output', 'vanilla-registry'];
  fs.writeFileSync(path.join(outputDirectory, 'vanilla-datagen-command.json'), JSON.stringify({ executable: java, argv }, null, 2));
  const result = runJava(java, argv, { cwd: outputDirectory, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(outputDirectory, 'vanilla-datagen.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status !== 0) throw new Error('Local vanilla datagen failed; see vanilla-datagen.log: ' + (result.error?.message || result.status));
  const filename = path.join(directory, 'reports', 'blocks.json');
  registryStates(JSON.parse(fs.readFileSync(filename, 'utf8')));
  return filename;
}

async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--help', '--generate-registry'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--jar', '--pack', '--registry', '--out', '--batch-size', '--classpath', '--java'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('Unknown or incomplete option: ' + args[i]);
  }
  if (options.help) { console.log('Usage: node scripts/audit-blocks.cjs --jar CLIENT.jar [--registry reports/blocks.json | --generate-registry] [--pack PACK.zip] [--out test-results/block-audit] [--batch-size 2048] [--java java] [--classpath PATHS]\nWithout a registry report, only inferred visual property combinations are audited. --generate-registry explicitly runs the selected local vanilla client data generator; it does not download anything.'); return; }
  const jarPath = options.jar || process.env.MINECRAFT_JAR;
  if (!jarPath) throw new Error('Set MINECRAFT_JAR or pass --jar CLIENT.jar');
  const outputDirectory = path.resolve(options.out || path.join(__dirname, '../test-results/block-audit'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const registryPath = options.registry || (options['generate-registry'] ? generateRegistry({ jarPath, outputDirectory, java: options.java, classpath: options.classpath }) : null);
  const result = await auditBlocks({ jarPath, resourcePackPath: options.pack, registry: registryPath ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : null, batchSize: Number(options['batch-size'] || 2048), onProgress: progress => console.log(`Audited ${progress.processed}/${progress.total} states`) });
  fs.writeFileSync(path.join(outputDirectory, 'manifest.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outputDirectory, 'summary.json'), JSON.stringify(result.summary, null, 2));
  fs.writeFileSync(path.join(outputDirectory, 'palette.json'), JSON.stringify(result.states.map(row => row.state)));
  fs.writeFileSync(path.join(outputDirectory, 'source-models.json'), JSON.stringify(result.models, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { registryStates, resourceReader, inspectSourceModel, enumerateVisualStates, conditionMatches, selectSource, isSimpleFullCube, auditBlocks, discoverClasspath, generateRegistry };
