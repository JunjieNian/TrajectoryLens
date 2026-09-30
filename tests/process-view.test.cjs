/* SPDX-License-Identifier: Apache-2.0 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ProcessView = require('../web/process-view.js');
function fixture(counts) {
  const nodes = [], runs = counts.map((count,runIndex)=>({id:'run-'+runIndex,name:'Run '+runIndex,
    events:Array.from({length:count*2},(_,index)=>index%2?{kind:'tool',tool:'exec_command',inputText:'{"cmd":"pytest"}',status:'unknown'}:{kind:'message',text:'Prose'})}));
  for (const run of runs) run.events.forEach((event,eventIndex)=>{
    if (event.kind==='tool') nodes.push({id:'slice-'+nodes.length,runId:run.id,eventIndex,keys:['CMD:pytest']});
  });
  return {data:{runs},graph:{nodes,edges:[],blocks:[],articulationPoints:[]}};
}
test('dense process-map nodes keep disjoint pointer targets at every supported zoom', () => {
  for (const count of [2,3,50,300]) for (const zoom of [.25,.5,1,2,4]) {
    const {data,graph} = fixture([count]), geometry = ProcessView.layout(data,graph,{width:358,zoom});
    assert.equal(geometry.points.length,count);
    for (let i=1;i<geometry.points.length;i++) {
      const previous=geometry.points[i-1],current=geometry.points[i];
      assert.ok(previous.x+previous.hitWidth/2 < current.x-current.hitWidth/2, `${count} calls @ zoom ${zoom}: targets overlap`);
    }
    for (const point of geometry.points) {
      assert.ok(point.x-point.hitWidth/2 >= 0);
      assert.ok(point.x+point.hitWidth/2 <= geometry.width);
      assert.ok(point.y-15 >= 0 && point.y+point.hitHeight <= geometry.height);
    }
  }
});
test('300-call natural width grows for horizontal scrolling instead of squeezing to a fixed cap', () => {
  const small=fixture([50]),large=fixture([300]);
  const a=ProcessView.layout(small.data,small.graph,{width:650}),b=ProcessView.layout(large.data,large.graph,{width:650});
  assert.ok(a.width>1600);assert.ok(b.width>a.width*5);
  const gaps=b.points.slice(1).map((point,index)=>point.x-b.points[index].x);
  assert.ok(gaps.every(gap=>gap>=48), 'default zoom leaves usable targets between centers');
});
test('relative-order lanes align endpoints while retaining singleton and original event indexes', () => {
  const {data,graph}=fixture([3,7,1]),geometry=ProcessView.layout(data,graph,{width:900});
  const a=geometry.points.filter(point=>point.runId==='run-0'),b=geometry.points.filter(point=>point.runId==='run-1');
  assert.equal(a[0].x,b[0].x);assert.equal(a.at(-1).x,b.at(-1).x);
  const singleton=geometry.points.find(point=>point.runId==='run-2');
  assert.equal(singleton.x,(geometry.left+geometry.right)/2);
  assert.equal(new Set(geometry.lanes.map(lane=>lane.y)).size,3);
  for (const point of geometry.points) {
    assert.equal(point.eventIndex%2,1);
    assert.equal(point.event,data.runs.find(run=>run.id===point.runId).events[point.eventIndex]);
  }
});
test('layout preserves every occurrence and does not mutate data, graph topology or block membership', () => {
  const {data,graph}=fixture([6,4]);
  graph.edges=[{source:'slice-0',target:'slice-8',similarity:.5}];
  graph.blocks=[{id:'block-0',nodeIds:['slice-0','slice-8'],trivial:true}];
  const before=JSON.stringify({data,graph});
  ProcessView.layout(data,graph,{width:400,zoom:.5,focusOnly:true});
  assert.equal(JSON.stringify({data,graph}),before);
});
