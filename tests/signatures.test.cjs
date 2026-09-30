/* SPDX-License-Identifier: Apache-2.0 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const signatures = require('../web/signatures.js');
const golden = require('./fixtures/tracegraph-signatures-golden.json');
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const toolEvent = (tool, inputText, outputText = '', index = 0) => ({id: 'e-' + index, index, kind: 'tool', tool, inputText,
  outputText, text: inputText + '\n' + outputText, actionKey: JSON.stringify([tool, inputText]), sourceRecords: []});

test('strict raw extraction equals pinned Python on all golden examples', () => {
  assert.equal(signatures.SOURCE_COMMIT, golden.source_commit);
  for (const fixture of golden.cases) assert.deepEqual(signatures.extractSliceKeys(fixture.action, fixture.observation, fixture.progress), fixture.keys, fixture.name);
});
test('strict parsed cxcmu extraction equals the actual pinned pipeline', () => {
  for (const fixture of golden.parsed_cases) assert.deepEqual(signatures.extractParsedKeys(fixture.step, fixture.progress), fixture.keys, fixture.name);
});
test('IDF values and float32 pairwise distances equal pinned Python', () => {
  const sets = golden.cases.map(item => item.keys), idf = signatures.buildIdfWeights(sets);
  assert.deepEqual(Object.keys(idf).sort(), Object.keys(golden.idf).sort());
  for (const key of Object.keys(idf)) close(idf[key], golden.idf[key], 1e-12);
  const distance = signatures.computePairwiseDistances(sets, idf);
  for (let i = 0; i < sets.length; i++) for (let j = 0; j < sets.length; j++) close(distance[i][j], golden.distances[i][j], 0);
});
test('mutual-kNN distances and RBF weights equal pinned Python without ties', () => {
  const sets = golden.cases.map(item => item.keys), idf = signatures.buildIdfWeights(sets);
  const edges = signatures.buildMutualKnnEdges(signatures.computePairwiseDistances(sets, idf), sets.length - 1)
    .sort((a, b) => a.source - b.source || a.target - b.target);
  assert.deepEqual(edges, golden.mutual_edges);
});
test('singleton and corpus-wide shared keys have zero informative similarity', () => {
  const idf = signatures.buildIdfWeights([['TOOL:bash', 'PHASE:early']]);
  assert.equal(signatures.weightedJaccard(['TOOL:bash'], ['TOOL:bash'], idf), 0);
  assert.equal(signatures.weightedJaccard([], [], idf), 0);
  const data = signatures.enrich({runs: [{id: 'a', events: [toolEvent('bash', 'rg x')]}]});
  assert.deepEqual(signatures.related(data, 'a', 0), []);
  assert.deepEqual(signatures.processGraph(data).edges, []);
});
test('CMD is an observable classifier; quoted mentions can match patterns', () => {
  const features = signatures.extractWithEvidence({tool_calls: [{function: {name: 'bash', arguments: 'echo "pytest documentation"'}}]},
    {content: 'Documentation: SyntaxError does not occur; FAILED is an example.'}, 0);
  assert.ok(features.keys.includes('CMD:pytest'));
  assert.ok(features.keys.includes('OBS:SyntaxError'));
  assert.ok(features.keys.includes('OBS:test_failed'));
  assert.ok(features.evidence.some(item => item.key === 'OBS:SyntaxError' && item.excerpt === 'SyntaxError' && item.rule === 'tracegraph:observation-pattern'));
  // Pattern hits are not outcome labels and never modify status or success.
  assert.equal(features.status, undefined);
  assert.equal(features.success, undefined);
});
test('Codex tools, relative paths, Windows paths and decoded patch have explicit extension provenance', () => {
  const cmd = {tool_calls: [{function: {name: 'functions.exec_command', arguments: JSON.stringify({cmd: 'python -m pytest "D:\\Project Files\\Src\\MixedCase.PY" src/test_api.py'})}}]};
  assert.equal(signatures.extractSliceKeys(cmd, {}, 0).includes('CMD:pytest'), false);
  const features = signatures.extractWithEvidence(cmd, {}, 0, {extensions: true});
  for (const key of ['CMD:pytest', 'FILE_PATH:Src/MixedCase.PY', 'FILE_EXT:py', 'FILE_PATH:src/test_api.py']) assert.ok(features.keys.includes(key), key);
  assert.ok(features.evidence.filter(item => item.key === 'CMD:pytest').every(item => item.rule.startsWith('lens-extension:')));
  const patch = signatures.extractWithEvidence({function_call: {name: 'functions.apply_patch', arguments: '*** Begin Patch\n*** Update File: src/helper.py\n+def helper():\n+    return 2\n*** End Patch'}}, {}, 0, {extensions: true});
  for (const key of ['ACTION:edit', 'FILE_PATH:src/helper.py', 'DIFF:add_function', 'DIFF:add_return']) assert.ok(patch.keys.includes(key), key);
});
test('normalization preserves path case and discloses lossy last-two-components', () => {
  const features = signatures.extractWithEvidence({function_call: {name: 'read_file', arguments: JSON.stringify({path: 'D:\\Repo\\Src\\Foo.PY'})}}, {}, 0, {extensions: true});
  assert.ok(features.keys.includes('FILE_PATH:Src/Foo.PY'));
  assert.ok(!features.keys.includes('FILE_PATH:src/foo.py'));
  assert.equal(signatures.normalisePath('/different/root/Src/Foo.PY'), signatures.normalisePath('/another/root/Src/Foo.PY'));
  assert.ok(features.evidence.some(item => item.excerpt === 'D:\\Repo\\Src\\Foo.PY'));
});
test('enrich preserves original texts and source records, and omits orphan outputs and prose', () => {
  const event = toolEvent('functions.exec_command', '{"cmd":"rg token src/main.py"}', '  original\n   output  ');
  event.sourceRecords = [{line: 1, type: 'response_item', rawText: '{ "x":1 }', record: {x: 1}}];
  const data = {runs: [{id: 'a', events: [{kind: 'message', text: 'Private user prose'}, event,
    {kind: 'tool', tool: 'bash', inputText: '', outputText: 'orphan', unmatchedOutput: true, isInvocation: false}]}]};
  const before = JSON.stringify(data), enriched = signatures.enrich(data);
  assert.equal(JSON.stringify(data), before);
  assert.equal(enriched.runs[0].events[1].outputText, event.outputText);
  assert.equal(enriched.runs[0].events[1].sourceRecords, event.sourceRecords);
  assert.ok(enriched.runs[0].events[1].features.keys.includes('CMD:grep'));
  assert.equal(enriched.runs[0].events[0].features, undefined);
  assert.equal(enriched.runs[0].events[2].features, undefined);
  assert.equal(signatures.processGraph(enriched).totalNodes, 1);
});
test('related steps preserve original indexes, rank informative shared keys, and exclude self', () => {
  const data = signatures.enrich({runs: [{id: 'a', events: [{kind: 'message', text: 'request'},
    toolEvent('bash', 'rg x src/shared.py', 'ModuleNotFoundError', 1), toolEvent('read', 'src/other.py', '', 2)]},
  {id: 'b', events: [toolEvent('bash', 'rg y src/shared.py', 'ModuleNotFoundError'), toolEvent('write', 'src/unique.py', '', 1)]}]});
  const matches = signatures.related(data, 'a', 1, {excludeSameRun: true});
  assert.equal(matches[0].runId, 'b');
  assert.equal(matches[0].eventIndex, 0);
  assert.ok(matches[0].similarity > 0);
  assert.ok(matches[0].sharedKeys.includes('FILE_PATH:src/shared.py'));
  assert.ok(matches.every(match => match.runId !== 'a'));
  assert.deepEqual(signatures.related(data, 'a', 0), []);
  assert.deepEqual(signatures.related(data, 'missing', 0), []);
});
test('parsed source metadata has explicit provenance and its pipeline phase policy', () => {
  const event = toolEvent('terminal', '{"cmd":"rg x"}', 'output');
  event.sourceRecords = [{record: {raw_action: event.inputText, raw_observation: event.outputText,
    command_class: 'grep', action_type: 'search', observation_signature: ['custom_pattern']}}];
  const result = signatures.enrich({runs: [{id: 'a', events: [event]}]}).runs[0].events[0].features;
  assert.ok(result.keys.includes('ACTION:search'));
  assert.ok(result.evidence.some(item => item.key === 'OBS:custom_pattern' && item.rule === 'tracegraph:parsed-record:observation_signature'));
  assert.deepEqual(result.keys.filter(key => key.startsWith('PHASE:')), ['PHASE:early']);
});
test('mutual-kNN uses reciprocal membership and deterministic source-order ties', () => {
  const matrix = [[0, .1, .1, .9], [.1, 0, .5, .7], [.1, .5, 0, .4], [.9, .7, .4, 0]];
  assert.deepEqual(signatures.computeKnn(matrix, 1), [[1], [0], [0], [2]]);
  const edges = signatures.buildMutualKnnEdges(matrix, 1);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].source, 0); assert.equal(edges[0].target, 1);
  close(edges[0].weight, Math.exp(-.1 / .35), 1e-6);
  assert.deepEqual(signatures.buildMutualKnnEdges(matrix, 1, {excludeSameRun: true, sliceRun: ['a', 'a', 'b', 'b']}), []);
});
test('graph limit is explicit and never silently samples or weakens related search', () => {
  const events = Array.from({length: 301}, (_, index) => toolEvent('bash', index % 2 ? 'rg x src/shared.py' : 'pytest src/shared.py', '', index));
  const data = signatures.enrich({runs: [{id: 'large', events}]});
  const graph = signatures.processGraph(data);
  assert.equal(graph.limited, true); assert.equal(graph.totalNodes, 301); assert.equal(graph.maxNodes, 300);
  assert.deepEqual(graph.nodes, []); assert.deepEqual(graph.edges, []);
  assert.ok(signatures.related(data, 'large', 300).length > 0);
  const small = signatures.processGraph({runs: [{id: 'a', events: events.slice(0, 3)}]}, {minSimilarity: 0});
  assert.equal(small.limited, false);
  assert.equal(small.nodes.length, 3);
  for (const edge of small.edges) assert.ok(small.nodes.some(node => node.id === edge.source) && small.nodes.some(node => node.id === edge.target));
});
test('BCC and articulation points equal the pinned Python iterative Tarjan algorithms', () => {
  for (const fixture of golden.bcc_cases) {
    assert.deepEqual(signatures.findArticulationPoints(fixture.adjacency), fixture.articulation_points, fixture.name);
    assert.deepEqual(signatures.findBiconnectedComponents(fixture.adjacency), fixture.blocks, fixture.name);
  }
});
test('Process-map blocks and cuts equal upstream decomposition of the displayed threshold graph', () => {
  // Supply exact upstream key sets to isolate graph parity from local raw-input
  // extensions. Real events continue to acquire these features automatically.
  const data = {runs: [{id: 'a', events: golden.cases.slice(0, 5).map((fixture, index) => ({...toolEvent('golden', '', '', index), features: {keys: fixture.keys, evidence: []}}))},
    {id: 'b', events: golden.cases.slice(5).map((fixture, index) => ({...toolEvent('golden', '', '', index), features: {keys: fixture.keys, evidence: []}}))}]};
  const expected = golden.process_graph_structure;
  const graph = signatures.processGraph(data, {k: expected.k, minSimilarity: expected.min_similarity});
  const nodeIndex = id => graph.nodes.findIndex(node => node.id === id);
  const edges = graph.edges.map(edge => ({source: nodeIndex(edge.source), target: nodeIndex(edge.target), distance: edge.distance, weight: edge.weight}))
    .sort((a, b) => a.source - b.source || a.target - b.target);
  assert.deepEqual(edges, expected.edges);
  assert.deepEqual(graph.articulationPoints.map(nodeIndex), expected.articulation_points);
  assert.deepEqual(graph.blocks.map(block => block.nodeIds.map(nodeIndex)), expected.blocks);
  for (const block of graph.blocks) {
    assert.equal(block.size, block.nodeIds.length);
    assert.equal(block.trivial, block.size <= 2);
    assert.deepEqual(block.runIds, Array.from(new Set(block.nodeIds.map(id => graph.nodes[nodeIndex(id)].runId))));
    assert.equal(block.role, undefined); assert.equal(block.reward, undefined); assert.equal(block.trap, undefined);
  }
  const noEdges = signatures.processGraph(data, {k: expected.k, minSimilarity: 1.01});
  assert.deepEqual(noEdges.edges, []); assert.deepEqual(noEdges.blocks, []); assert.deepEqual(noEdges.articulationPoints, []);
});
test('BCC membership keeps overlapping articulation vertices and trivial bridges explicit', () => {
  const bowtie = golden.bcc_cases.find(fixture => fixture.name === 'bowtie');
  const blocks = signatures.findBiconnectedComponents(bowtie.adjacency);
  assert.equal(blocks.filter(block => block.includes(2)).length, 2);
  assert.ok(blocks.every(block => block.length === 3));
  const chain = golden.bcc_cases.find(fixture => fixture.name === 'chain');
  assert.ok(signatures.findBiconnectedComponents(chain.adjacency).every(block => block.length === 2));
  const longChain = Array.from({length: 300}, (_, i) => [i - 1, i + 1].filter(n => n >= 0 && n < 300));
  assert.equal(signatures.findBiconnectedComponents(longChain).length, 299);
  assert.equal(signatures.findArticulationPoints(longChain).length, 298);
});
test('Process-map limit keeps blocks and articulation arrays explicit without sampling', () => {
  const data = {runs: [{id: 'a', events: [toolEvent('bash', 'rg x'), toolEvent('bash', 'pytest x', '', 1)]}]};
  const graph = signatures.processGraph(data, {maxNodes: 1});
  assert.equal(graph.limited, true);
  assert.deepEqual(graph.blocks, []); assert.deepEqual(graph.articulationPoints, []);
});
