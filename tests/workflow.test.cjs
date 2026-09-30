'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Raw = require('../web/raw.js');
const Signatures = require('../web/signatures.js');
const read = name => fs.readFileSync(path.join(__dirname,'../examples',name),'utf8');

test('native Codex records produce tool evidence and automatic features without state labels', () => {
  const data = Raw.parse(read('codex-session.jsonl'),'codex-session.jsonl');
  const totals = Raw.analyze(data).totals;
  assert.equal(totals.calls,5);
  assert.equal(totals.failedCalls,2);
  assert.equal(totals.repeatedCalls,2);
  const enriched = Signatures.enrich(data);
  const run = enriched.runs[0];
  const failed = run.events.find(e => e.kind==='tool' && e.status==='error');
  assert.ok(failed.features.keys.includes('OBS:IndexError'));
  assert.ok(failed.features.keys.includes('CMD:pytest'));
  assert.ok(failed.features.keys.some(k => k.startsWith('FILE_PATH:') && k.includes('test_transform.py')));
  assert.match(failed.outputText,/Process exited with code 1/);
  assert.ok(failed.sourceRecords.length >= 2);
  const related = Signatures.related(enriched,run.id,run.events.indexOf(failed),{limit:10});
  assert.ok(related.some(candidate => candidate.runId===run.id && candidate.eventIndex!==run.events.indexOf(failed) && candidate.sharedKeys.includes('OBS:IndexError')));
});

test('mixed native exporters retain independent runs, explicit errors and exact raw evidence', () => {
  const files = ['codex-session.jsonl','anthropic-tools.json','tracegraph-parsed.jsonl'].map(name=>({name,text:read(name)}));
  const data = Raw.importFiles(files);
  assert.equal(data.runs.length,3);
  assert.equal(Raw.analyze(data).totals.calls,9);
  assert.equal(Raw.analyze(data).totals.failedCalls,4);
  const toolEvents = data.runs.flatMap(r => r.events.filter(e=>e.kind==='tool'));
  assert.ok(toolEvents.every(e => e.inputText && e.sourceRecords.length));
  const reloaded = Raw.parse(Raw.exportJSON(Signatures.enrich(data)),'roundtrip.json');
  assert.deepEqual(Raw.analyze(reloaded).totals,Raw.analyze(data).totals);
  assert.deepEqual(reloaded.runs.map(r=>r.events.map(e=>e.sourceRecords)),data.runs.map(r=>r.events.map(e=>e.sourceRecords)));
  assert.match(Raw.exportMarkdown(reloaded),/invocation|tool call/i);
});
