'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Raw = require('../web/raw.js');
const Workspace = require('../web/workspace.js');

test('expanded saved workspaces can exceed the raw file limit without relaxing native-log limits', () => {
  const data = fixture();
  data.runs[0].events[0].sourceRecords[0].rawText = ' '.repeat(Raw.limits.fileBytes + 1);
  const saved = JSON.stringify(Workspace.save(data, {}));
  assert.throws(() => Raw.parse(saved, 'workspace.json'), /10 MB/);
  const restored = Raw.parseWorkspace(saved);
  assert.equal(restored.runs[0].events[0].sourceRecords[0].rawText.length, Raw.limits.fileBytes + 1);
  assert.deepEqual(Workspace.restore(restored), Workspace.restore(data));
  assert.throws(() => Raw.parseWorkspace(JSON.stringify({messages: [{role:'user',content:'hello'}]})), /saved Trajectory Lens/);
  restored.runs[0].events[0].status = 'invented';
  assert.throws(() => Raw.parseWorkspace(JSON.stringify(restored)), /status/);
});

test('orphan outputs with legacy identity fields do not become default workspace selections', () => {
  const data=fixture();
  data.runs[0].events.unshift({...data.runs[0].events[1],kind:'tool',actionKey:'legacy',isInvocation:false,unmatchedOutput:true});
  assert.equal(Workspace.restore(data).eventIndex,2);
});

function fixture() {
  return Raw.parse(JSON.stringify({ name: 'Workspace evidence', runs: [
    { id: 'first', messages: [
      { role: 'user', content: '  Keep this original message.\n' },
      { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'exec_command', arguments: '{ "cmd": "pytest tests/A.py" }' } }] },
      { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ exit_code: 1, output: '  FAILED tests/A.py\nIndexError\n' }) },
      { role: 'assistant', tool_calls: [{ id: 'b', function: { name: 'read_file', arguments: '{"path":"A.py"}' } }] },
      { role: 'tool', tool_call_id: 'b', content: '  Original file contents.\n' }
    ] },
    { id: 'second', messages: [
      { role: 'user', content: 'Inspect another run.' },
      { role: 'assistant', content: 'Before call' },
      { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{"path":"B.py"}' } }] },
      { role: 'tool', tool_call_id: 'c', content: '  B contents.\n' }
    ] },
    { id: 'messages-only', messages: [{ role: 'user', content: 'No tools were recorded.' }] }
  ] }), 'evidence.json');
}
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

test('save, raw JSON export/parse and restore preserve all workspace fields and original evidence', () => {
  const data = fixture();
  data.runs[1].events[2].features = { keys: ['FILE_PATH:B.py'], evidence: [{ key: 'FILE_PATH:B.py', source: 'action', excerpt: 'B.py' }] };
  data.extraMetadata = { batch: 'Keep nested metadata', exact: '  Original whitespace\n' };
  const state = { runId: 'second', compareId: 'first', eventIndex: 2, view: 'process', filter: 'repeated', query: 'B.py', toolFilter: 'read_file', language: 'zh', showMessages: true, reviewOpen: true, processK: 10, processThreshold: 0.4, processScope: 'compared', graphZoom: 1.4, focusOnly: true };
  const saved = Workspace.save(data, state);
  assert.equal(saved.workspace.version, 1);
  const reopened = Raw.parse(Raw.exportJSON(saved), 'workspace.json');
  assert.deepEqual(Workspace.restore(reopened), state);
  const evidence = value => value.runs.map(run => run.events.map(event => ({ inputText: event.inputText, outputText: event.outputText, text: event.text, sourceRecords: event.sourceRecords, features: event.features })));
  assert.deepEqual(evidence(reopened), evidence(data));
  assert.deepEqual(reopened.extraMetadata, data.extraMetadata);
  assert.deepEqual(Raw.analyze(reopened), Raw.analyze(data));
  assert.deepEqual(Raw.compare(reopened.runs[0], reopened.runs[1]), Raw.compare(data.runs[0], data.runs[1]));
});

test('saving and restoring do not mutate datasets or share nested original record references', () => {
  const data = freezeDeep(fixture());
  const state = freezeDeep({ runId: 'first', eventIndex: 2, query: 'keep' });
  const before = JSON.stringify(data);
  const saved = Workspace.save(data, state);
  assert.equal(JSON.stringify(data), before);
  assert.equal(data.workspace, undefined);
  assert.notEqual(saved.runs, data.runs);
  assert.notEqual(saved.runs[0].events[0].sourceRecords, data.runs[0].events[0].sourceRecords);
  const savedBefore = JSON.stringify(saved);
  Workspace.restore(freezeDeep(saved));
  assert.equal(JSON.stringify(saved), savedBefore);
});

