'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Insights = require('../web/insights.js');
const call = (key, status = 'unknown', outputText = '', extra = {}) => ({kind: 'tool', actionKey: key, tool: key,
  label: key, isInvocation: true, status, outputText, hasOutput: status !== 'pending', ...extra});
const prose = text => ({kind: 'message', text});
const run = (id, events) => ({id, name: id, events: events.map((event, index) => ({...event, id: id + '-' + index, index}))});

test('failed rechecks retain same-action episode evidence and full timeline indices across interleaved prose and calls', () => {
  const input = run('a', [call('test', 'error', 'failed', {statusBasis: 'exit_code:1', sourceRecords: [{line: 8, type: 'tool_result', path: '$.steps[0]'}]}),
    prose('fixed now, success!'), call('patch', 'ok'), call('test', 'unknown'), prose('retry'), call('test', 'error'), call('test', 'ok', 'passed')]);
  const snapshot = JSON.stringify(input), result = Insights.summarizeRun(input), recovered = result.findings.find(item => item.kind === 'failed_recheck');
  assert.deepEqual(recovered.eventIndices, [0, 3, 5, 6]); assert.equal(recovered.errorCount, 2); assert.equal(recovered.count, 4);
  assert.equal(recovered.earliestRef.eventIndex, 0); assert.equal(recovered.latestRef.eventIndex, 6);
  assert.equal(recovered.evidence[0].statusBasis, 'exit_code:1'); assert.equal(recovered.evidence[0].sourceRefs[0].line, 8);
  assert.deepEqual(result.counts, {calls: 5, errors: 2, repeats: 3, recovered: 1, recoveredInvocations: 1,
    recoveredErrors: 2, repeatStreaks: 1, lastAttemptErrors: 0, files: 0});
  assert.equal(JSON.stringify(input), snapshot); assert.equal(Object.hasOwn(result, 'outcome'), false);
});

test('repeated error-to-ok episodes count once per subsequent explicit ok and preserve distinct findings', () => {
  const result = Insights.summarizeRun(run('a', [call('x', 'error'), call('x', 'ok'), call('x', 'ok'), call('x', 'error'), call('x', 'ok')]));
  assert.equal(result.counts.recovered, 2); assert.equal(result.counts.recoveredInvocations, 1);
  assert.deepEqual(result.findings.filter(item => item.kind === 'failed_recheck').map(item => item.eventIndices), [[0, 1], [3, 4]]);
  assert.equal(new Set(result.findings.map(item => item.id)).size, result.findings.length);
});

test('latest unknown or pending attempts suppress last-error claims; output prose never supplies status', () => {
  for (const status of ['unknown', 'pending']) {
    const result = Insights.summarizeRun(run('a', [call('x', 'error'), call('x', status, 'All tests passed. Success!')]));
    assert.equal(result.counts.lastAttemptErrors, 0); assert.equal(result.counts.recovered, 0);
  }
  const result = Insights.summarizeRun(run('a', [call('x', 'error'), call('y', 'ok'), call('x', 'ok'), call('x', 'error')]));
  const finding = result.findings.find(item => item.kind === 'last_attempt_error');
  assert.deepEqual(finding.eventIndices, [3]); assert.equal(finding.attemptCount, 3); assert.equal(finding.firstAttemptRef.eventIndex, 0);
});

test('repeat streaks use consecutive invocation sequence excluding prose and orphan outputs, while other invocations break a streak', () => {
  const input = run('a', [call('x'), prose('thinking'), call('orphan', 'error', '', {unmatchedOutput: true}), call('x'),
    call('y'), call('x'), call('x'), prose('another repeat'), call('x'), call('z', 'ok', '', {isInvocation: false})]);
  const result = Insights.summarizeRun(input), streaks = result.findings.filter(item => item.kind === 'repeat_streak');
  assert.deepEqual(streaks.map(item => item.eventIndices), [[0, 3], [5, 6, 8]]);
  assert.equal(result.counts.calls, 6); assert.equal(result.counts.errors, 0); assert.equal(result.counts.repeats, 4);
  assert.ok(streaks.every(item => item.severity === 'info')); assert.equal(streaks[1].repeatCount, 2);
});

