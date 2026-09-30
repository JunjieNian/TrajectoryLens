/* Trajectory Lens: raw recorded operations, exact pairing, no dependencies. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LensRaw = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var FORMAT = 'trajectory-lens/raw-v1';
  var LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, runs: 100, eventsPerRun: 2000, events: 20000 });
  var has = function (value, key) { return Object.prototype.hasOwnProperty.call(value, key); };
  var object = function (value) { return value !== null && typeof value === 'object' && !Array.isArray(value); };
  var error = function (message) { throw new Error(message); };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stable(value[key]); }).join(',') + '}';
  }
  function bytes(text) { return new TextEncoder().encode(text).length; }
  function display(value) { return value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)); }
  function title(filename) { return String(filename || 'Imported traces').replace(/^.*[\\/]/, '').replace(/\.(jsonl|ndjson|json|traj)$/i, '') || 'Imported traces'; }
  function textContent(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(textContent).filter(function (part) { return part !== ''; }).join('\n');
    if (object(value)) {
      if (typeof value.text === 'string') return value.text;
      if (object(value.text) && typeof value.text.value === 'string') return value.text.value;
      if (typeof value.thinking === 'string') return value.thinking;
      if (typeof value.refusal === 'string') return value.refusal;
      if (has(value, 'content')) return textContent(value.content);
    }
    return display(value);
  }
  function invocationKey(tool, input, provided) {
    if (!provided) return 'call:' + stable([tool, 'missing']);
    if (typeof input === 'string') {
      try { var parsed = JSON.parse(input); return numericPrecisionRisk(input) ? 'call:' + stable([tool, 'json-raw', input]) : 'call:' + stable([tool, 'json', parsed]); }
      catch (_) { return 'call:' + stable([tool, 'text', input]); }
    }
    return 'call:' + stable([tool, 'json', input]);
  }
  function numericPrecisionRisk(text) {
    function decimal(token) {
      var match = token.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
      var digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
      if (!digits) return '0';
      var exponent = Number(match[4] || 0) - (match[3] || '').length;
      while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent += 1; }
      return match[1] + digits + 'e' + exponent;
    }
    for (var index = 0; index < text.length; index += 1) {
      if (text[index] === '"') {
        index += 1;
        while (index < text.length) { if (text[index] === '\\') index += 2; else if (text[index] === '"') break; else index += 1; }
      } else if (text[index] === '-' || /[0-9]/.test(text[index])) {
        var match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (!match) return true;
        var token = match[0], value = Number(token);
        if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || decimal(token) !== decimal(String(value))) return true;
        index += token.length - 1;
      }
    }
    return false;
  }
  function inferredHasOutput(event) {
    if (event.kind !== 'tool') return false;
    if (event.unmatchedOutput || event.isInvocation === false || event.outputText !== '') return true;
    return (event.sourceRecords || []).some(function (source) {
      var record = source.record;
      if (!object(record)) return false;
      if (record.type === 'response_item' && object(record.payload)) record = record.payload;
      if (['function_call_output', 'custom_tool_call_output', 'tool_result'].indexOf(record.type) >= 0 || record.role === 'tool' || record.role === 'function') return true;
      return (has(record, 'action') || has(record, 'raw_action')) && ['observation', 'raw_observation', 'output', 'result'].some(function (field) { return has(record, field); });
    });
  }
  function withOutputFlags(data) {
    data.runs.forEach(function (run) { run.events.forEach(function (event) {
      if (!has(event, 'hasOutput')) {
        event.hasOutput = inferredHasOutput(event);
        // Earlier raw-v1 exports had no output flag and could carry rounded
        // numeric keys. The preserved argument text remains authoritative.
        if (event.actionKey && typeof event.tool === 'string') event.actionKey = invocationKey(event.tool, event.inputText, event.inputProvided !== false);
      }
    }); });
    return data;
  }
  function statusEvidence(value, codexWrapper) {
    var candidate = value;
    if (typeof candidate === 'string') {
      try { var parsed = JSON.parse(candidate); if (object(parsed)) candidate = parsed; } catch (_) {}
    }
    if (object(candidate)) {
      if (has(candidate, 'exit_code')) {
        if (typeof candidate.exit_code !== 'number' || !Number.isFinite(candidate.exit_code)) error('exit_code must be a finite number.');
        return { status: candidate.exit_code === 0 ? 'ok' : 'error', basis: 'reported exit_code=' + candidate.exit_code };
      }
      if (typeof candidate.is_error === 'boolean') return { status: candidate.is_error ? 'error' : 'ok', basis: 'reported is_error=' + candidate.is_error };
      if (typeof candidate.status === 'string') {
        var status = candidate.status.toLowerCase();
        if (['error', 'failed', 'failure'].indexOf(status) >= 0) return { status: 'error', basis: 'reported status=' + candidate.status };
        if (['ok', 'success', 'succeeded', 'completed'].indexOf(status) >= 0) return { status: 'ok', basis: 'reported status=' + candidate.status };
        if (['pending', 'running', 'in_progress', 'queued'].indexOf(status) >= 0) return { status: 'pending', basis: 'reported status=' + candidate.status };
      }
      // Structured wrappers only. Arbitrary text containing "error" or "FAILED"
      // never labels an operation, much less the task outcome.
      var nested = ['output', 'result', 'observation'];
      for (var i = 0; i < nested.length; i += 1) {
        if (has(candidate, nested[i])) {
          var evidence = statusEvidence(candidate[nested[i]], codexWrapper);
          if (evidence) return evidence;
        }
      }
    }
    if (codexWrapper && typeof value === 'string') {
      // Native terminal transport convention, not a keyword heuristic. Require
      // the terminal wrapper header and an entire reported-exit-code line.
      var match = value.match(/(?:^|\r?\n)Process exited with code (-?\d+)(?:\r?\n|$)/);
      if (match && /(?:^|\r?\n)(?:Chunk ID:|Wall time:|Final output:|Output:)/.test(value)) {
        var exit = Number(match[1]);
        return { status: exit === 0 ? 'ok' : 'error', basis: 'Codex terminal wrapper reported-exit-code=' + exit };
      }
    }
    return null;
  }
  function applyStatus(event, evidence) {
    if (!evidence) return;
    if (event.status === 'error' && evidence.status !== 'error') return;
    event.status = evidence.status;
    event.statusBasis = evidence.basis;
  }
  function explicitOutcome(raw) {
    if (raw.outcome !== undefined) {
      if (['unknown', 'success', 'failure'].indexOf(raw.outcome) < 0) error('outcome must be unknown, success, or failure.');
      return raw.outcome;
    }
    if (typeof raw.success === 'boolean') return raw.success ? 'success' : 'failure';
    if (typeof raw.resolved === 'boolean') return raw.resolved ? 'success' : 'failure';
    if (typeof raw.is_resolved === 'boolean') return raw.is_resolved ? 'success' : 'failure';
    if (object(raw.metadata) && (raw.metadata.resolved_score === 0 || raw.metadata.resolved_score === 1)) return raw.metadata.resolved_score === 1 ? 'success' : 'failure';
    return 'unknown';
  }
  // JSON.parse decides validity. This scanner only retains the exact byte-text
  // span, line and path of each supplied object, including pretty-printed JSON.
  // It prevents an entire multi-message document from being copied per event.
  function indexSource(text, parsed, sources, lineOffset) {
    var pos = 0, lineStarts = [0];
    for (var t = 0; t < text.length; t += 1) if (text[t] === '\n') lineStarts.push(t + 1);
    function skip() { while (/\s/.test(text[pos] || '') && pos < text.length) pos += 1; }
    function stringEnd() { pos += 1; while (pos < text.length) { if (text[pos] === '\\') pos += 2; else if (text[pos++] === '"') break; } }
    function lineAt(offset) { var low = 0, high = lineStarts.length; while (low + 1 < high) { var mid = (low + high) >> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; } return (lineOffset || 0) + low + 1; }
    function visit(value, path) {
      skip(); var start = pos, opening = text[pos];
      if (opening === '{') {
        pos += 1; skip();
        while (text[pos] !== '}') {
          var keyStart = pos; stringEnd(); var key = JSON.parse(text.slice(keyStart, pos)); skip(); pos += 1;
          visit(value[key], path.concat(key)); skip(); if (text[pos] !== ',') break; pos += 1; skip();
        }
        pos += 1;
      } else if (opening === '[') {
        pos += 1; skip(); var index = 0;
        while (text[pos] !== ']') { visit(value[index], path.concat(index)); index += 1; skip(); if (text[pos] !== ',') break; pos += 1; skip(); }
        pos += 1;
      } else if (opening === '"') stringEnd();
      else { while (pos < text.length && !/[\s,}\]]/.test(text[pos])) pos += 1; }
      if (value !== null && typeof value === 'object') sources.set(value, { line: lineAt(start), rawText: text.slice(start, pos), path: path.length ? path.map(String).join('.') : '$' });
    }
    visit(parsed, []);
  }
  function sourceRecord(value, type, sources, fallback) {
    var indexed = value && typeof value === 'object' ? sources.get(value) : undefined;
    return { line: indexed ? indexed.line : (fallback || 1), type: type, rawText: indexed ? indexed.rawText : JSON.stringify(value), record: value, path: indexed ? indexed.path : '$' };
  }
  function createBuilder(raw, ordinal, filename, sourceFormat, warnings, sources) {
    var originalId = raw.id !== undefined ? raw.id : raw.run_id;
    if (originalId === undefined && raw.instance_id !== undefined) originalId = String(raw.instance_id) + '/run-' + ordinal;
    if (originalId !== undefined && typeof originalId !== 'string' && typeof originalId !== 'number') error('Run ID must be a string or number.');
    var id = originalId === undefined ? 'run-' + ordinal : String(originalId);
    if (!id.trim()) error('Run ID cannot be empty.');
    var run = { id: id, name: typeof raw.name === 'string' && raw.name ? raw.name : id, model: typeof raw.model === 'string' ? raw.model : (typeof raw.model_id === 'string' ? raw.model_id : 'Unspecified'), source: { format: sourceFormat, filename: filename || 'pasted.json' }, outcome: explicitOutcome(raw), events: [] };
    ['benchmark', 'dataset', 'task', 'instance_id', 'metadata'].forEach(function (key) { if (has(raw, key)) { if (!run.source.metadata) run.source.metadata = {}; run.source.metadata[key] = raw[key]; } });
    var calls = new Map(), outputs = [], counter = 0, primaryCount = 0, unused = [];
    function add(event, isOutput) {
      if (!isOutput) { if (primaryCount >= LIMITS.eventsPerRun) error('Run "' + run.id + '" exceeds 2,000 events.'); primaryCount += 1; }
      event.id = 'event-' + (++counter); event.index = run.events.length;
      run.events.push(event); return event;
    }
    function record(value, type) { return sourceRecord(value, type, sources); }
    function message(value, role, source, mirror, turn) {
      var text = textContent(value);
      if (text === '') return;
      if (mirror) {
        for (var i = run.events.length - 1; i >= Math.max(0, run.events.length - 12); i -= 1) {
          var prior = run.events[i];
          if (prior.kind === 'message' && prior._mirror && prior._mirror !== mirror && !prior._mirrored && prior._turn === turn && prior.role === role && prior.text === text) {
            prior.sourceRecords.push(source); prior._mirrored = true; return;
          }
        }
      }
      var event = add({ kind: 'message', label: role ? role + ' message' : 'Recorded message', role: role || 'unspecified', inputText: '', outputText: '', hasOutput: false, text: text, status: 'unknown', sourceRecords: [source] });
      event._mirror = mirror; event._turn = turn;
    }
    function call(tool, input, provided, callId, source, rawCall) {
      if (typeof tool !== 'string' || !tool.trim()) error('A recorded tool call has no tool name (source line ' + source.line + ').');
      var inputSource = input !== null && typeof input === 'object' ? sources.get(input) : undefined;
      var inputText = inputSource ? inputSource.rawText : display(input);
      var event = add({ kind: 'tool', label: tool, tool: tool, inputText: inputText, inputProvided: provided, outputText: '', hasOutput: false, text: inputText, status: 'pending', actionKey: invocationKey(tool, inputText, provided), isInvocation: true, sourceRecords: [source] });
      if (event.actionKey.startsWith('call:[' + JSON.stringify(tool) + ',"json-raw",')) warnings.push('Run "' + run.id + '": numeric precision in arguments at source line ' + source.line + ' requires exact argument-text matching; JSON key order and formatting remain significant for this call.');
      if (callId !== undefined && callId !== null && String(callId) !== '') {
        if (typeof callId !== 'string' && typeof callId !== 'number') error('Tool call IDs must be strings or numbers.');
        event.callId = String(callId); if (!calls.has(event.callId)) calls.set(event.callId, []); calls.get(event.callId).push(event);
      }
      applyStatus(event, statusEvidence(rawCall, false));
      return event;
    }
    function output(callId, value, source, rawOutput, codexWrapper, tool) {
      var event = add({ kind: 'tool', label: tool || 'Unmatched tool output', tool: tool || 'Unknown tool', inputText: '', outputText: textContent(value), hasOutput: true, text: textContent(value), status: 'unknown', isInvocation: false, unmatchedOutput: true, sourceRecords: [source] }, true);
      if (callId !== undefined && callId !== null && String(callId) !== '') event.callId = String(callId);
      applyStatus(event, statusEvidence(rawOutput, codexWrapper) || statusEvidence(value, codexWrapper));
      outputs.push(event); return event;
    }
    function process(rawItem, sourceOverride, mirror, turn) {
      if (typeof rawItem === 'string') { message(rawItem, 'unspecified', record(rawItem, 'text')); return; }
      if (!object(rawItem)) error('A trajectory record must be an object or text.');
      var source = sourceOverride || record(rawItem, rawItem.type || (rawItem.role ? 'message' : 'step'));
      if (rawItem.type === 'function_call' || rawItem.type === 'custom_tool_call' || rawItem.type === 'tool_use') {
        var argField = rawItem.type === 'tool_use' ? 'input' : (rawItem.type === 'custom_tool_call' ? 'input' : 'arguments');
        call(rawItem.name, rawItem[argField], has(rawItem, argField), rawItem.call_id !== undefined ? rawItem.call_id : rawItem.id, source, rawItem); return;
      }
      if (rawItem.type === 'function_call_output' || rawItem.type === 'custom_tool_call_output' || rawItem.type === 'tool_result') {
        output(rawItem.call_id !== undefined ? rawItem.call_id : rawItem.tool_use_id, rawItem.type === 'tool_result' ? rawItem.content : rawItem.output, source, rawItem, !!sourceOverride, rawItem.name); return;
      }
      if (rawItem.role === 'tool' || rawItem.role === 'function') {
        output(rawItem.tool_call_id !== undefined ? rawItem.tool_call_id : rawItem.call_id, rawItem.content, source, rawItem, false, rawItem.name); return;
      }
      if ((Array.isArray(rawItem.content) || rawItem.role || rawItem.type === 'message' || rawItem.tool_calls !== undefined || rawItem.function_call !== undefined) && !has(rawItem, 'action') && !has(rawItem, 'raw_action')) {
        var content = rawItem.content, textual = [];
        if (Array.isArray(content)) {
          function flushText() { if (textual.length) { message(textual.filter(function (part) { return part !== ''; }).join('\n'), rawItem.role || 'assistant', source, mirror, turn); textual = []; } }
          content.forEach(function (block) {
            if (object(block) && ['tool_use', 'tool_result', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].indexOf(block.type) >= 0) { flushText(); process(block, sourceOverride); }
            else textual.push(textContent(block));
          });
          flushText(); content = undefined;
        }
        if (content !== undefined && content !== null) message(content, rawItem.role || 'assistant', source, mirror, turn);
        if (rawItem.refusal) message(rawItem.refusal, rawItem.role || 'assistant', source);
        if (rawItem.tool_calls !== undefined) {
          if (!Array.isArray(rawItem.tool_calls)) error('tool_calls must be an array.');
          rawItem.tool_calls.forEach(function (item) {
            if (!object(item)) error('Each tool_calls entry must be an object.');
            var fn = object(item.function) ? item.function : item;
            call(fn.name, fn.arguments !== undefined ? fn.arguments : fn.input, has(fn, 'arguments') || has(fn, 'input'), item.id !== undefined ? item.id : item.call_id, sourceOverride || record(item, 'tool_call'), item);
          });
        }
        if (object(rawItem.function_call)) {
          var legacy = rawItem.function_call;
          call(legacy.name, legacy.arguments, has(legacy, 'arguments'), rawItem.call_id, sourceOverride || record(legacy, 'function_call'), legacy);
        }
        return;
      }
      if (has(rawItem, 'action') || has(rawItem, 'raw_action')) {
        if (rawItem.thought !== undefined) message(rawItem.thought, 'recorded thought', source);
        if (rawItem.thinking !== undefined) message(rawItem.thinking, 'recorded thinking', source);
        var action = has(rawItem, 'raw_action') ? rawItem.raw_action : rawItem.action, tool = rawItem.tool || rawItem.tool_name || 'action', input = action;
        if (object(action)) {
          tool = action.tool || action.tool_name || action.name || (object(action.function) ? action.function.name : undefined) || tool;
          if (has(action, 'arguments')) input = action.arguments;
          else if (has(action, 'input')) input = action.input;
          else if (object(action.function) && has(action.function, 'arguments')) input = action.function.arguments;
        }
        var direct = call(tool, input, true, rawItem.call_id, source, rawItem);
        var observed = has(rawItem, 'raw_observation') || has(rawItem, 'observation') || has(rawItem, 'output') || has(rawItem, 'result');
        if (observed) {
          var value = has(rawItem, 'raw_observation') ? rawItem.raw_observation : (has(rawItem, 'observation') ? rawItem.observation : (has(rawItem, 'output') ? rawItem.output : rawItem.result));
          direct.hasOutput = true; direct.outputText = textContent(value); direct.text = direct.inputText + (direct.outputText ? '\n\n' + direct.outputText : '');
          if (direct.status === 'pending') direct.status = 'unknown';
          applyStatus(direct, statusEvidence(rawItem, false) || statusEvidence(value, false));
        }
        return;
      }
      if (has(rawItem, 'text') || has(rawItem, 'observation') || has(rawItem, 'label') || has(rawItem, 'state')) {
        message(rawItem.text !== undefined ? rawItem.text : (rawItem.observation !== undefined ? rawItem.observation : display(rawItem)), 'recorded', source); return;
      }
      unused.push(source);
    }
    function finish() {
      var removed = new Set();
      outputs.forEach(function (out) {
        var matches = out.callId !== undefined ? calls.get(out.callId) : undefined;
        if (!matches || matches.length !== 1) {
          warnings.push('Run "' + run.id + '": tool output at line ' + out.sourceRecords[0].line + ' has ' + (matches && matches.length > 1 ? 'an ambiguous reused call ID' : 'no uniquely matching call ID') + '; it remains independently viewable.'); return;
        }
        var target = matches[0];
        if (target._outputCount) warnings.push('Run "' + run.id + '": multiple output records share call ID "' + out.callId + '"; all returned content is preserved.');
        target._outputCount = (target._outputCount || 0) + 1;
        target.hasOutput = true;
        target.outputText += (target._outputCount > 1 ? '\n\n' : '') + out.outputText;
        target.sourceRecords = target.sourceRecords.concat(out.sourceRecords);
        if (target.status === 'pending') target.status = 'unknown';
        if (out.statusBasis) applyStatus(target, { status: out.status, basis: out.statusBasis });
        target.text = target.inputText + (target.outputText ? '\n\n' + target.outputText : ''); removed.add(out);
      });
      calls.forEach(function (items, id) { if (items.length > 1) warnings.push('Run "' + run.id + '": call ID "' + id + '" occurs in multiple invocations; results were not guessed.'); });
      run.events = run.events.filter(function (event) { return !removed.has(event); });
      run.events.forEach(function (event, index) { event.index = index; event.id = 'event-' + (index + 1); delete event._mirror; delete event._mirrored; delete event._turn; delete event._outputCount; });
      if (unused.length) { run.source.unparsedRecords = unused; warnings.push('Run "' + run.id + '": ' + unused.length + ' unsupported records are preserved in source.unparsedRecords but not interpreted as operations.'); }
      if (!run.events.length) error('Run "' + run.id + '" contains no supported messages or operations.');
      if (run.events.length > LIMITS.eventsPerRun) error('Run "' + run.id + '" exceeds 2,000 events.');
      return run;
    }
    return { run: run, process: process, message: message, record: record, finish: finish, unused: unused };
  }
  function validateDataset(data) {
    if (!object(data) || data.format !== FORMAT || !Array.isArray(data.runs) || !data.runs.length) error('No valid trajectory runs were supplied.');
    if (typeof data.name !== 'string' || !Array.isArray(data.warnings) || data.warnings.some(function (warning) { return typeof warning !== 'string'; })) error('Canonical datasets must retain their name and warning list.');
    if (data.runs.length > LIMITS.runs) error('At most 100 runs can be imported.');
    var ids = new Set(), count = 0;
    data.runs.forEach(function (run) {
      if (!object(run) || typeof run.id !== 'string' || !run.id.trim() || ids.has(run.id)) error('Run IDs must be nonempty and unique.');
      ids.add(run.id);
      if (typeof run.name !== 'string' || typeof run.model !== 'string' || !object(run.source) || typeof run.source.format !== 'string' || typeof run.source.filename !== 'string') error('Canonical runs must retain their name, model and source.');
      if (!Array.isArray(run.events) || !run.events.length) error('Run "' + run.id + '" has no events.');
      if (run.events.length > LIMITS.eventsPerRun) error('Run "' + run.id + '" exceeds 2,000 events.');
      count += run.events.length; if (count > LIMITS.events) error('The dataset exceeds 20,000 events.');
      if (['unknown', 'success', 'failure'].indexOf(run.outcome) < 0) error('Invalid recorded run outcome.');
      run.events.forEach(function (event, index) {
        if (!object(event) || ['tool', 'message'].indexOf(event.kind) < 0 || typeof event.label !== 'string') error('Invalid canonical event at index ' + index + '.');
        if (event.index !== index || typeof event.id !== 'string') error('Canonical event indices must follow their recorded sequence.');
        ['inputText', 'outputText', 'text'].forEach(function (field) { if (typeof event[field] !== 'string') error('Canonical ' + field + ' must be text.'); });
        if (['ok', 'error', 'unknown', 'pending'].indexOf(event.status) < 0) error('Invalid recorded operation status.');
        if (event.hasOutput !== undefined && typeof event.hasOutput !== 'boolean') error('hasOutput must be a boolean.');
        if (!Array.isArray(event.sourceRecords) || !event.sourceRecords.length) error('Every event must preserve its source records.');
        event.sourceRecords.forEach(function (source) {
          if (!object(source) || typeof source.type !== 'string' || typeof source.rawText !== 'string' || !has(source, 'record') || !Number.isInteger(source.line) || source.line < 1) error('Invalid preserved source record.');
        });
        if (event.actionKey !== undefined) {
          if (event.kind !== 'tool' || typeof event.tool !== 'string' || !event.tool || typeof event.actionKey !== 'string') error('Invalid invocation identity.');
          if (invocationKey(event.tool, event.inputText, event.inputProvided !== false) !== event.actionKey) error('Canonical actionKey does not match its recorded tool and arguments.');
        }
      });
    });
    return data;
  }
  function decodeText(text, filename) {
    if (typeof text !== 'string' || !text.trim()) error('The input is empty.');
    if (bytes(text) > LIMITS.fileBytes) error('File "' + (filename || 'pasted data') + '" exceeds 10 MB.');
    var normalized = text.replace(/^\uFEFF/, ''), sources = new WeakMap(), records = [], parsed;
    var jsonl = /\.(jsonl|ndjson)$/i.test(filename || '');
    if (!jsonl) {
      try { parsed = JSON.parse(normalized); indexSource(normalized, parsed, sources, 0); return { parsed: parsed, sources: sources, jsonl: false }; }
      catch (failure) { if (normalized.split(/\r?\n/).filter(function (line) { return line.trim(); }).length < 2) error('Invalid JSON: ' + failure.message); jsonl = true; }
    }
    normalized.split(/\r?\n/).forEach(function (line, index) {
      if (!line.trim()) return;
      var record;
      try { record = JSON.parse(line); }
      catch (failure) { error('Invalid JSONL on line ' + (index + 1) + ': ' + failure.message); }
      if (!object(record)) error('JSONL line ' + (index + 1) + ' must contain an object.');
      indexSource(line, record, sources, index); records.push(record);
    });
    if (!records.length) error('No JSONL records were found.');
    return { parsed: records, sources: sources, jsonl: true };
  }
  function parse(text, filename) {
    var decoded = decodeText(text, filename), raw = decoded.parsed, sources = decoded.sources;
    if (object(raw) && raw.format === FORMAT) { validateDatasetForMigration(raw); return validateDataset(withOutputFlags(clone(raw))); }
    var warnings = [], runs = [], name = object(raw) && typeof raw.name === 'string' ? raw.name : title(filename);
    var codex = Array.isArray(raw) && raw.some(function (record) { return object(record) && ['session_meta', 'response_item', 'event_msg', 'turn_context'].indexOf(record.type) >= 0; });
    if (codex) {
      var builder = null, turn = '', sessionCount = 0;
      function ensure() { if (!builder) builder = createBuilder({}, ++sessionCount, filename, 'codex-jsonl', warnings, sources); return builder; }
      raw.forEach(function (record) {
        if (!object(record)) error('A Codex stream record must be an object.');
        var payload = object(record.payload) ? record.payload : {}, type = record.type, source = sourceRecord(record, type + (payload.type ? '/' + payload.type : ''), sources);
        if (type === 'session_meta') {
          if (builder && builder.run.events.length) { runs.push(builder.finish()); builder = null; }
          ensure();
          if (payload.id !== undefined) builder.run.id = String(payload.id);
          if (typeof payload.model === 'string') builder.run.model = payload.model;
          builder.run.name = typeof payload.name === 'string' ? payload.name : builder.run.id;
          builder.run.source.session = source; turn = '';
        } else if (type === 'turn_context') {
          ensure(); if (typeof payload.model === 'string') builder.run.model = payload.model;
          if (payload.turn_id !== undefined) turn = String(payload.turn_id);
          if (!builder.run.source.contextRecords) builder.run.source.contextRecords = []; builder.run.source.contextRecords.push(source);
        } else if (type === 'response_item') ensure().process(payload, source, 'response_item', turn);
        else if (type === 'event_msg' && ['agent_message', 'user_message'].indexOf(payload.type) >= 0) ensure().message(payload.message, payload.type === 'agent_message' ? 'assistant' : 'user', source, 'event_msg', turn);
        else if (type === 'event_msg' && payload.type === 'task_started') { ensure(); if (payload.turn_id !== undefined) turn = String(payload.turn_id); builder.unused.push(source); }
        else ensure().unused.push(source);
      });
      if (builder) runs.push(builder.finish());
      warnings.push('Codex event_msg mirrors are deduplicated only against nearby identical response_item messages in the same recorded turn; both source records are retained. Unsupported records are preserved, not reconstructed as hidden reasoning.');
    } else {
      var records;
      if (object(raw) && has(raw, 'runs')) { if (!Array.isArray(raw.runs)) error('runs must be an array.'); records = raw.runs; }
      else if (Array.isArray(raw)) {
        if (!raw.length) error('No records were supplied.');
        var allRuns = raw.every(function (record) { return object(record) && ['messages', 'steps', 'trajectory', 'output', 'choices'].some(function (field) { return has(record, field) && (Array.isArray(record[field]) || (field === 'trajectory' && typeof record[field] === 'string')); }); });
        records = allRuns ? raw : [{ messages: raw }];
      } else if (object(raw)) records = [raw];
      else error('Supply a recorded messages, output, trajectory, steps, or runs object.');
      if (!records.length) error('No runs were supplied.');
      records.forEach(function (record, index) {
        if (!object(record)) error('Each run must be an object.');
        var format = Array.isArray(record.messages) ? 'messages' : (Array.isArray(record.choices) ? 'openai-chat-completion' : (Array.isArray(record.output) ? 'openai-responses' : (Array.isArray(record.content) ? 'anthropic-content' : (has(record, 'trajectory') ? 'action-observation' : (Array.isArray(record.steps) && record.steps.some(function (step) { return object(step) && has(step, 'raw_action'); }) ? 'tracegraph-parsed' : 'legacy-steps')))));
        var builder = createBuilder(record, index + 1, filename, format, warnings, sources), items;
        if (has(record, 'messages')) items = record.messages;
        else if (has(record, 'steps')) items = record.steps;
        else if (has(record, 'trajectory')) {
          items = record.trajectory;
          if (typeof items === 'string') { try { items = JSON.parse(items); indexSource(record.trajectory, items, sources, (sources.get(record) || {}).line - 1 || 0); } catch (failure) { error('trajectory contains invalid JSON: ' + failure.message); } }
        } else if (Array.isArray(record.choices)) items = record.choices.map(function (choice) { return choice.message || choice.delta; });
        else if (Array.isArray(record.output)) items = record.output;
        else if (Array.isArray(record.content)) items = [record];
        else if (record.role || record.type === 'message' || has(record, 'action')) items = [record];
        else error('Run "' + builder.run.id + '" has no messages, output, trajectory, or steps.');
        if (!Array.isArray(items) || !items.length) error('Run "' + builder.run.id + '" needs a nonempty record array.');
        items.forEach(function (item) { builder.process(item); }); runs.push(builder.finish());
      });
    }
    return validateDataset({ format: FORMAT, name: name || 'Imported traces', runs: runs, warnings: Array.from(new Set(warnings)) });
  }
  function importFiles(files) {
    if (!Array.isArray(files) || !files.length) error('Choose at least one recorded trace file.');
    var total = 0;
    files.forEach(function (file) { if (!object(file) || typeof file.name !== 'string' || typeof file.text !== 'string') error('importFiles expects {name, text} records.'); total += bytes(file.text); });
    if (total > LIMITS.totalBytes) error('The selected files exceed 20 MB in total.');
    var datasets = files.map(function (file) { try { return parse(file.text, file.name); } catch (failure) { error(file.name + ': ' + failure.message); } });
    var runs = [], warnings = [], ids = new Set();
    datasets.forEach(function (dataset, fileIndex) {
      warnings = warnings.concat(dataset.warnings || []);
      dataset.runs.forEach(function (run) {
        var next = clone(run), original = next.id, suffix = 2;
        if (ids.has(next.id)) {
          next.id = original + ' [' + files[fileIndex].name + ']';
          while (ids.has(next.id)) next.id = original + ' [' + files[fileIndex].name + ' #' + suffix++ + ']';
          next.source.originalRunId = original; warnings.push('Duplicate run ID "' + original + '" was renamed to "' + next.id + '"; original ID and filename are retained.');
        }
        ids.add(next.id); runs.push(next);
      });
    });
    return validateDataset({ format: FORMAT, name: files.length === 1 ? datasets[0].name : files.length + ' imported files', runs: runs, warnings: Array.from(new Set(warnings)) });
  }
  function analyze(data) {
    validateDataset(data);
    var totals = { runs: data.runs.length, calls: 0, failedCalls: 0, repeatedCalls: 0, messages: 0 }, perRun = [], nodes = new Map(), edges = new Map(), runPaths = {};
    data.runs.forEach(function (run) {
      var counts = { id: run.id, calls: 0, failedCalls: 0, repeatedCalls: 0, messages: 0 }, seen = new Set(), path = [];
      run.events.forEach(function (event, index) {
        if (event.kind === 'message') { counts.messages += 1; return; }
        if (!event.actionKey) return;
        counts.calls += 1; if (event.status === 'error') counts.failedCalls += 1;
        if (seen.has(event.actionKey)) counts.repeatedCalls += 1; seen.add(event.actionKey); path.push(event.actionKey);
        if (!nodes.has(event.actionKey)) nodes.set(event.actionKey, { key: event.actionKey, label: event.label, tool: event.tool, count: 0, failures: 0, eventRefs: [] });
        var node = nodes.get(event.actionKey); node.count += 1; if (event.status === 'error') node.failures += 1; node.eventRefs.push({ runId: run.id, eventIndex: index });
      });
      path.slice(1).forEach(function (target, index) { var source = path[index], key = stable([source, target]); if (!edges.has(key)) edges.set(key, { source: source, target: target, count: 0 }); edges.get(key).count += 1; });
      Object.defineProperty(runPaths, run.id, { value: path, enumerable: true }); perRun.push(counts);
      ['calls', 'failedCalls', 'repeatedCalls', 'messages'].forEach(function (key) { totals[key] += counts[key]; });
    });
    return { totals: totals, perRun: perRun, nodes: Array.from(nodes.values()), edges: Array.from(edges.values()), runPaths: runPaths };
  }
  function compare(runA, runB) {
    if (!runA || !runB || !Array.isArray(runA.events) || !Array.isArray(runB.events)) error('compare expects two recorded runs.');
    var a = runA.events.filter(function (event) { return event.kind === 'tool' && event.actionKey; }), b = runB.events.filter(function (event) { return event.kind === 'tool' && event.actionKey; }), prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix].actionKey === b[prefix].actionKey) prefix += 1;
    var setA = new Set(a.map(function (event) { return event.actionKey; })), setB = new Set(b.map(function (event) { return event.actionKey; })), shared = 0;
    setA.forEach(function (key) { if (setB.has(key)) shared += 1; }); var union = setA.size + setB.size - shared;
    return { commonPrefix: prefix, firstDifference: prefix === a.length && prefix === b.length ? null : { aIndex: a[prefix] ? a[prefix].index : null, bIndex: b[prefix] ? b[prefix].index : null }, sharedActions: shared, totalActions: union, jaccard: union ? shared / union : 1 };
  }
  function validateDatasetForMigration(data) {
    // Do not traverse malformed shapes before ordinary validation can produce
    // its clear error. Legacy keys are recomputed only after shape checks.
    if (!Array.isArray(data.runs) || data.runs.some(function (run) { return !object(run) || !Array.isArray(run.events); })) error('Invalid canonical runs or events.');
  }
  function exportJSON(data) { validateDataset(data); return JSON.stringify(withOutputFlags(clone(data)), null, 2) + '\n'; }
  function markdown(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+!|])/g, '\\$1').replace(/[\r\n]+/g, ' '); }
  function exportMarkdown(data) {
    var result = analyze(data), t = result.totals;
    var lines = ['# Trajectory Lens — ' + markdown(data.name), '', '## Recorded operations', '', '- Runs: ' + t.runs, '- Tool invocations: ' + t.calls, '- Calls with an explicitly reported error: ' + t.failedCalls, '- Additional occurrences of the same invocation within a run: ' + t.repeatedCalls, '- Recorded messages: ' + t.messages, '', '| Run | Source | Calls | Reported errors | Same-invocation repeats | Messages | Recorded outcome |', '| --- | --- | ---: | ---: | ---: | ---: | --- |'];
    result.perRun.forEach(function (metric) { var run = data.runs.find(function (item) { return item.id === metric.id; }); lines.push('| ' + [markdown(run.id), markdown(run.source.filename + ' / ' + run.source.format), metric.calls, metric.failedCalls, metric.repeatedCalls, metric.messages, run.outcome].join(' | ') + ' |'); });
    lines.push('', '## Comparison method', '', 'Calls match only when the tool name and full recorded arguments match. Safe JSON arguments use deterministic object-key ordering; JSON with unsafe integers, overflowing numbers, or decimal precision loss instead uses exact original argument text, conservatively retaining formatting. Arrays, values, paths and capitalization remain intact. Transport call IDs do not affect invocation identity. The common prefix compares the ordered tool-call sequence; messages and independent unmatched outputs do not count as calls. Jaccard uses unique invocation sets, with the empty/empty case defined as 1.', '', 'Results pair by exact call ID or tool_use_id, never by proximity or tool name. Reused ambiguous IDs remain unmatched; all source records remain inspectable. hasOutput distinguishes a recorded empty result from no result. Ordinary text mentioning errors does not determine status. Structured exit_code, is_error and status fields are used; Codex terminal wrappers additionally expose an exact reported-exit-code line.', '', 'A same-invocation repeat is not proof of wasted work or a mistake. Operation status is distinct from the overall task outcome. Outcomes are used only when explicitly supplied. This is automatic structural parsing of supplied records, not a semantic-state model, hidden-activation analysis, causal diagnosis, or full reproduction of TraceGraph.', '', '## Preserved evidence', '', 'Canonical JSON export retains full input, output, original source text, source line and parsed source records. Additional features, if supplied by a separate module, are retained as annotations and do not replace the original evidence.', '');
    (data.warnings || []).forEach(function (warning) { lines.push('- ' + markdown(warning)); });
    return lines.join('\n') + '\n';
  }
  return Object.freeze({ parse: parse, importFiles: importFiles, analyze: analyze, compare: compare, exportJSON: exportJSON, exportMarkdown: exportMarkdown, limits: LIMITS, format: FORMAT });
});
