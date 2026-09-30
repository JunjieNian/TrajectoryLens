/* SPDX-License-Identifier: Apache-2.0
 * Adapted from JunjieNian/TraceGraph, commit
 * bc830d534b6d75174a7ada89e786f6f5b6b35402, tracegraph/signature.py
 * and build_mutual_knn_edges in tracegraph/graph_construction.py.
 * Local changes: browser implementation, evidence provenance, raw-event
 * adapters, Codex/Windows/relative-path extensions, bounded graph rendering.
 * See THIRD_PARTY_NOTICES.md for exact scientific and implementation limits.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LensSignatures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SOURCE_COMMIT = 'bc830d534b6d75174a7ada89e786f6f5b6b35402';
  const COMMANDS = [
    ['pytest', /\b(pytest|py\.test)\b/], ['python', /\b(python3?|ipython)\b/],
    ['grep', /\b(grep|rg|ag|ack)\b/], ['find', /\b(find|fd|locate)\b/],
    ['sed', /\b(sed)\b/], ['cat', /\b(cat|head|tail|less|more)\b/],
    ['pip', /\b(pip3?|conda)\s+install\b/], ['git', /\b(git)\b/],
    ['cd', /^\s*cd\b/], ['ls', /\b(ls|dir)\b/], ['echo', /\b(echo|printf)\b/],
    ['mkdir', /\b(mkdir)\b/], ['rm', /\b(rm|rmdir)\b/], ['curl', /\b(curl|wget)\b/]
  ];
  const OBSERVATIONS = [
    ['OBS:AssertionError', /AssertionError|assert\s+.*failed/i],
    ['OBS:ImportError', /ImportError|ModuleNotFoundError/i],
    ['OBS:SyntaxError', /SyntaxError/i], ['OBS:NameError', /NameError/i],
    ['OBS:TypeError', /TypeError/i], ['OBS:ValueError', /ValueError/i],
    ['OBS:AttributeError', /AttributeError/i], ['OBS:KeyError', /KeyError/i],
    ['OBS:IndexError', /IndexError/i], ['OBS:FileNotFoundError', /FileNotFoundError|No such file/i],
    ['OBS:PermissionError', /PermissionError|Permission denied/i],
    ['OBS:TimeoutError', /TimeoutError|timed?\s*out/i], ['OBS:RuntimeError', /RuntimeError/i],
    ['OBS:OSError', /OSError|IOError/i], ['OBS:test_passed', /\bpassed\b.*\btest/i],
    ['OBS:test_failed', /\bfailed\b.*\btest|\bFAILED\b/i],
    ['OBS:test_error', /\bERROR\b.*\btest|test.*\bERROR\b/i],
    ['OBS:traceback', /Traceback \(most recent call last\)/],
    ['OBS:success', /\bsuccess(?:ful(?:ly)?)?\b/i]
  ];
  const DIFFS = [
    ['DIFF:add_import', /^\+\s*(import |from .* import )/m],
    ['DIFF:add_function', /^\+\s*def\s+[\p{L}\p{N}_]+/mu],
    ['DIFF:add_class', /^\+\s*class\s+[\p{L}\p{N}_]+/mu],
    ['DIFF:add_condition', /^\+\s*(if |elif |else:)/m],
    ['DIFF:add_try', /^\+\s*(try:|except |finally:)/m],
    ['DIFF:modify_function', /^[-+]\s*def\s+[\p{L}\p{N}_]+/mu],
    ['DIFF:add_return', /^\+\s*return\b/m], ['DIFF:add_assert', /^\+\s*assert\b/m]
  ];
  const PATH_PATTERN = /(?:^|[\s"'(])(\/[^\s"')]+\.[\p{L}\p{N}_]+)/gmu;
  // Python's re word boundary includes Unicode letters/numbers; JavaScript's
  // native \b is ASCII-only. Preserve Python behavior for multilingual logs.
  const PY_BOUNDARY = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';
  for (const patterns of [COMMANDS, OBSERVATIONS, DIFFS]) for (const row of patterns) {
    if (row[1].source.includes('\\b')) row[1] = new RegExp(row[1].source.replace(/\\b/g, PY_BOUNDARY), Array.from(new Set(row[1].flags + 'u')).join(''));
  }
  const cachedCorpora = new WeakMap();
  function pythonString(value) {
    if (typeof value === 'string') return value;
    if (value === null) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (Array.isArray(value)) return '[' + value.map(pythonRepr).join(', ') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).map(k => pythonRepr(k) + ': ' + pythonRepr(value[k])).join(', ') + '}';
    return String(value);
  }
  function pythonRepr(value) {
    if (typeof value !== 'string') return pythonString(value);
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').split(quote).join('\\' + quote) + quote;
  }
  function calls(message) {
    if (!message || typeof message !== 'object') return [];
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls;
    return message.function_call ? [{function: message.function_call}] : [];
  }
  function normalisePath(path) {
    const parts = String(path).trim().replace(/\/+$/, '').split('/');
    return parts.length >= 2 ? parts.slice(-2).join('/') : parts[0];
  }
  function extension(path) {
    const text = String(path);
    if (!text.includes('.')) return null;
    const ext = text.slice(text.lastIndexOf('.') + 1).toLowerCase();
    return ext.length <= 6 && /^[\p{L}\p{N}]+$/u.test(ext) ? ext : null;
  }
  function classifyCommand(command) {
    for (const [label, pattern] of COMMANDS) if (pattern.test(command)) return label;
    return 'other';
  }
  function observationText(message) {
    let content = message && Object.hasOwn(message, 'content') ? message.content : '';
    if (Array.isArray(content)) content = content.map(item => item && typeof item === 'object' && !Array.isArray(item) ? (item.text || '') : pythonString(item)).join(' ');
    return pythonString(content);
  }
  function extractor() {
    const keys = new Set(), evidence = [], seen = new Set();
    const add = (key, source, rule, excerpt) => {
      keys.add(key);
      const record = {key, source, rule, excerpt: String(excerpt ?? '')};
      const id = JSON.stringify(record);
      if (!seen.has(id)) { seen.add(id); evidence.push(record); }
    };
    const finish = () => ({keys: Array.from(keys).sort(), evidence});
    return {add, finish};
  }
  function addFile(add, path, rule, original = path) {
    const ext = extension(path), norm = normalisePath(path);
    if (ext) add('FILE_EXT:' + ext, 'action', rule, original);
    if (norm) add('FILE_PATH:' + norm, 'action', rule, original);
  }
  function extractWithEvidence(actionMsg, obsMsg, progress, options = {}) {
    const {add, finish} = extractor();
    for (const tc of calls(actionMsg)) {
      const func = tc.function || {}, name = String(func.name || '');
      const args = Object.hasOwn(func, 'arguments') ? func.arguments : '';
      const argsText = pythonString(args), lower = name.toLowerCase();
      if (name) add('TOOL:' + name, 'action', 'tracegraph:tool-name', name);
      if (lower.includes('bash') || lower.includes('execute')) {
        const cls = classifyCommand(argsText), pattern = COMMANDS.find(x => x[0] === cls)?.[1];
        add('CMD:' + cls, 'action', 'tracegraph:command:' + cls, pattern ? (argsText.match(pattern)?.[0] || argsText) : argsText);
      }
      const action = lower.includes('str_replace') || lower.includes('edit') ? 'edit'
        : lower.includes('create') || lower.includes('write') ? 'create'
        : lower.includes('view') || lower.includes('read') ? 'view'
        : lower.includes('search') || lower.includes('grep') ? 'search' : null;
      if (action) add('ACTION:' + action, 'action', 'tracegraph:tool-name-action', name);
      for (const match of argsText.matchAll(PATH_PATTERN)) addFile(add, match[1], 'tracegraph:absolute-path-pattern', match[1]);
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        for (const key of ['path', 'file_path', 'file', 'filename']) {
          if (typeof args[key] === 'string' && args[key]) addFile(add, args[key], 'tracegraph:argument:' + key);
        }
      }
      const diffText = args && typeof args === 'object' && !Array.isArray(args)
        ? '+' + (args.new_str || args.replacement || '') + '\n-' + (args.old_str || args.original || '') : argsText;
      for (const [key, pattern] of DIFFS) {
        const hit = diffText.match(pattern);
        if (hit) {
          const structured = args && typeof args === 'object' && !Array.isArray(args);
          add(key, 'action', structured ? 'tracegraph:diff-from-replacement' : 'tracegraph:diff-pattern', structured ? hit[0].slice(1) : hit[0]);
        }
      }
      if (options.extensions) extendAction(add, name, args, argsText);
    }
    const obsText = observationText(obsMsg);
    for (const [key, pattern] of OBSERVATIONS) {
      const hit = obsText.match(pattern);
      if (hit) add(key, 'observation', 'tracegraph:observation-pattern', hit[0]);
    }
    const phase = progress < 1 / 3 ? 'early' : progress < 2 / 3 ? 'mid' : 'late';
    add('PHASE:' + phase, 'progress', 'tracegraph:temporal-third', String(progress));
    return finish();
  }
  function decodedArguments(args) {
    if (args && typeof args === 'object') return args;
    if (typeof args === 'string') { try { return JSON.parse(args); } catch (_) {} }
    return null;
  }
  function extendAction(add, name, args, argsText) {
    const lower = name.toLowerCase(), decoded = decodedArguments(args);
    const commandTool = /(?:^|[._:/])(exec_command|write_stdin|shell_command|shell|terminal|run_command)$/.test(lower);
    // A stdin response need not contain a command; do not invent CMD:other for a poll.
    if (commandTool && !lower.endsWith('write_stdin')) {
      const command = decoded && typeof decoded === 'object' ? String(decoded.cmd ?? decoded.command ?? argsText) : argsText;
      let cls = classifyCommand(command);
      if (cls === 'other') {
        if (/\b(node|nodejs)\b/i.test(command)) cls = 'node';
        else if (/\b(npm|npx|pnpm|yarn)\b/i.test(command)) cls = 'npm';
        else if (/\b(powershell|pwsh)\b/i.test(command)) cls = 'powershell';
      }
      add('CMD:' + cls, 'action', 'lens-extension:command-tool', command);
    }
    if (/(?:^|[._:/])(apply_patch|patch)$/.test(lower)) add('ACTION:edit', 'action', 'lens-extension:patch-tool', name);
    const scanText = decoded && typeof decoded === 'object'
      ? Object.values(decoded).filter(x => typeof x === 'string').join('\n') : argsText;
    // Match conventional patch headers, including relative files without an extension.
    for (const hit of scanText.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
      addFile(add, hit[1].trim().replace(/\\/g, '/'), 'lens-extension:patch-header', hit[1]);
    }
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      for (const key of ['path', 'file_path', 'file', 'filename']) {
        const value = decoded[key];
        if (typeof value === 'string' && value.trim()) addFile(add, value.replace(/\\/g, '/'), 'lens-extension:decoded-path:' + key, value);
      }
    }
    // Quoted paths may contain spaces. Case is preserved; last-two-components is
    // upstream's lossy signature, never an assertion of full file identity.
    const quoted = /["']((?:(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)?)[^"'\r\n]+\.[A-Za-z0-9]{1,6})["']/g;
    for (const hit of scanText.matchAll(quoted)) {
      if (!/[\s{}:]/.test(hit[1]) || /^(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|\/)/.test(hit[1])) addFile(add, hit[1].replace(/\\/g, '/'), 'lens-extension:quoted-path', hit[1]);
    }
    const tokens = /(?:^|[\s"'(=])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\p{L}\p{N}_@.-]+[\\/])*[\p{L}\p{N}_@.-]+\.[A-Za-z0-9]{1,6})(?=$|[\s"'),;\]}])/gmu;
    for (const hit of scanText.matchAll(tokens)) {
      const value = hit[1];
      if (/^\d+(?:\.\d+)+$/.test(value)) continue;
      addFile(add, value.replace(/\\/g, '/'), 'lens-extension:path-token', value);
    }
    // JSON-serialized patches are unescaped before scanning their diff lines.
    if (decoded && typeof decoded === 'object') {
      const patch = [decoded.patch, decoded.input, decoded.new_str, decoded.replacement].find(x => typeof x === 'string');
      if (patch) for (const [key, pattern] of DIFFS) {
        const replacement = Boolean(decoded.new_str || decoded.replacement);
        const text = replacement ? '+' + patch : patch;
        const hit = text.match(pattern);
        if (hit) add(key, 'action', replacement ? 'lens-extension:decoded-replacement-pattern' : 'lens-extension:decoded-diff-pattern', replacement ? hit[0].slice(1) : hit[0]);
      }
    }
  }
  function extractSliceKeys(actionMsg, obsMsg, progress, options = {}) {
    return extractWithEvidence(actionMsg, obsMsg, progress, options).keys;
  }
  function extractParsedWithEvidence(step, progress) {
    const {add, finish} = extractor();
    if (step.tool_name) add('TOOL:' + step.tool_name, 'action', 'tracegraph:parsed-record:tool_name', step.tool_name);
    const command = step.command_class ?? 'other';
    if (command && command !== 'other') add('CMD:' + command, 'action', 'tracegraph:parsed-record:command_class', command);
    const action = step.action_type ?? 'other';
    if (action) add('ACTION:' + action, 'action', 'tracegraph:parsed-record:action_type', action);
    for (const sig of step.observation_signature || []) add('OBS:' + sig, 'observation', 'tracegraph:parsed-record:observation_signature', sig);
    for (const path of [...(step.files_touched || []), ...(step.files_read || [])]) {
      if (path.includes('/')) add('FILE_PATH:' + path.split('/').slice(-2).join('/'), 'action', 'tracegraph:parsed-record:files', path);
      if (path.includes('.')) {
        const ext = path.slice(path.lastIndexOf('.') + 1);
        if (ext && ext.length <= 6) add('FILE_EXT:' + ext, 'action', 'tracegraph:parsed-record:files', path);
      }
    }
    const phase = progress <= 0.33 ? 'early' : progress <= 0.67 ? 'mid' : 'late';
    add('PHASE:' + phase, 'progress', 'tracegraph:parsed-temporal-third', String(progress));
    return finish();
  }
  function extractParsedKeys(step, progress) { return extractParsedWithEvidence(step, progress).keys; }
  function buildIdfWeights(keySets) {
    const weights = Object.create(null), frequency = new Map(), n = keySets.length;
    for (const keys of keySets) for (const key of new Set(keys)) frequency.set(key, (frequency.get(key) || 0) + 1);
    for (const [key, count] of frequency) weights[key] = Math.log((1 + n) / (1 + count));
    return weights;
  }
  function weightedJaccard(left, right, idf) {
    const a = new Set(left), b = new Set(right), union = new Set([...a, ...b]);
    let intersectionWeight = 0, unionWeight = 0;
    for (const key of union) {
      const weight = Object.hasOwn(idf, key) ? idf[key] : 1;
      unionWeight += weight;
      if (a.has(key) && b.has(key)) intersectionWeight += weight;
    }
    return unionWeight > 0 ? intersectionWeight / unionWeight : 0;
  }
  function computePairwiseDistances(keySets, idf) {
    const rows = keySets.map(() => new Float32Array(keySets.length));
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const distance = Math.fround(1 - weightedJaccard(keySets[i], keySets[j], idf));
      rows[i][j] = distance; rows[j][i] = distance;
    }
    return rows;
  }
  function computeKnn(distances, k) {
    const n = distances.length, count = Math.max(0, Math.min(Math.floor(k), n - 1));
    return distances.map((row, i) => Array.from({length: n}, (_, j) => j).filter(j => j !== i)
      .sort((a, b) => row[a] - row[b] || a - b).slice(0, count));
  }
  function buildMutualKnnEdges(distances, k = 6, options = {}) {
    const knn = computeKnn(distances, k), neighbors = knn.map(row => new Set(row)), edges = [];
    const scale = Math.max(options.distScale ?? 0.35, 0.000001);
    for (let i = 0; i < knn.length; i++) for (const j of knn[i]) {
      if (j <= i || !neighbors[j].has(i)) continue;
      if (options.excludeSameRun && options.sliceRun && options.sliceRun[i] === options.sliceRun[j]) continue;
      const distance = Math.min(distances[i][j], distances[j][i]);
      edges.push({source: i, target: j, distance: +distance.toFixed(6), weight: +Math.exp(-distance / scale).toFixed(6)});
    }
    return edges;
  }
  function findArticulationPoints(adj) {
    // Iterative Tarjan port of TraceGraph's find_articulation_points. An
    // articulation is a cut vertex of this graph, not an inferred decision.
    const n = adj.length, disc = new Int32Array(n).fill(-1), low = new Int32Array(n);
    const parent = new Int32Array(n).fill(-1), isPoint = new Uint8Array(n);
    let timer = 0;
    for (let root = 0; root < n; root++) {
      if (disc[root] !== -1) continue;
      disc[root] = low[root] = timer++;
      let childCount = 0;
      const stack = [[root, 0]];
      while (stack.length) {
        const frame = stack[stack.length - 1], u = frame[0], index = frame[1];
        if (index < adj[u].length) {
          frame[1]++;
          const v = Math.trunc(Number(adj[u][index]));
          if (!Number.isFinite(v) || v === u || v < 0 || v >= n) continue;
          if (disc[v] === -1) {
            parent[v] = u; disc[v] = low[v] = timer++;
            if (u === root) childCount++;
            stack.push([v, 0]);
          } else if (v !== parent[u]) low[u] = Math.min(low[u], disc[v]);
        } else {
          stack.pop();
          if (stack.length) {
            const p = parent[u]; low[p] = Math.min(low[p], low[u]);
            if (p !== root && low[u] >= disc[p]) isPoint[p] = 1;
          }
        }
      }
      if (childCount > 1) isPoint[root] = 1;
    }
    return Array.from({length: n}, (_, index) => index).filter(index => isPoint[index]);
  }
  function findBiconnectedComponents(adj) {
    // Iterative Tarjan with an edge stack, matching the pinned implementation.
    // Articulations may belong to several blocks. Isolated nodes have no block;
    // a two-node bridge is retained as a trivial block, not a process cluster.
    const n = adj.length, disc = new Int32Array(n).fill(-1), low = new Int32Array(n);
    const parent = new Int32Array(n).fill(-1), edgeStack = [], blocks = [];
    let timer = 0;
    for (let root = 0; root < n; root++) {
      if (disc[root] !== -1) continue;
      disc[root] = low[root] = timer++;
      const stack = [[root, 0]];
      while (stack.length) {
        const frame = stack[stack.length - 1], u = frame[0];
        let index = frame[1], advanced = false;
        while (index < adj[u].length) {
          const v = Math.trunc(Number(adj[u][index++]));
          if (!Number.isFinite(v) || v === u || v < 0 || v >= n) continue;
          if (disc[v] === -1) {
            parent[v] = u; edgeStack.push([u, v]); disc[v] = low[v] = timer++;
            frame[1] = index; stack.push([v, 0]); advanced = true; break;
          } else if (v !== parent[u]) {
            if (disc[v] < disc[u]) edgeStack.push([u, v]);
            low[u] = Math.min(low[u], disc[v]);
          }
        }
        if (!advanced) {
          stack.pop();
          if (stack.length) {
            const p = parent[u]; low[p] = Math.min(low[p], low[u]);
            if (low[u] >= disc[p]) {
              const block = new Set();
              while (edgeStack.length) {
                const edge = edgeStack.pop(); block.add(edge[0]); block.add(edge[1]);
                if (edge[0] === p && edge[1] === u) break;
              }
              if (block.size) blocks.push(Array.from(block).sort((a, b) => a - b));
            }
          }
        }
      }
    }
    return blocks;
  }
  function isInvocation(event) {
    return event && event.kind === 'tool' && event.isInvocation !== false && !event.unmatchedOutput && Boolean(event.actionKey);
  }
  function eventFeatures(event, progress) {
    const rawFeatures = extractWithEvidence({tool_calls: [{function: {name: event.tool || 'unknown', arguments: event.inputText || ''}}]},
      {content: event.outputText || ''}, progress, {extensions: true});
    const parsed = (event.sourceRecords || []).map(source => source.record).find(record => record &&
      Object.hasOwn(record, 'raw_action') && (Object.hasOwn(record, 'command_class') || Object.hasOwn(record, 'observation_signature')));
    if (!parsed) return rawFeatures;
    const parsedFeatures = extractParsedWithEvidence(parsed, progress);
    // Parsed TraceGraph exports already carry observable metadata. Retain it
    // with explicit provenance, while still deriving additional raw-text keys.
    // Its pipeline uses <= .33/.67; use that phase rather than mixing policies.
    const rawKeys = rawFeatures.keys.filter(key => !key.startsWith('PHASE:'));
    return {keys: Array.from(new Set([...rawKeys, ...parsedFeatures.keys])).sort(),
      evidence: [...rawFeatures.evidence.filter(item => !item.key.startsWith('PHASE:')), ...parsedFeatures.evidence]};
  }
  function enrich(data) {
    const result = {...data, runs: (data.runs || []).map(run => {
      const invocationCount = (run.events || []).filter(isInvocation).length;
      let invocationIndex = 0;
      const events = (run.events || []).map(event => {
        if (!isInvocation(event)) return {...event};
        const progress = invocationCount > 1 ? invocationIndex / (invocationCount - 1) : 0;
        invocationIndex++;
        return {...event, features: eventFeatures(event, progress)};
      });
      return {...run, events};
    })};
    cachedCorpora.set(result, collectCorpus(result));
    return result;
  }
  function collectCorpus(data) {
    const nodes = [];
    for (const run of data.runs || []) {
      const events = run.events || [], invocationCount = events.filter(isInvocation).length;
      let invocationIndex = 0;
      events.forEach((event, eventIndex) => {
        if (!isInvocation(event)) return;
        const progress = invocationCount > 1 ? invocationIndex / (invocationCount - 1) : 0;
        const features = event.features || eventFeatures(event, progress);
        invocationIndex++;
        nodes.push({id: 'slice-' + nodes.length, runId: run.id, eventIndex, keys: features.keys,
          label: event.label || event.tool || 'Tool call'});
      });
    }
    return {nodes, idf: buildIdfWeights(nodes.map(node => node.keys))};
  }
  function corpus(data) { return cachedCorpora.get(data) || collectCorpus(data); }
  function related(data, runId, eventIndex, options = {}) {
    const {nodes, idf} = corpus(data), selected = nodes.find(n => n.runId === runId && n.eventIndex === eventIndex);
    if (!selected) return [];
    const selectedKeys = new Set(selected.keys), limit = Math.max(0, Math.floor(options.limit ?? 5));
    return nodes.filter(n => n !== selected && (!options.excludeSameRun || n.runId !== runId)).map(n => ({
      runId: n.runId, eventIndex: n.eventIndex, similarity: weightedJaccard(selected.keys, n.keys, idf),
      sharedKeys: n.keys.filter(key => selectedKeys.has(key)).sort()
    })).filter(n => n.similarity > 0 && n.similarity >= (options.minSimilarity ?? 0))
      .sort((a, b) => b.similarity - a.similarity || String(a.runId).localeCompare(String(b.runId)) || a.eventIndex - b.eventIndex).slice(0, limit);
  }
  function processGraph(data, options = {}) {
    const {nodes, idf} = corpus(data), maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 300));
    // Never silently sample; chronology, signatures and related-step search still
    // use all imported events when the quadratic map exceeds its display limit.
    if (nodes.length > maxNodes) return {nodes: [], edges: [], blocks: [], articulationPoints: [], idf, limited: true, totalNodes: nodes.length, maxNodes};
    const distances = computePairwiseDistances(nodes.map(node => node.keys), idf);
    const edges = buildMutualKnnEdges(distances, options.k ?? 6, {
      excludeSameRun: options.excludeSameRun, sliceRun: nodes.map(node => node.runId), distScale: 0.35
    }).map(edge => ({...edge, source: nodes[edge.source].id, target: nodes[edge.target].id,
      similarity: 1 - distances[edge.source][edge.target]}));
    // Upstream constructs all mutual-kNN edges. This browser extension hides weak
    // similarities only after kNN construction; it does not change the neighbors.
    const visibleEdges = edges.filter(edge => edge.similarity > 0 && edge.similarity >= (options.minSimilarity ?? 0.2));
    const nodeIndex = new Map(nodes.map((node, index) => [node.id, index])), adjacency = nodes.map(() => []);
    for (const edge of visibleEdges) {
      const source = nodeIndex.get(edge.source), target = nodeIndex.get(edge.target);
      adjacency[source].push(target); adjacency[target].push(source);
    }
    const blocks = findBiconnectedComponents(adjacency).map((indices, index) => ({
      id: 'block-' + index, nodeIds: indices.map(i => nodes[i].id),
      runIds: Array.from(new Set(indices.map(i => nodes[i].runId))), size: indices.length, trivial: indices.length <= 2
    }));
    const articulationPoints = findArticulationPoints(adjacency).map(index => nodes[index].id);
    return {nodes, edges: visibleEdges, blocks, articulationPoints, idf, limited: false, totalNodes: nodes.length, maxNodes,
      k: Math.min(options.k ?? 6, Math.max(0, nodes.length - 1)), minSimilarity: options.minSimilarity ?? 0.2};
  }
  return {SOURCE_COMMIT, classifyCommand, normalisePath, extractSliceKeys, extractWithEvidence, extractParsedKeys,
    buildIdfWeights, weightedJaccard, computePairwiseDistances, computeKnn, buildMutualKnnEdges,
    findArticulationPoints, findBiconnectedComponents,
    enrich, related, processGraph};
});