test('file groups require explicit FILE_PATH evidence, retain original path variants and navigation refs, and deduplicate evidence', () => {
  const a = {key: 'FILE_PATH:src/main.py', source: 'action', rule: 'tracegraph:path', excerpt: '/repo/A/src/main.py'};
  const b = {...a, excerpt: '/repo/B/src/main.py'};
  const input = run('a', [call('read', 'ok', '', {features: {keys: [a.key], evidence: [a, a]}}), prose('note'),
    call('test', 'ok', '', {features: {keys: [a.key], evidence: [b]}}), call('write', 'ok', '', {features: {keys: ['FILE_PATH:fake.py'], evidence: []}})]);
  const result = Insights.summarizeRun(input), group = result.files[0];
  assert.equal(result.files.length, 1); assert.equal(group.key, a.key); assert.equal(group.path, 'src/main.py');
  assert.equal(group.count, 2); assert.deepEqual(group.eventIndices, [0, 2]); assert.equal(group.refs[0].evidence.length, 1);
  assert.deepEqual(group.excerpts, [a.excerpt, b.excerpt]); assert.equal(group.hasMultipleRecordedPaths, true);
  assert.equal(group.latestRef.eventIndex, 2);
});

test('exact sequence alignment absorbs inserted retry and preserves original event indices', () => {
  const a = run('a', [call('read'), prose('note'), call('test', 'error'), call('patch', 'ok'), call('test', 'ok')]);
  const b = run('b', [prose('start'), call('read'), call('test', 'error'), prose('retry'), call('test', 'error'), call('patch', 'ok'), call('test', 'ok')]);
  const result = Insights.alignRuns(a, b);
  assert.equal(result.limited, false); assert.deepEqual(result.rows.map(row => row.type), ['equal', 'equal', 'insert', 'equal', 'equal']);
  assert.deepEqual(result.rows.map(row => [row.aIndex, row.bIndex]), [[0, 1], [2, 2], [null, 4], [3, 5], [4, 6]]);
  assert.equal(result.stats.equal, 4); assert.equal(result.stats.insert, 1); assert.equal(result.stats.lcsLength, 4);
  assert.equal(result.rows[2].bRef.runId, 'b');
});

test('identical inputs align despite differing outputs, statuses, or an empty recorded-result flag', () => {
  const a = run('a', [call('test', 'error', 'failed'), call('read', 'pending', '', {hasOutput: false})]);
  const b = run('b', [call('test', 'ok', 'passed'), call('read', 'pending', '', {hasOutput: true})]);
  const result = Insights.alignRuns(a, b);
  assert.deepEqual(result.rows.map(row => row.type), ['equal', 'equal']);
  assert.equal(result.rows[0].outputChanged, true); assert.equal(result.rows[0].statusChanged, true);
  assert.equal(result.rows[1].outputTextChanged, false); assert.equal(result.rows[1].outputPresenceChanged, true);
  assert.equal(result.stats.outputDifferences, 2); assert.equal(result.stats.statusDifferences, 1);
});

test('append, ended, empty and unrelated traces produce explicit insert, delete or positional replacement rows', () => {
  const a = run('a', [call('x')]), b = run('b', [call('x'), call('y')]), empty = run('empty', []);
  assert.deepEqual(Insights.alignRuns(a, b).rows.map(row => row.type), ['equal', 'insert']);
  assert.deepEqual(Insights.alignRuns(b, a).rows.map(row => row.type), ['equal', 'delete']);
  assert.deepEqual(Insights.alignRuns(empty, b).rows.map(row => row.type), ['insert', 'insert']);
  assert.deepEqual(Insights.alignRuns(b, empty).rows.map(row => row.type), ['delete', 'delete']);
  assert.deepEqual(Insights.alignRuns(empty, empty).rows, []);
  const replaced = Insights.alignRuns(run('a', [call('a'), call('b'), call('anchor')]), run('b', [call('z'), call('anchor')]));
  assert.deepEqual(replaced.rows.map(row => row.type), ['replace', 'delete', 'equal']);
  assert.equal(replaced.stats.equal, 1); assert.equal(replaced.stats.replace, 1); assert.equal(replaced.stats.delete, 1);
});

test('alignment uses exact case-sensitive invocation keys and has deterministic repeated-key tie behavior', () => {
  const a = run('a', [call('X'), call('x'), call('X')]), b = run('b', [call('x'), call('X'), call('x')]);
  const result = Insights.alignRuns(a, b);
  assert.equal(result.stats.equal, 2); assert.deepEqual(result.rows.map(row => [row.type, row.aIndex, row.bIndex]),
    [['delete', 0, null], ['equal', 1, 0], ['equal', 2, 1], ['insert', null, 2]]);
  assert.deepEqual(Insights.alignRuns(a, b), result);
});