test('missing or unsupported snapshot versions restore safe defaults and first original-array invocation', () => {
  const data = fixture();
  const defaults = Workspace.restore(data);
  assert.deepEqual(defaults, { runId: 'first', compareId: null, eventIndex: 1, view: 'timeline', filter: 'all', query: '', toolFilter: '', language: 'en', showMessages: false, reviewOpen: false, processK: 6, processThreshold: 0.2, processScope: 'all', graphZoom: 1, focusOnly: false });
  for (const snapshot of [null, [], { version: 2, runId: 'second' }, { version: '1', runId: 'second' }, { runId: 'second' }]) {
    assert.deepEqual(Workspace.restore({ ...data, workspace: snapshot }), defaults);
  }
  const onlyMessages = Workspace.restore(Workspace.save(data, { runId: 'messages-only' }));
  assert.equal(onlyMessages.eventIndex, 0);
  assert.equal(onlyMessages.showMessages, true);
});

test('invalid references, types, malicious inherited state and unsupported choices fall back safely', () => {
  const data = fixture();
  const bad = JSON.parse('{"version":1,"runId":"does-not-exist","compareId":"first","eventIndex":999,"view":"<script>","filter":"constructor","query":{"x":"not text"},"toolFilter":"../../private","language":"fr","showMessages":"true","reviewOpen":1,"processK":7,"processThreshold":"0.2","processScope":"compared","graphZoom":999,"focusOnly":"false","__proto__":{"polluted":true}}');
  const saved = Workspace.save(data, bad);
  const restored = Workspace.restore(saved);
  assert.equal(restored.runId, 'first');
  assert.equal(restored.compareId, null);
  assert.equal(restored.eventIndex, 1);
  assert.equal(restored.view, 'timeline');
  assert.equal(restored.filter, 'all');
  assert.equal(restored.query, '');
  assert.equal(restored.toolFilter, '');
  assert.equal(restored.language, 'en');
  assert.equal(restored.showMessages, false);
  assert.equal(restored.reviewOpen, false);
  assert.equal(restored.processK, 6);
  assert.equal(restored.processThreshold, 0.2);
  assert.equal(restored.processScope, 'all');
  assert.equal(restored.graphZoom, 1);
  assert.equal(restored.focusOnly, false);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(saved.workspace, '__proto__'), false);
  const inherited = Object.create({ runId: 'second', compareId: 'first', view: 'map', language: 'zh' });
  assert.equal(Workspace.restore(Workspace.save(data, inherited)).runId, 'first');
  assert.equal(Workspace.restore(Workspace.save(data, inherited)).language, 'en');
  for (const value of [-1, 1.2, '2', Infinity, NaN]) assert.equal(Workspace.restore(Workspace.save(data, { eventIndex: value })).eventIndex, 1);
});

test('all valid multi-run selections, message records and supported graph controls remain restorable', () => {
  const data = fixture();
  const state = { runId: 'second', compareId: 'messages-only', eventIndex: 0, view: 'map', filter: 'failed', query: '  Literal search\n', toolFilter: 'read_file', language: 'en', showMessages: true, reviewOpen: false, processK: 3, processThreshold: 0, processScope: 'run', graphZoom: 0.6, focusOnly: false };
  assert.deepEqual(Workspace.restore(Workspace.save(data, state)), state);
  const invalidSelectedTool = Workspace.restore(Workspace.save(data, { runId: 'second', toolFilter: 'exec_command' }));
  assert.equal(invalidSelectedTool.toolFilter, '');
  assert.equal(invalidSelectedTool.eventIndex, 2);
  for (const view of ['timeline', 'process', 'map']) assert.equal(Workspace.restore(Workspace.save(data, { view })).view, view);
  for (const filter of ['all', 'failed', 'repeated']) assert.equal(Workspace.restore(Workspace.save(data, { filter })).filter, filter);
  for (const graphZoom of [0.6, 1, 1.4, 2]) assert.equal(Workspace.restore(Workspace.save(data, { graphZoom })).graphZoom, graphZoom);
  const noComparison = Workspace.restore(Workspace.save(data, { runId: 'second', compareId: 'unknown', processScope: 'compared' }));
  assert.equal(noComparison.compareId, null);
  assert.equal(noComparison.processScope, 'all');
});

test('state strings are bounded without truncating source evidence or enabling a nonexistent tool', () => {
  const data = fixture();
  data.runs[0].events[0].text = 'Exact evidence '.repeat(1000);
  const saved = Workspace.save(data, { query: 'q'.repeat(501), toolFilter: 't'.repeat(257), runId: 'r'.repeat(1025), compareId: 'r'.repeat(1025) });
  const restored = Workspace.restore(saved);
  assert.equal(restored.query.length, 500);
  assert.equal(restored.toolFilter, '');
  assert.equal(restored.runId, 'first');
  assert.equal(restored.compareId, null);
  assert.equal(saved.runs[0].events[0].text, data.runs[0].events[0].text);
});

test('browser global works without Node dependencies, DOM, storage or network', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../web/workspace.js'), 'utf8'), context);
  assert.equal(typeof context.LensWorkspace.save, 'function');
  assert.equal(typeof context.LensWorkspace.restore, 'function');
  const restored = context.LensWorkspace.restore(fixture());
  assert.equal(restored.runId, 'first');
  assert.equal(restored.eventIndex, 1);
  assert.throws(() => Workspace.restore({ runs: [] }), /canonical dataset/);
  assert.throws(() => Workspace.save({ runs: [{ id: 'x', events: [] }] }, {}), /nonempty events/);
});
