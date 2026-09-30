/* Canonical workspace snapshots. UI state never replaces raw log evidence. */
(function (root, factory) {
  'use strict';
  var workspace = factory();
  if (typeof module === 'object' && module.exports) module.exports = workspace;
  if (root) root.LensWorkspace = workspace;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_QUERY = 500;
  var MAX_TOOL = 256;
  var MAX_REFERENCE = 1024;
  var own = Function.call.bind(Object.prototype.hasOwnProperty);
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function read(value, key) { return object(value) && own(value, key) ? value[key] : undefined; }
  function invocation(event) { return object(event) && event.kind === 'tool' && event.isInvocation !== false && !event.unmatchedOutput && typeof event.actionKey === 'string' && event.actionKey.length > 0; }
  function runsOf(data) {
    if (!object(data) || !Array.isArray(data.runs) || !data.runs.length) throw new TypeError('A canonical dataset with at least one run is required.');
    var runs = data.runs;
    var ids = new Set();
    runs.forEach(function (run) {
      if (!object(run) || typeof run.id !== 'string' || !run.id || ids.has(run.id) || !Array.isArray(run.events) || !run.events.length) {
        throw new TypeError('Each run must have a unique ID and a nonempty events array.');
      }
      ids.add(run.id);
    });
    return runs;
  }
  function choice(value, allowed, fallback) { return allowed.indexOf(value) >= 0 ? value : fallback; }
  function boolean(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
  function reference(value, runs) {
    if (typeof value !== 'string' || value.length > MAX_REFERENCE) return null;
    return runs.find(function (run) { return run.id === value; }) || null;
  }
  function normalize(data, state) {
    var runs = runsOf(data);
    var selectedRun = reference(read(state, 'runId'), runs) || runs[0];
    var comparedRun = reference(read(state, 'compareId'), runs);
    if (comparedRun === selectedRun) comparedRun = null;
    var firstCall = selectedRun.events.findIndex(invocation);
    var defaultIndex = firstCall >= 0 ? firstCall : 0;
    var index = read(state, 'eventIndex');
    if (!Number.isInteger(index) || index < 0 || index >= selectedRun.events.length) index = defaultIndex;
    var query = read(state, 'query');
    query = typeof query === 'string' ? query.slice(0, MAX_QUERY) : '';
    var tool = read(state, 'toolFilter');
    if (typeof tool !== 'string' || tool.length > MAX_TOOL || !selectedRun.events.some(function (event) { return invocation(event) && event.tool === tool; })) tool = '';
    var scope = choice(read(state, 'processScope'), ['all', 'run', 'compared'], 'all');
    if (scope === 'compared' && !comparedRun) scope = 'all';
    return {
      runId: selectedRun.id,
      compareId: comparedRun ? comparedRun.id : null,
      eventIndex: index,
      view: choice(read(state, 'view'), ['timeline', 'process', 'map'], 'timeline'),
      filter: choice(read(state, 'filter'), ['all', 'failed', 'repeated'], 'all'),
      query: query,
      toolFilter: tool,
      language: choice(read(state, 'language'), ['en', 'zh'], 'en'),
      showMessages: boolean(read(state, 'showMessages'), firstCall < 0),
      reviewOpen: boolean(read(state, 'reviewOpen'), false),
      processK: choice(read(state, 'processK'), [3, 6, 10], 6),
      processThreshold: choice(read(state, 'processThreshold'), [0, 0.2, 0.4, 0.6], 0.2),
      processScope: scope,
      graphZoom: choice(read(state, 'graphZoom'), [0.6, 1, 1.4, 2], 1),
      focusOnly: boolean(read(state, 'focusOnly'), false)
    };
  }
  function restore(data) {
    var state = read(data, 'workspace');
    // Future snapshots cannot silently adopt a different interpretation.
    return normalize(data, read(state, 'version') === 1 ? state : undefined);
  }
  function save(data, state) {
    var normalized = normalize(data, state);
    // Canonical raw datasets are JSON values. The clone keeps every parsed
    // record and original string, while removing all reference sharing.
    var copy;
    try { copy = JSON.parse(JSON.stringify(data)); }
    catch (error) { throw new TypeError('The canonical dataset must be JSON-serializable: ' + error.message); }
    copy.workspace = { version: 1 };
    Object.keys(normalized).forEach(function (key) { copy.workspace[key] = normalized[key]; });
    return copy;
  }
  return Object.freeze({ save: save, restore: restore });
});
