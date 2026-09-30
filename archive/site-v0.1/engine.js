/* Trajectory Lens: dependency-free exact-state trace analysis. */
(function (root, factory) {
  'use strict';
  var engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  if (root) root.LensEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LIMITS = Object.freeze({ runs: 100, stepsPerRun: 2000, totalSteps: 20000 });
  var MODES = Object.freeze({
    explicit: 'Explicit state or state_id',
    keys: 'Exact sorted key set',
    action: 'Exact normalized action / tool call',
    text: 'Exact normalized full text'
  });

  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function fail(message) { throw new Error(message); }
  function normalizedText(value) { return value.trim().replace(/\s+/g, ' ').toLowerCase(); }
  function clipped(value, length) {
    var text = String(value).trim().replace(/\s+/g, ' ');
    return text.length > length ? text.slice(0, length - 1) + '\u2026' : text;
  }
  function optionalString(value, field) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') fail(field + ' must be text.');
    return value.trim() || undefined;
  }
  function finiteNonnegative(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(field + ' must be a finite, nonnegative number.');
    }
    return value;
  }
  function stateNodeId(state) {
    // Two independent integer hashes plus length keep graph IDs compact and
    // consistent across run filters. Full state values still decide equality.
    var first = 2166136261, second = 2246822519;
    for (var index = 0; index < state.length; index += 1) {
      var code = state.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489917);
    }
    return 's' + (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0') + '-' + state.length.toString(36);
  }
  function stableJSON(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(function (key) {
      return value[key] !== undefined;
    }).map(function (key) { return JSON.stringify(key) + ':' + stableJSON(value[key]); }).join(',') + '}';
  }
  function contentText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
    if (!isObject(value)) return '';
    if (typeof value.text === 'string') return value.text;
    if (isObject(value.text) && typeof value.text.value === 'string') return value.text.value;
    if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
    if (typeof value.output === 'string') return value.output;
    return '';
  }
  function actionText(raw, location) {
    if (own(raw, 'action') && raw.action !== null && raw.action !== undefined) {
      if (typeof raw.action === 'string') return raw.action;
      if (isObject(raw.action) || Array.isArray(raw.action)) return stableJSON(raw.action);
      fail(location + '.action must be text, an object, or an array.');
    }
    var calls = raw.tool_calls;
    if (calls !== undefined && calls !== null) {
      if (!Array.isArray(calls)) fail(location + '.tool_calls must be an array.');
      var callStrings = calls.map(function (call, index) {
        if (!isObject(call)) fail(location + '.tool_calls[' + index + '] must be an object.');
        var fn = isObject(call.function) ? call.function : call;
        var name = typeof fn.name === 'string' ? fn.name.trim() : '';
        if (!name) fail(location + '.tool_calls[' + index + '] has no tool name.');
        // IDs are transport identifiers, not action semantics. Arguments remain exact text.
        var args = fn.arguments === undefined ? '' : (typeof fn.arguments === 'string' ? fn.arguments : stableJSON(fn.arguments));
        return name + '(' + args + ')';
      });
      if (callStrings.length) return callStrings.join('\n');
    }
    if (isObject(raw.function_call)) {
      var legacy = raw.function_call;
      if (typeof legacy.name !== 'string' || !legacy.name.trim()) fail(location + '.function_call has no tool name.');
      return legacy.name + '(' + (legacy.arguments === undefined ? '' : (typeof legacy.arguments === 'string' ? legacy.arguments : stableJSON(legacy.arguments))) + ')';
    }
    if (typeof raw.tool === 'string') {
      return raw.tool + (raw.input === undefined ? '' : ' ' + (typeof raw.input === 'string' ? raw.input : stableJSON(raw.input)));
    }
    if (typeof raw.tool_name === 'string') return raw.tool_name;
    return '';
  }
  function tokenValue(raw, location) {
    var fields = ['tokens', 'token_count'];
    var result;
    fields.forEach(function (field) {
      if (raw[field] !== undefined && raw[field] !== null) {
        var number = finiteNonnegative(raw[field], location + '.' + field);
        if (result === undefined) result = number;
      }
    });
    if (raw.usage !== undefined && raw.usage !== null) {
      if (!isObject(raw.usage)) fail(location + '.usage must be an object.');
      var usage = raw.usage;
      ['total_tokens', 'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].forEach(function (field) {
        if (usage[field] !== undefined && usage[field] !== null) finiteNonnegative(usage[field], location + '.usage.' + field);
      });
      if (result === undefined && usage.total_tokens !== undefined && usage.total_tokens !== null) result = usage.total_tokens;
      if (result === undefined && usage.input_tokens !== undefined && usage.input_tokens !== null && usage.output_tokens !== undefined && usage.output_tokens !== null) {
        result = usage.input_tokens + usage.output_tokens;
      }
      if (result === undefined && usage.prompt_tokens !== undefined && usage.prompt_tokens !== null && usage.completion_tokens !== undefined && usage.completion_tokens !== null) {
        result = usage.prompt_tokens + usage.completion_tokens;
      }
    }
    if (result !== undefined) finiteNonnegative(result, location + '.tokens');
    return result;
  }
  function normalizeStep(raw, index, runId, modeCounts) {
    var location = 'Run "' + runId + '", step ' + (index + 1);
    if (typeof raw === 'string') raw = { text: raw };
    if (!isObject(raw)) fail(location + ' must be text or a step/message object.');
    var hasAuthoritativeText = typeof raw.text === 'string';
    if (!hasAuthoritativeText && raw.text !== undefined && raw.text !== null) fail(location + '.text must be text.');
    var action = actionText(raw, location);
    var text;
    if (hasAuthoritativeText) {
      // Canonical exports already contain the complete evidence text. Preserve it
      // exactly, including whitespace, instead of appending the retained action.
      text = raw.text;
    } else {
      var sections = [];
      function section(label, value) { if (value) sections.push({ label: label, value: value }); }
      section('THOUGHT', contentText(raw.thought));
      section('CONTENT', contentText(raw.content));
      section('ACTION', action);
      section('OBSERVATION', contentText(raw.observation));
      // Keep a single supplied string untouched. With multiple fields, labels
      // separate sources without trimming or modifying any supplied string.
      text = sections.length === 1 ? sections[0].value : sections.map(function (item) {
        return item.label + ':\n' + item.value;
      }).join('\n\n');
    }
    var explicit;
    if (raw.state !== undefined && raw.state !== null) explicit = raw.state;
    else if (raw.state_id !== undefined && raw.state_id !== null) explicit = raw.state_id;
    var state, mode, keys;
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' && typeof explicit !== 'number') fail(location + '.state / state_id must be text or a number.');
      if (typeof explicit === 'number' && !Number.isFinite(explicit)) fail(location + '.state must be finite.');
      if (!String(explicit).trim()) fail(location + '.state / state_id cannot be empty.');
      // Explicit IDs preserve case and whitespace. This is an exact identity, not a display label.
      state = 'explicit:' + typeof explicit + ':' + JSON.stringify(explicit);
      mode = 'explicit';
    }
    if (raw.keys !== undefined && raw.keys !== null) {
      if (!Array.isArray(raw.keys) || raw.keys.some(function (key) { return typeof key !== 'string' || !key.trim(); })) {
        fail(location + '.keys must be an array of nonempty strings.');
      }
      keys = Array.from(new Set(raw.keys)).sort();
      if (mode === undefined && keys.length) {
        state = 'keys:' + JSON.stringify(keys);
        mode = 'keys';
      }
    }
    if (mode === undefined && action.trim()) {
      state = 'action:' + normalizedText(action);
      mode = 'action';
    }
    if (mode === undefined && text.trim()) {
      state = 'text:' + normalizedText(text);
      mode = 'text';
    }
    if (mode === undefined) fail(location + ' has no usable state, keys, action, or text. A label alone is not state evidence.');
    var label = optionalString(raw.label, location + '.label') || (explicit !== undefined ? String(explicit) : (keys && keys.length ? keys.join(' + ') : (action || text)));
    var result = { state: state, label: clipped(label, 96), text: hasAuthoritativeText ? text : (text || action || String(explicit === undefined ? keys.join(', ') : explicit)), matchingMode: mode };
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' && typeof raw.id !== 'number') fail(location + '.id must be text or a number.');
      result.id = String(raw.id);
    }
    if (keys !== undefined) result.keys = keys;
    var tokens = tokenValue(raw, location);
    if (tokens !== undefined) result.tokens = tokens;
    if (raw.duration_ms !== undefined && raw.duration_ms !== null) result.duration_ms = finiteNonnegative(raw.duration_ms, location + '.duration_ms');
    if (typeof raw.role === 'string') result.role = raw.role;
    Object.defineProperty(result, '__lensOrigin', { value: { explicit: explicit, action: action } });
    modeCounts[mode] += 1;
    return result;
  }
  function outcomeOf(raw, location) {
    var value = raw.outcome;
    if (value !== undefined && value !== null) {
      if (value !== 'success' && value !== 'failure' && value !== 'unknown') fail(location + '.outcome must be success, failure, or unknown.');
      return value;
    }
    if (typeof raw.success === 'boolean') return raw.success ? 'success' : 'failure';
    if (raw.status === 'success' || raw.status === 'succeeded') return 'success';
    if (raw.status === 'failure' || raw.status === 'failed') return 'failure';
    return 'unknown';
  }
  function normalize(input) {
    if (!isObject(input) && !Array.isArray(input)) fail('The input must be a JSON object or an array of runs.');
    var records, meta = {};
    if (Array.isArray(input)) records = input;
    else {
      meta = input;
      if (own(input, 'runs')) {
        if (!Array.isArray(input.runs)) fail('runs must be an array.');
        records = input.runs;
      } else if (Array.isArray(input.steps) || Array.isArray(input.trajectory) || Array.isArray(input.messages)) records = [input];
      else fail('No trajectories found. Supply runs, steps, trajectory, or messages.');
    }
    if (!records.length) fail('There are no runs to import.');
    if (records.length > LIMITS.runs) fail('At most ' + LIMITS.runs + ' runs can be imported.');
    var ids = new Set(), totalSteps = 0, runTokenTotalsIgnored = 0;
    var modeCounts = { explicit: 0, keys: 0, action: 0, text: 0 };
    var runs = records.map(function (raw, index) {
      if (!isObject(raw)) fail('Run ' + (index + 1) + ' must be an object with steps, trajectory, or messages.');
      var idValue = raw.id !== undefined ? raw.id : raw.run_id;
      if (idValue !== undefined && idValue !== null && typeof idValue !== 'string' && typeof idValue !== 'number') fail('Run ' + (index + 1) + '.id must be text or a number.');
      if (typeof idValue === 'number' && !Number.isFinite(idValue)) fail('Run ' + (index + 1) + '.id must be finite.');
      var id = idValue === undefined || idValue === null ? 'run-' + (index + 1) : String(idValue).trim();
      if (!id) fail('Run ' + (index + 1) + '.id cannot be empty.');
      if (ids.has(id)) fail('Duplicate run ID: "' + id + '". Every run needs a unique ID.');
      ids.add(id);
      if (tokenValue(raw, 'Run "' + id + '"') !== undefined) runTokenTotalsIgnored += 1;
      if (raw.duration_ms !== undefined && raw.duration_ms !== null) finiteNonnegative(raw.duration_ms, 'Run "' + id + '".duration_ms');
      var steps;
      if (own(raw, 'steps')) steps = raw.steps;
      else if (own(raw, 'trajectory')) steps = raw.trajectory;
      else if (own(raw, 'messages')) steps = raw.messages;
      if (!Array.isArray(steps) || !steps.length) fail('Run "' + id + '" needs a nonempty steps, trajectory, or messages array.');
      if (steps.length > LIMITS.stepsPerRun) fail('Run "' + id + '" exceeds ' + LIMITS.stepsPerRun + ' steps.');
      totalSteps += steps.length;
      if (totalSteps > LIMITS.totalSteps) fail('The dataset exceeds ' + LIMITS.totalSteps + ' total steps.');
      var run = { id: id, model: optionalString(raw.model, 'Run "' + id + '".model') || 'Unspecified', outcome: outcomeOf(raw, 'Run "' + id + '"'), steps: steps.map(function (step, stepIndex) { return normalizeStep(step, stepIndex, id, modeCounts); }) };
      if (typeof raw.name === 'string' && raw.name.trim()) run.name = raw.name.trim();
      return run;
    });
    var warnings = [];
    var modes = Object.keys(modeCounts).filter(function (mode) { return modeCounts[mode] > 0; });
    if (modeCounts.text) warnings.push(modeCounts.text + ' steps use full-text equality after lowercasing and whitespace normalization. Different wording remains a different state.');
    if (modeCounts.action) warnings.push(modeCounts.action + ' steps use exact action/tool text after lowercasing and whitespace normalization. Tool arguments are included; transport call IDs are excluded.');
    if (modes.length > 1) warnings.push('This dataset mixes state matching modes. Identities from different modes never merge.');
    if (runTokenTotalsIgnored) warnings.push('Token totals recorded on ' + runTokenTotalsIgnored + ' run objects are not distributed across steps. Only step-level token counts enter metrics.');
    var tokenSteps = runs.reduce(function (sum, run) { return sum + run.steps.filter(function (step) { return step.tokens !== undefined; }).length; }, 0);
    if (tokenSteps !== totalSteps) warnings.push('Token counts are present for ' + tokenSteps + ' of ' + totalSteps + ' steps. Missing values are unknown; totals include only recorded step counts.');
    warnings.push('These are exact identity comparisons, not semantic matching or an implementation of the TraceGraph algorithm. A repeated state is not proof of wasted work.');
    var data = { name: optionalString(meta.name, 'Dataset name') || 'Imported trajectories', runs: runs, matching: { modes: modes, counts: modeCounts, total: totalSteps, descriptions: MODES }, warnings: warnings };
    var description = optionalString(meta.description, 'Dataset description');
    var source = optionalString(meta.source, 'Dataset source');
    if (description) data.description = description;
    if (source) data.source = source;
    // Non-enumerable marker keeps JSON export readable and avoids re-encoding identities.
    Object.defineProperty(data, '__lensNormalized', { value: true });
    return data;
  }
  function parse(text, filename) {
    if (typeof text !== 'string' || !text.trim()) fail('The file is empty.');
    text = text.replace(/^\uFEFF/, '');
    var value;
    var jsonl = typeof filename === 'string' && /\.(jsonl|ndjson)$/i.test(filename);
    if (!jsonl) {
      try { value = JSON.parse(text); }
      catch (error) {
        // Multiple valid JSON records are a useful JSONL fallback, but malformed
        // ordinary JSON must not become an apparently successful one-line import.
        if (text.trim().split(/\r?\n/).filter(function (line) { return line.trim(); }).length < 2) fail('Invalid JSON: ' + error.message);
        jsonl = true;
      }
    }
    if (jsonl) {
      var lines = text.split(/\r?\n/);
      value = [];
      lines.forEach(function (line, index) {
        if (!line.trim()) return;
        try { value.push(JSON.parse(line)); }
        catch (error) { fail('Invalid JSONL on line ' + (index + 1) + ': ' + error.message); }
      });
      if (!value.length) fail('The JSONL file contains no records.');
    }
    var data = normalize(value);
    if (data.name === 'Imported trajectories' && filename) data.name = String(filename).replace(/^.*[\\/]/, '').replace(/\.(json|jsonl|ndjson)$/i, '');
    return data;
  }
  function asNormalized(data) { return data && data.__lensNormalized === true ? data : normalize(data); }
  function analyze(input) {
    var data = asNormalized(input);
    var stateNames = new Set();
    data.runs.forEach(function (run) { run.steps.forEach(function (step) { stateNames.add(step.state); }); });
    var stateIds = new Map(), nodeMap = new Map();
    var usedNodeIds = new Map();
    Array.from(stateNames).sort().forEach(function (state) {
      var id = stateNodeId(state);
      // A hash collision must never merge two identities. The collision-only
      // suffix encodes the complete value rather than guessing equivalence.
      if (usedNodeIds.has(id) && usedNodeIds.get(id) !== state) {
        id += '-' + Array.from(state).map(function (character) { return character.codePointAt(0).toString(16); }).join('_');
      }
      usedNodeIds.set(id, state);
      stateIds.set(state, id);
    });
    var edges = new Map(), runPaths = {}, perRun = [], sets = new Map();
    var totalTokens = 0, knownTokens = 0, totalSteps = 0, totalRevisits = 0;
    data.runs.forEach(function (run) {
      var path = [], states = new Set(), tokenSum = 0, tokenCount = 0, durationSum = 0, durationCount = 0;
      run.steps.forEach(function (step, index) {
        var id = stateIds.get(step.state);
        path.push(id);
        states.add(step.state);
        var node = nodeMap.get(id);
        if (!node) {
          node = { id: id, state: step.state, label: step.label, text: step.text, matchingMode: step.matchingMode, runIds: new Set(), visits: 0, _progress: 0 };
          nodeMap.set(id, node);
        }
        node.runIds.add(run.id);
        node.visits += 1;
        node._progress += run.steps.length === 1 ? 0 : index / (run.steps.length - 1);
        if (index > 0) {
          var source = path[index - 1], edgeKey = source + ':' + id;
          var edge = edges.get(edgeKey);
          if (!edge) { edge = { source: source, target: id, count: 0, runIds: new Set() }; edges.set(edgeKey, edge); }
          edge.count += 1;
          edge.runIds.add(run.id);
        }
        if (step.tokens !== undefined) { tokenSum += step.tokens; tokenCount += 1; finiteNonnegative(tokenSum, 'Recorded token sum for run "' + run.id + '"'); }
        if (step.duration_ms !== undefined) { durationSum += step.duration_ms; durationCount += 1; finiteNonnegative(durationSum, 'Recorded duration sum for run "' + run.id + '"'); }
      });
      var revisits = run.steps.length - states.size;
      perRun.push({ id: run.id, model: run.model, outcome: run.outcome, steps: run.steps.length, uniqueStates: states.size, revisits: revisits, revisitRate: revisits / run.steps.length, totalTokens: tokenCount ? tokenSum : null, tokensComplete: tokenCount === run.steps.length, knownTokenSteps: tokenCount, totalDurationMs: durationCount ? durationSum : null, durationComplete: durationCount === run.steps.length });
      // Define safely even for imported IDs such as __proto__.
      Object.defineProperty(runPaths, run.id, { value: path, enumerable: true });
      sets.set(run.id, states);
      totalSteps += run.steps.length;
      totalRevisits += revisits;
      totalTokens += tokenSum;
      finiteNonnegative(totalTokens, 'Recorded token sum for the dataset');
      knownTokens += tokenCount;
    });
    var overlaps = [];
    for (var i = 0; i < data.runs.length; i += 1) {
      for (var j = i + 1; j < data.runs.length; j += 1) {
        var a = data.runs[i].id, b = data.runs[j].id, aSet = sets.get(a), bSet = sets.get(b), shared = [];
        aSet.forEach(function (state) { if (bSet.has(state)) shared.push(stateIds.get(state)); });
        var union = aSet.size + bSet.size - shared.length;
        overlaps.push({ a: a, b: b, intersection: shared.length, union: union, jaccard: shared.length / union, sharedStates: shared.sort() });
      }
    }
    var nodes = Array.from(nodeMap.values()).map(function (node) {
      node.runIds = Array.from(node.runIds);
      node.progress = node._progress / node.visits;
      delete node._progress;
      return node;
    });
    var edgeList = Array.from(edges.values()).map(function (edge) { edge.runIds = Array.from(edge.runIds); return edge; });
    var totals = { runs: data.runs.length, steps: totalSteps, uniqueStates: nodes.length, transitions: edgeList.reduce(function (sum, edge) { return sum + edge.count; }, 0), uniqueEdges: edgeList.length, revisits: totalRevisits, revisitRate: totalRevisits / totalSteps, sharedStates: nodes.filter(function (node) { return node.runIds.length > 1; }).length, successes: data.runs.filter(function (run) { return run.outcome === 'success'; }).length, failures: data.runs.filter(function (run) { return run.outcome === 'failure'; }).length, unknown: data.runs.filter(function (run) { return run.outcome === 'unknown'; }).length, totalTokens: knownTokens ? totalTokens : null, knownTokenSteps: knownTokens, tokensComplete: knownTokens === totalSteps };
    return { nodes: nodes, edges: edgeList, perRun: perRun, overlaps: overlaps, runPaths: runPaths, totals: totals, matching: data.matching, warnings: data.warnings.slice() };
  }
  function firstDivergence(input, aId, bId) {
    var data = asNormalized(input);
    var a = data.runs.find(function (run) { return run.id === aId; });
    var b = data.runs.find(function (run) { return run.id === bId; });
    if (!a || !b) fail('Choose two existing run IDs to compare.');
    var index = 0;
    while (index < a.steps.length && index < b.steps.length && a.steps[index].state === b.steps[index].state) index += 1;
    var identical = index === a.steps.length && index === b.steps.length;
    function detail(run) { var step = run.steps[index]; return step ? { state: step.state, label: step.label, text: step.text, index: index } : null; }
    return { runA: a.id, runB: b.id, index: index, prefixLength: index, identical: identical, reason: identical ? 'identical' : (index === a.steps.length || index === b.steps.length ? 'run-ended' : 'state-mismatch'), a: detail(a), b: detail(b) };
  }
  function markdownText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+!|])/g, '\\$1').replace(/[\r\n]+/g, ' ');
  }
  function percent(value) { return (value * 100).toFixed(1) + '%'; }
  function toCanonical(input) {
    var data = asNormalized(input);
    var result = { name: data.name, runs: data.runs.map(function (run) {
      var output = { id: run.id, model: run.model, outcome: run.outcome, steps: run.steps.map(function (step) {
        var value = { label: step.label, text: step.text };
        var origin = step.__lensOrigin;
        if (origin.explicit !== undefined) value.state = origin.explicit;
        if (step.keys !== undefined) value.keys = step.keys.slice();
        if (origin.action) value.action = origin.action;
        if (step.id !== undefined) value.id = step.id;
        if (step.tokens !== undefined) value.tokens = step.tokens;
        if (step.duration_ms !== undefined) value.duration_ms = step.duration_ms;
        if (step.role !== undefined) value.role = step.role;
        return value;
      }) };
      if (run.name) output.name = run.name;
      return output;
    }) };
    if (data.description) result.description = data.description;
    if (data.source) result.source = data.source;
    return result;
  }
  function exportJSON(input) { return JSON.stringify(toCanonical(input), null, 2) + '\n'; }
  function exportMarkdown(input, suppliedAnalysis) {
    var data = asNormalized(input), result = suppliedAnalysis || analyze(data), totals = result.totals;
    var lines = ['# Trajectory Lens \u2014 ' + markdownText(data.name), '', 'A local exact-state comparison of imported trajectories.', ''];
    if (data.description) lines.push(markdownText(data.description), '');
    if (data.source) lines.push('Source: ' + markdownText(data.source), '');
    lines.push('## Dataset', '', '- Runs: ' + totals.runs, '- Steps: ' + totals.steps, '- Unique states across all runs: ' + totals.uniqueStates, '- States shared by multiple runs: ' + totals.sharedStates, '- State revisits within runs: ' + totals.revisits + ' (' + percent(totals.revisitRate) + ' of steps)', '- Outcomes recorded: ' + totals.successes + ' success, ' + totals.failures + ' failure, ' + totals.unknown + ' unknown', '- Recorded tokens: ' + (totals.totalTokens === null ? 'unknown' : totals.totalTokens.toLocaleString('en-US')) + ' (' + totals.knownTokenSteps + '/' + totals.steps + ' steps have counts; ' + (totals.tokensComplete ? 'complete' : 'incomplete') + ')', '', '## Per-run metrics', '', '| Run | Model | Outcome | Steps | Unique states | Revisits | Revisit rate | Recorded tokens | Token coverage |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    result.perRun.forEach(function (run) { lines.push('| ' + [markdownText(run.id), markdownText(run.model), run.outcome, run.steps, run.uniqueStates, run.revisits, percent(run.revisitRate), run.totalTokens === null ? 'unknown' : run.totalTokens, run.knownTokenSteps + '/' + run.steps + (run.tokensComplete ? ' complete' : ' incomplete')].join(' | ') + ' |'); });
    lines.push('', '## Pairwise state overlap', '', 'Jaccard = shared exact states / union of exact states. Repeated visits do not increase overlap.', '');
    if (!result.overlaps.length) lines.push('A second run is needed for pairwise comparison.');
    else {
      lines.push('| Run A | Run B | Shared states | Union | Jaccard | Shared prefix | First divergence |', '| --- | --- | ---: | ---: | ---: | ---: | --- |');
      result.overlaps.forEach(function (overlap) {
        var divergence = firstDivergence(data, overlap.a, overlap.b);
        var detail = divergence.identical ? 'Identical exact state sequence' : (divergence.reason === 'run-ended' ? 'One run ends after the prefix' : 'Step ' + (divergence.index + 1) + ': ' + markdownText(divergence.a.label) + ' / ' + markdownText(divergence.b.label));
        lines.push('| ' + [markdownText(overlap.a), markdownText(overlap.b), overlap.intersection, overlap.union, percent(overlap.jaccard), divergence.prefixLength, detail].join(' | ') + ' |');
      });
    }
    lines.push('', '## Matching and interpretation', '', 'Matching precedence is explicit state/state_id, then a sorted unique key set, then action/tool text, then full text. Explicit IDs and key strings preserve case and whitespace; fallback text lowercases and collapses whitespace. Labels are clipped for display; identities always use the full value.', '');
    Object.keys(MODES).forEach(function (mode) { lines.push('- ' + MODES[mode] + ': ' + data.matching.counts[mode] + ' steps'); });
    lines.push('', 'A revisit is any visit after the first occurrence of an exact state within the same run. Revisit rate divides revisits by all steps. State progress averages relative step positions across all visits (a one-step run has progress 0). First divergence compares only the shared exact prefix. Outcomes come only from explicit outcome, success, or success/failure status fields; message wording does not determine success.', '', 'Token totals sum only step-level counts present in the import. No tokens, duration, quality, or saved cost are estimated. A run-level token total is not distributed across steps.', '');
    data.warnings.forEach(function (warning) { lines.push('- ' + markdownText(warning)); });
    return lines.join('\n') + '\n';
  }

  return Object.freeze({ normalize: normalize, parse: parse, analyze: analyze, firstDivergence: firstDivergence, exportMarkdown: exportMarkdown, toCanonical: toCanonical, exportJSON: exportJSON, limits: LIMITS, matchingModes: MODES });
});