test('alignment caps are explicit with no rows or guessed statistics, and malformed limits are rejected', () => {
  const input = run('a', [call('x'), call('y'), call('z')]);
  const callCap = Insights.alignRuns(input, input, {maxCalls: 2});
  assert.equal(callCap.limited, true); assert.equal(callCap.reason, 'call_limit'); assert.deepEqual(callCap.rows, []);
  assert.deepEqual(callCap.totalCalls, {a: 3, b: 3}); assert.equal(callCap.stats.equal, null);
  const cellCap = Insights.alignRuns(input, input, {maxCells: 15});
  assert.equal(cellCap.reason, 'cell_limit'); assert.equal(cellCap.cellsRequired, 16);
  assert.equal(Insights.alignRuns(input, input, {maxCells: 16}).stats.equal, 3);
  for (const maxCalls of [0, -1, 1.5, Infinity, 2001]) assert.throws(() => Insights.alignRuns(input, input, {maxCalls}), /maxCalls/);
  for (const maxCells of [0, -1, NaN, Infinity, 4004002]) assert.throws(() => Insights.alignRuns(input, input, {maxCells}), /maxCells/);
  assert.throws(() => Insights.summarizeRun({}), /events array/);
});

test('bounded alignment covers the full supported 2,000-call traces when explicitly requested', () => {
  const a = run('a', Array.from({length: 2000}, (_, i) => call('key-' + i)));
  const b = run('b', Array.from({length: 2000}, (_, i) => call('key-' + i)));
  const capped = Insights.alignRuns(a, b); assert.equal(capped.limited, true); assert.deepEqual(capped.rows, []);
  const result = Insights.alignRuns(a, b, {maxCalls: 2000, maxCells: 4004001});
  assert.equal(result.limited, false); assert.equal(result.stats.equal, 2000); assert.equal(result.rows.at(-1).aIndex, 1999);
});

test('exhaustive short alignments preserve each input once, order, exact matches and maximum common subsequence', () => {
  const sequences = [[]];
  for (let size = 1; size <= 3; size++) for (let bits = 0; bits < 2 ** size; bits++) sequences.push(Array.from({length: size}, (_, i) => bits & (1 << i) ? 'x' : 'y'));
  const lcs = (a, b) => !a.length || !b.length ? 0 : a[0] === b[0] ? 1 + lcs(a.slice(1), b.slice(1)) : Math.max(lcs(a.slice(1), b), lcs(a, b.slice(1)));
  for (const a of sequences) for (const b of sequences) {
    const result = Insights.alignRuns(run('a', a.map(key => call(key))), run('b', b.map(key => call(key))));
    assert.deepEqual(result.rows.filter(row => row.aIndex !== null).map(row => row.aIndex), a.map((_, i) => i));
    assert.deepEqual(result.rows.filter(row => row.bIndex !== null).map(row => row.bIndex), b.map((_, i) => i));
    assert.equal(result.stats.equal, lcs(a, b));
    result.rows.filter(row => row.type === 'equal').forEach(row => assert.equal(a[row.aIndex], b[row.bIndex]));
  }
});

test('Markdown comparison export escapes evidence and labels, explains limits and preserves one-based full-timeline refs', () => {
  const a = run('<script>|A', [prose('note'), call('<img>|test', 'error'), call('<img>|test', 'ok')]);
  const b = run('B', [call('<img>|test', 'ok')]);
  const report = Insights.exportComparisonMarkdown(a, b);
  assert.ok(!report.includes('<script>')); assert.ok(!report.includes('<img>')); assert.ok(report.includes('&lt;script&gt;\\|A'));
  assert.match(report, /timeline events 2, 3/); assert.match(report, /not a verdict about wasted work/);
  assert.match(report, /does not establish task success/); assert.match(report, /longest common subsequence/);
  const capped = Insights.exportComparisonMarkdown(a, b, {maxCalls: 1});
  assert.match(capped, /Alignment was not computed: call_limit/); assert.match(capped, /No calls were sampled or omitted/);
});

test('browser global API loads without require, DOM, or external dependencies', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(require.resolve('../web/insights.js'), 'utf8'), context);
  assert.equal(typeof context.LensInsights.summarizeRun, 'function'); assert.equal(typeof context.LensInsights.alignRuns, 'function');
  assert.equal(context.LensInsights.summarizeRun(run('a', [call('x')])).counts.calls, 1);
});
