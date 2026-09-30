/* Trajectory Lens: evidence-based review and exact invocation alignment.
 * No outcome, intent, correctness, or causal claim is inferred from prose.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LensInsights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LIMITS = Object.freeze({maxCalls: 1000, maxCells: 1000000, hardMaxCalls: 2000, hardMaxCells: 4004001});
  const isInvocation = event => event && event.kind === 'tool' && event.isInvocation !== false &&
    !event.unmatchedOutput && typeof event.actionKey === 'string' && event.actionKey.length > 0;

  function validateRun(run) {
    if (!run || typeof run !== 'object' || !Array.isArray(run.events)) throw new Error('Expected a recorded run with an events array.');
  }
  function callsOf(run) {
    validateRun(run);
    const calls = [];
    run.events.forEach((event, eventIndex) => { if (isInvocation(event)) calls.push({event, eventIndex}); });
    return calls;
  }
  function ref(run, call) {
    return {runId: run.id, eventIndex: call.eventIndex, eventId: call.event.id ?? null};
  }
  function evidence(run, call) {
    return {...ref(run, call), status: call.event.status || 'unknown', statusBasis: call.event.statusBasis ?? null,
      hasOutput: call.event.hasOutput === true,
      sourceRefs: (call.event.sourceRecords || []).filter(source => source && typeof source === 'object')
        .map(source => ({line: source.line ?? null, type: source.type ?? null, path: source.path ?? null}))};
  }
  function finding(run, kind, severity, calls, extra = {}) {
    const first = calls[0], last = calls[calls.length - 1];
    return {id: JSON.stringify([run.id, kind, first.event.actionKey, first.eventIndex, last.eventIndex]), kind, severity,
      actionKey: first.event.actionKey, tool: first.event.tool || '', count: calls.length,
      eventIndices: calls.map(call => call.eventIndex), earliestRef: ref(run, first), latestRef: ref(run, last),
      evidence: calls.map(call => evidence(run, call)), ...extra};
  }
  function summarizeRun(run) {
    const calls = callsOf(run), byAction = new Map(), findings = [], fileMap = new Map();
    const counts = {calls: calls.length, errors: 0, repeats: 0, recovered: 0, recoveredInvocations: 0,
      recoveredErrors: 0, repeatStreaks: 0, lastAttemptErrors: 0, files: 0};
    calls.forEach(call => {
      const key = call.event.actionKey;
      if (!byAction.has(key)) byAction.set(key, []);
      else counts.repeats++;
      byAction.get(key).push(call);
      if (call.event.status === 'error') counts.errors++;
      const fileEvidence = (call.event.features && call.event.features.evidence || []).filter(item => item &&
        typeof item.key === 'string' && item.key.startsWith('FILE_PATH:') && item.key.length > 10);
      const perEvent = new Map();
      fileEvidence.forEach(item => {
        if (!perEvent.has(item.key)) perEvent.set(item.key, []);
        const records = perEvent.get(item.key), copy = {key: item.key, source: item.source ?? null,
          rule: item.rule ?? null, excerpt: String(item.excerpt ?? '')};
        if (!records.some(record => JSON.stringify(record) === JSON.stringify(copy))) records.push(copy);
      });
      perEvent.forEach((records, key) => {
        if (!fileMap.has(key)) fileMap.set(key, {key, path: key.slice(10), count: 0, eventIndices: [], refs: [], excerpts: []});
        const group = fileMap.get(key);
        group.count++; group.eventIndices.push(call.eventIndex); group.refs.push({...ref(run, call), evidence: records});
        records.forEach(record => { if (!group.excerpts.includes(record.excerpt)) group.excerpts.push(record.excerpt); });
      });
    });
    const recoveredKeys = new Set();
    byAction.forEach(attempts => {
      let episode = [];
      attempts.forEach(call => {
        if (call.event.status === 'error' || episode.length) episode.push(call);
        if (call.event.status === 'ok' && episode.length) {
          const errorCount = episode.filter(attempt => attempt.event.status === 'error').length;
          findings.push(finding(run, 'failed_recheck', 'info', episode, {errorCount, repeatCount: episode.length - 1}));
          counts.recovered++; counts.recoveredErrors += errorCount; recoveredKeys.add(call.event.actionKey); episode = [];
        }
      });
      const latest = attempts[attempts.length - 1];
      // An unknown or pending final attempt overrides an earlier error for this
      // finding. We report only the last observed attempt, never persistence.
      if (latest.event.status === 'error') {
        findings.push(finding(run, 'last_attempt_error', 'warning', [latest], {errorCount: 1, attemptCount: attempts.length,
          firstAttemptRef: ref(run, attempts[0])}));
        counts.lastAttemptErrors++;
      }
    });
    counts.recoveredInvocations = recoveredKeys.size;
    let streak = [];
    const finishStreak = () => {
      if (streak.length > 1) {
        findings.push(finding(run, 'repeat_streak', 'info', streak, {repeatCount: streak.length - 1,
          errorCount: streak.filter(call => call.event.status === 'error').length})); counts.repeatStreaks++;
      }
    };
    calls.forEach(call => {
      if (streak.length && streak[0].event.actionKey !== call.event.actionKey) { finishStreak(); streak = []; }
      streak.push(call);
    });
    finishStreak();
    const kindOrder = {failed_recheck: 0, repeat_streak: 1, last_attempt_error: 2};
    findings.sort((a, b) => a.earliestRef.eventIndex - b.earliestRef.eventIndex || kindOrder[a.kind] - kindOrder[b.kind]);
    const files = Array.from(fileMap.values()).map(group => ({...group, earliestRef: group.refs[0],
      latestRef: group.refs[group.refs.length - 1], hasMultipleRecordedPaths: group.excerpts.length > 1}));
    counts.files = files.length;
    return {runId: run.id, counts, findings, files};
  }

  function boundedOption(value, fallback, maximum, name) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(name + ' must be an integer from 1 to ' + maximum + '.');
    return value;
  }
  function hasOutput(event) {
    // Raw-v1 imports now provide the explicit flag; this conservative fallback
    // permits direct calls with older events containing a nonempty result.
    return typeof event.hasOutput === 'boolean' ? event.hasOutput : Boolean(event.outputText);
  }
  function alignmentRow(type, runA, runB, a, b) {
    const paired = Boolean(a && b);
    const outputPresenceChanged = paired ? hasOutput(a.event) !== hasOutput(b.event) : null;
    const outputTextChanged = paired ? (a.event.outputText ?? '') !== (b.event.outputText ?? '') : null;
    return {type, aIndex: a ? a.eventIndex : null, bIndex: b ? b.eventIndex : null,
      aRef: a ? ref(runA, a) : null, bRef: b ? ref(runB, b) : null,
      aActionKey: a ? a.event.actionKey : null, bActionKey: b ? b.event.actionKey : null,
      outputChanged: paired ? outputPresenceChanged || outputTextChanged : null, outputPresenceChanged, outputTextChanged,
      statusChanged: paired ? (a.event.status || 'unknown') !== (b.event.status || 'unknown') : null};
  }
  function alignRuns(runA, runB, options = {}) {
    const a = callsOf(runA), b = callsOf(runB), n = a.length, m = b.length;
    const maxCalls = boundedOption(options.maxCalls, LIMITS.maxCalls, LIMITS.hardMaxCalls, 'maxCalls');
    const maxCells = boundedOption(options.maxCells, LIMITS.maxCells, LIMITS.hardMaxCells, 'maxCells');
    const cells = (n + 1) * (m + 1), limits = {maxCalls, maxCells}, totalCalls = {a: n, b: m};
    const base = {rows: [], stats: {aCalls: n, bCalls: m, equal: null, insert: null, delete: null, replace: null,
      outputDifferences: null, statusDifferences: null, outputPresenceDifferences: null, lcsLength: null},
      limited: false, reason: null, limits, totalCalls, cellsRequired: cells,
      method: 'exact-action-key-lcs', tiePolicy: 'earliest equal match; delete from A on equal LCS scores'};
    if (n > maxCalls || m > maxCalls || cells > maxCells) {
      return {...base, limited: true, reason: n > maxCalls || m > maxCalls ? 'call_limit' : 'cell_limit'};
    }
    // A bounded full LCS matrix makes time and memory deterministic. Alignment
    // matches exact invocation keys only; adjacent unmatched spans become
    // positional replacements for display, without claiming semantic similarity.
    const width = m + 1, scores = new Uint16Array(cells);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        scores[i * width + j] = a[i].event.actionKey === b[j].event.actionKey ? scores[(i + 1) * width + j + 1] + 1 :
          Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
      }
    }
    const rows = [], removed = [], added = [];
    const flush = () => {
      const common = Math.min(removed.length, added.length);
      for (let k = 0; k < common; k++) rows.push(alignmentRow('replace', runA, runB, removed[k], added[k]));
      for (let k = common; k < removed.length; k++) rows.push(alignmentRow('delete', runA, runB, removed[k], null));
      for (let k = common; k < added.length; k++) rows.push(alignmentRow('insert', runA, runB, null, added[k]));
      removed.length = 0; added.length = 0;
    };
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i].event.actionKey === b[j].event.actionKey) {
        flush(); rows.push(alignmentRow('equal', runA, runB, a[i++], b[j++]));
      } else if (i < n && (j === m || scores[(i + 1) * width + j] >= scores[i * width + j + 1])) removed.push(a[i++]);
      else added.push(b[j++]);
    }
    flush();
    const stats = {aCalls: n, bCalls: m, equal: 0, insert: 0, delete: 0, replace: 0, outputDifferences: 0,
      statusDifferences: 0, outputPresenceDifferences: 0, lcsLength: scores[0]};
    rows.forEach(row => {
      stats[row.type]++;
      if (row.type === 'equal') {
        if (row.outputChanged) stats.outputDifferences++;
        if (row.statusChanged) stats.statusDifferences++;
        if (row.outputPresenceChanged) stats.outputPresenceDifferences++;
      }
    });
    return {...base, rows, stats};
  }

  function markdown(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+!|])/g, '\\$1').replace(/[\r\n]+/g, ' ');
  }
  function exportComparisonMarkdown(runA, runB, options = {}) {
    const alignment = alignRuns(runA, runB, options), summaries = [summarizeRun(runA), summarizeRun(runB)];
    const lines = ['## Exact invocation alignment', '', '- Run A: ' + markdown(runA.name || runA.id),
      '- Run B: ' + markdown(runB.name || runB.id), '- Recorded invocations: A ' + alignment.totalCalls.a + ', B ' + alignment.totalCalls.b, ''];
    if (alignment.limited) {
      lines.push('Alignment was not computed: ' + alignment.reason + '. No calls were sampled or omitted.',
        'Limits: ' + alignment.limits.maxCalls + ' calls per run and ' + alignment.limits.maxCells + ' matrix cells; required cells: ' + alignment.cellsRequired + '.', '');
    } else {
      const s = alignment.stats;
      lines.push('- Exact matches: ' + s.equal, '- Insertions in B: ' + s.insert, '- Deletions from A: ' + s.delete,
        '- Positional replacements: ' + s.replace, '- Exact matches with different recorded output: ' + s.outputDifferences,
        '- Exact matches with different recorded status: ' + s.statusDifferences, '',
        '| Alignment | A event | B event | A invocation | B invocation | Output differs | Status differs |',
        '| --- | ---: | ---: | --- | --- | --- | --- |');
      alignment.rows.forEach(row => {
        const eventA = row.aIndex === null ? null : runA.events[row.aIndex], eventB = row.bIndex === null ? null : runB.events[row.bIndex];
        lines.push('| ' + [row.type, row.aIndex === null ? '—' : row.aIndex + 1, row.bIndex === null ? '—' : row.bIndex + 1,
          eventA ? markdown(eventA.label || eventA.tool) : '—', eventB ? markdown(eventB.label || eventB.tool) : '—',
          row.outputChanged === null ? '—' : row.outputChanged ? 'yes' : 'no',
          row.statusChanged === null ? '—' : row.statusChanged ? 'yes' : 'no'].join(' | ') + ' |');
      });
      lines.push('');
    }
    lines.push('Alignment uses the longest common subsequence of exact invocation keys. Messages and unmatched outputs are excluded. Event numbers above refer to the full recorded timeline and are one-based. Matches align inputs even when their outputs or statuses differ. Replacements only pair unmatched positions between exact anchors; they do not assert semantic equivalence. Repeated keys can admit multiple valid alignments; the deterministic tie policy is: ' + alignment.tiePolicy + '.', '', '## Evidence-based run review', '');
    const descriptions = {failed_recheck: 'Explicit error followed by an explicit ok status for the same invocation',
      repeat_streak: 'Consecutive occurrences of the same invocation in the call sequence',
      last_attempt_error: 'Last recorded attempt for this invocation has an explicit error status'};
    summaries.forEach((summary, index) => {
      const run = index === 0 ? runA : runB, counts = summary.counts;
      lines.push('### ' + markdown(run.name || run.id), '', '- Calls: ' + counts.calls + '; explicit errors: ' + counts.errors +
        '; additional same-invocation occurrences: ' + counts.repeats + '; error-to-ok rechecks: ' + counts.recovered + '.', '');
      if (!summary.findings.length) lines.push('No findings in the supported structural review categories.', '');
      summary.findings.forEach(item => lines.push('- ' + descriptions[item.kind] + '; timeline events ' +
        item.eventIndices.map(eventIndex => eventIndex + 1).join(', ') + '; tool ' + markdown(item.tool) + '.'));
      lines.push('');
      if (summary.files.length) {
        lines.push('| Observable file key | Timeline events | Recorded path evidence |', '| --- | --- | --- |');
        summary.files.forEach(file => lines.push('| ' + markdown(file.path) + ' | ' + file.eventIndices.map(eventIndex => eventIndex + 1).join(', ') +
          ' | ' + file.excerpts.map(markdown).join('; ') + ' |'));
        lines.push('');
      }
    });
    lines.push('An ok operation does not establish task success, and repeated calls are not a verdict about wasted work. A later unknown or pending attempt suppresses a last-attempt-error finding for that invocation. File groups retain the recorded path evidence; normalized FILE_PATH keys may group different original paths. Source records remain available through each finding’s event references.', '');
    return lines.join('\n') + '\n';
  }
  return Object.freeze({summarizeRun, alignRuns, exportComparisonMarkdown, limits: LIMITS});
});
