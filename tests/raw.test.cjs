'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Raw=require('../web/raw.js');
const parse=value=>Raw.parse(JSON.stringify(value),'fixture.json');
test('OpenAI parallel and delayed results pair by exact IDs, retaining source text and reported error',()=>{
 const original='\n{ "name":"parallel", "messages": [\n {"role":"assistant","content":"Inspect both files","tool_calls":[{"id":"a","function":{"name":"read_file","arguments":"{\\"path\\":\\"A.py\\"}"}},{"id":"b","function":{"name":"read_file","arguments":"{\\"path\\":\\"B.py\\"}"}}]},\n {"role":"tool","tool_call_id":"b","content":"B content"},\n {"role":"assistant","content":"Waiting on A"},\n {"role":"tool","tool_call_id":"a","content":"{\\"exit_code\\":1,\\"output\\":\\"missing\\"}"}\n ]}';
 const data=Raw.parse(original,'parallel.json'),events=data.runs[0].events,calls=events.filter(e=>e.actionKey);
 assert.equal(calls.length,2);assert.equal(calls[0].outputText,'{"exit_code":1,"output":"missing"}');assert.equal(calls[1].outputText,'B content');assert.equal(calls[0].status,'error');assert.equal(calls[1].status,'unknown');
 assert.equal(calls[0].sourceRecords[0].rawText,'{"id":"a","function":{"name":"read_file","arguments":"{\\"path\\":\\"A.py\\"}"}}');assert.equal(calls[0].sourceRecords[0].line,3);assert.equal(data.runs[0].outcome,'unknown');assert.equal(Raw.analyze(data).totals.messages,2);
});
test('Codex native schemas support custom calls, exact pairing, mirrored messages, and wrapper exit codes',()=>{
 const rows=[{type:'session_meta',payload:{id:'session-a'}},{type:'turn_context',payload:{turn_id:'turn1',model:'gpt-test'}},{type:'event_msg',payload:{type:'user_message',message:'Fix test'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Fix test'}]}},{type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"pytest"}',call_id:'c1'}},{type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',input:'*** Begin Patch',call_id:'c2'}},{type:'response_item',payload:{type:'custom_tool_call_output',call_id:'c2',output:'Patch applied'}},{type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'Chunk ID: abc\nWall time: 0.2 seconds\nProcess exited with code 1\nFinal output:\nFAILED'}},{type:'event_msg',payload:{type:'agent_message',message:'I need another attempt'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'I need another attempt'}]}},{type:'event_msg',payload:{type:'agent_reasoning',text:'do not invent a timeline entry'}}];
 const data=Raw.parse(rows.map(JSON.stringify).join('\n'),'session.jsonl'),run=data.runs[0];
 assert.equal(run.id,'session-a');assert.equal(run.model,'gpt-test');assert.equal(Raw.analyze(data).totals.calls,2);assert.equal(Raw.analyze(data).totals.messages,2);assert.equal(run.events.find(e=>e.callId==='c1').status,'error');assert.match(run.events.find(e=>e.callId==='c1').statusBasis,/reported-exit-code/);assert.equal(run.events.find(e=>e.callId==='c2').outputText,'Patch applied');assert.equal(run.events[0].sourceRecords.length,2);assert.equal(run.source.unparsedRecords.length,1);assert.equal(run.outcome,'unknown');
});
test('Anthropic content and OpenAI Responses tool/result records are accepted without state labels',()=>{
 const data=parse({runs:[{id:'claude',messages:[{role:'assistant',content:[{type:'text',text:'Reading'},{type:'tool_use',id:'u1',name:'read',input:{path:'a.py'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'u1',is_error:true,content:[{type:'text',text:'No file'}]}]}]},{id:'responses',output:[{type:'function_call',name:'read',arguments:'{"path":"a.py"}',call_id:'r1'},{type:'function_call_output',call_id:'r1',output:{exit_code:0,text:'contents'}}]}]});
 assert.equal(data.runs[0].events.find(e=>e.actionKey).status,'error');assert.equal(data.runs[1].events[0].status,'ok');assert.equal(data.runs[0].events.find(e=>e.actionKey).actionKey,data.runs[1].events[0].actionKey);assert.equal(Raw.compare(data.runs[0],data.runs[1]).commonPrefix,1);
 assert.equal(data.runs[0].events[0].kind,'message');assert.equal(data.runs[0].events[0].text,'Reading');
});
test('repeats ignore transport IDs and JSON key order while preserving path and parameter capitalization',()=>{
 const data=parse({messages:[{role:'assistant',tool_calls:[{id:'one',function:{name:'read',arguments:'{"path":"A.py","mode":"r"}'}},{id:'two',function:{name:'read',arguments:'{"mode":"r","path":"A.py"}'}},{id:'three',function:{name:'read',arguments:'{"path":"a.py","mode":"r"}'}},{id:'four',function:{name:'Read',arguments:'{"path":"A.py","mode":"r"}'}}]}]});
 const result=Raw.analyze(data);assert.equal(result.totals.calls,4);assert.equal(result.totals.repeatedCalls,1);assert.equal(result.nodes.length,3);assert.equal(result.nodes[0].count,2);assert.equal(result.edges.length,3);assert.equal(data.runs[0].events[0].status,'pending');
});
test('orphan results and reused IDs remain visible without guessed pairing or inferred keyword failures',()=>{
 const data=parse({messages:[{role:'tool',tool_call_id:'missing',content:'FAILED with error'},{role:'assistant',tool_calls:[{id:'reuse',function:{name:'a',arguments:'{}'}},{id:'reuse',function:{name:'b',arguments:'{}'}}]},{role:'tool',tool_call_id:'reuse',content:{exit_code:1}}]});
 assert.equal(data.runs[0].events.filter(e=>e.unmatchedOutput).length,2);assert.equal(data.runs[0].events[0].status,'unknown');assert.equal(data.runs[0].events.find(e=>e.tool==='a').outputText,'');assert.equal(Raw.analyze(data).totals.calls,2);assert.equal(Raw.analyze(data).totals.failedCalls,0);assert.ok(data.warnings.some(w=>w.includes('ambiguous')));
});
test('generic action/observation and TraceGraph-style rows preserve supplied thought and explicit outcome',()=>{
 const raw={instance_id:'task-1',is_resolved:false,benchmark:'swe',model:'agent',trajectory:JSON.stringify([{thought:'Recorded thought',action:{tool:'bash',arguments:{cmd:'pwd'}},observation:{exit_code:0,stdout:'/repo'}},{action:'pytest',observation:'FAILED test; still no structured exit status'}])};
 const data=parse(raw),run=data.runs[0];assert.equal(run.outcome,'failure');assert.equal(run.events[0].kind,'message');assert.equal(run.events[0].text,'Recorded thought');assert.equal(run.events[1].status,'ok');assert.equal(run.events[2].status,'unknown');assert.equal(run.source.metadata.instance_id,'task-1');assert.equal(Raw.analyze(data).totals.calls,2);
});
test('multi-file import is atomic, renames duplicate IDs with provenance, and rejects malformed and oversized inputs',()=>{
 const text=JSON.stringify({id:'same',steps:[{action:'pwd',observation:'here'}]});const data=Raw.importFiles([{name:'a.json',text},{name:'b.json',text}]);assert.equal(data.runs.length,2);assert.notEqual(data.runs[0].id,data.runs[1].id);assert.equal(data.runs[1].source.originalRunId,'same');assert.equal(data.runs[1].source.filename,'b.json');
 assert.throws(()=>Raw.importFiles([{name:'a.json',text},{name:'b.jsonl',text:'{"steps":["a"]}\n{bad}\n'}]),/line 2/);assert.equal(data.runs.length,2);
 for(const input of ['', '{}', '{"messages":[]}', '{"steps":[{}]}'])assert.throws(()=>Raw.parse(input,'bad.json'));
 assert.throws(()=>Raw.parse(' '.repeat(Raw.limits.fileBytes+1)+'{}','big.json'),/10 MB/);
 assert.throws(()=>parse({runs:Array.from({length:101},(_,i)=>({id:String(i),steps:['recorded']}))}),/100 runs/);
});
test('canonical roundtrip preserves evidence, feature annotations and comparisons; report explains method',()=>{
 const data=parse({name:'<unsafe>|test',runs:[{id:'a',steps:[{action:'pwd',observation:{exit_code:0}},{action:'pwd',observation:'again'}]},{id:'b',steps:[{action:'pwd',observation:'recorded'}]}]});data.runs[0].events[0].features={keys:['CMD:pwd'],evidence:[{source:'input',excerpt:'pwd'}]};
 const roundtrip=Raw.parse(Raw.exportJSON(data),'export.json');assert.deepEqual(roundtrip,data);const diff=Raw.compare(data.runs[0],data.runs[1]);assert.equal(diff.commonPrefix,1);assert.deepEqual(diff.firstDifference,{aIndex:1,bIndex:null});assert.equal(diff.jaccard,1);
 const report=Raw.exportMarkdown(data);assert.match(report,/same invocation within a run/);assert.match(report,/not proof of wasted work/);assert.match(report,/hidden-activation/);assert.ok(report.includes('&lt;unsafe&gt;'));assert.match(report,/Calls with an explicitly reported error: 0/);
});
test('browser global loads without require or a DOM',()=>{const c=vm.createContext({TextEncoder});vm.runInContext(fs.readFileSync(require.resolve('../web/raw.js'),'utf8'),c);assert.equal(typeof c.LensRaw.parse,'function');assert.equal(c.LensRaw.analyze(c.LensRaw.parse('{"steps":[{"action":"pwd"}]}','a.json')).totals.calls,1);});
test('real-shaped project examples cover Codex, Anthropic and TraceGraph parsed rows',()=>{
 const path=require('node:path');const fixture=name=>Raw.parse(fs.readFileSync(path.join(__dirname,'../examples',name),'utf8'),name);
 const codex=fixture('codex-session.jsonl');assert.deepEqual(Raw.analyze(codex).totals,{runs:1,calls:5,failedCalls:2,repeatedCalls:2,messages:2});assert.equal(codex.runs[0].model,'Demo agent');
 const anthropic=fixture('anthropic-tools.json');assert.equal(Raw.analyze(anthropic).totals.calls,2);assert.equal(Raw.analyze(anthropic).totals.failedCalls,1);
 const parsed=fixture('tracegraph-parsed.jsonl'),run=parsed.runs[0];assert.equal(run.source.format,'tracegraph-parsed');assert.equal(run.model,'Demo agent');assert.equal(run.events.length,2);assert.equal(run.events[1].status,'error');assert.equal(run.events[1].sourceRecords[0].record.command_class,'pytest');assert.notEqual(run.events[0].actionKey,run.events[1].actionKey);assert.match(run.events[1].inputText,/pytest/);assert.match(run.events[1].outputText,/FAILED/);assert.equal(run.outcome,'failure');assert.deepEqual(Raw.parse(Raw.exportJSON(parsed),'roundtrip.json'),parsed);
 const score=parse({metadata:{resolved_score:1},steps:[{raw_action:'pwd',raw_observation:'/',tool_name:'bash'}]});assert.equal(score.runs[0].outcome,'success');
});
test('2,000 completed calls fit event limit after pairing; null arguments retain identity on roundtrip',()=>{
 const messages=[];for(let i=0;i<2000;i++){messages.push({role:'assistant',tool_calls:[{id:String(i),function:{name:'tool',arguments:null}}]});messages.push({role:'tool',tool_call_id:String(i),content:'returned'});}
 const data=parse({messages});assert.equal(data.runs[0].events.length,2000);assert.equal(Raw.analyze(data).totals.calls,2000);assert.deepEqual(Raw.parse(Raw.exportJSON(data),'roundtrip.json'),data);assert.throws(()=>parse({steps:Array.from({length:2001},()=>({action:'pwd'}))}),/2,000 events/);
});
test('unsafe integer and decimal JSON parameters remain distinct without altering original input evidence',()=>{
 const args=['{"seed":9007199254740992}','{"seed":9007199254740993}','{"ratio":0.1}','{"ratio":0.10000000000000001}','{"huge":1e400}','{"huge":2e400}'];
 const data=parse({messages:[{role:'assistant',tool_calls:args.map((argumentText,i)=>({id:String(i),function:{name:'set',arguments:argumentText}}))}]});
 assert.equal(Raw.analyze(data).totals.repeatedCalls,0);assert.equal(Raw.analyze(data).nodes.length,args.length);assert.deepEqual(data.runs[0].events.map(e=>e.inputText),args);assert.ok(data.warnings.some(w=>w.includes('numeric precision')));assert.deepEqual(Raw.parse(Raw.exportJSON(data),'canonical.json'),data);
 const anthropic='{"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"set","input":{"seed":9007199254740992}},{"type":"tool_use","id":"b","name":"set","input":{"seed":9007199254740993}}]}]}';
 const structured=Raw.parse(anthropic,'anthropic.json');assert.equal(Raw.analyze(structured).totals.repeatedCalls,0);assert.match(structured.runs[0].events[1].inputText,/9007199254740993/);assert.deepEqual(Raw.parse(Raw.exportJSON(structured),'canonical.json'),structured);
 const safe=parse({messages:[{role:'assistant',tool_calls:[{function:{name:'set',arguments:'{"a":1e3,"b":"9007199254740993"}'}},{function:{name:'set',arguments:'{"b":"9007199254740993","a":1000.0}'}}]}]});assert.equal(Raw.analyze(safe).totals.repeatedCalls,1);
});
test('hasOutput distinguishes empty observations and native empty results from no result, including legacy canonical imports',()=>{
 const generic=parse({steps:[{action:'submit',observation:''},{action:'poll'},{action:'nil',observation:null},{raw_action:'done',raw_observation:''}]});assert.deepEqual(generic.runs[0].events.map(e=>e.hasOutput),[true,false,true,true]);
 const native=parse({messages:[{role:'assistant',tool_calls:[{id:'a',function:{name:'empty',arguments:'{}'}},{id:'b',function:{name:'pending',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:''},{role:'tool',tool_call_id:'orphan',content:''},{role:'user',content:'recorded'}]});assert.deepEqual(native.runs[0].events.map(e=>e.hasOutput),[true,false,true,false]);assert.equal(native.runs[0].events[0].outputText,'');assert.equal(native.runs[0].events[0].status,'unknown');
 const codex=Raw.parse([{type:'response_item',payload:{type:'function_call',name:'empty',arguments:'{}',call_id:'x'}},{type:'response_item',payload:{type:'function_call_output',call_id:'x',output:''}}].map(JSON.stringify).join('\n'),'empty.jsonl');assert.equal(codex.runs[0].events[0].hasOutput,true);
 for(const dataset of [generic,native,codex]){const legacy=JSON.parse(Raw.exportJSON(dataset));legacy.runs.forEach(r=>r.events.forEach(e=>delete e.hasOutput));const restored=Raw.parse(JSON.stringify(legacy),'legacy.json');assert.deepEqual(restored,dataset);}
});
