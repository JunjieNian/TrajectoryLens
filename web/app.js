(() => {
  'use strict';
  const $=id=>document.getElementById(id), L=window.LensRaw, S=window.LensSignatures, I=window.TL_I18N;
  const t=(key,values)=>I.t(key,values);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data,analysis,runId,compareId=null,eventIndex=0,filter='all',view='timeline',isDemo=true,pendingFiles=[],mapReady=false,processReady=false,activeBlock=null;
  let graphCache=null;
  const NS='http://www.w3.org/2000/svg';
  const invocation=e=>e.kind==='tool'&&!!e.actionKey;
  function run(id=runId){return data.runs.find(r=>r.id===id);}
  function eventsFor(r){return r.events.map((e,i)=>({e,i}));}
  function callsFor(r){return eventsFor(r).filter(({e})=>invocation(e));}
  function selected(){return run().events[eventIndex];}
  function preview(e,max=180){let text=e.inputText||e.text||e.outputText||'';try{const o=JSON.parse(text);if(o&&typeof o==='object')text=o.cmd||o.command||o.file_path||o.path||o.patch||text;}catch{}text=String(text);return text.length>max?text.slice(0,max-1)+'…':text;}
  function outputPreview(e){let value=e.outputText||'';try{const o=JSON.parse(value);if(o&&typeof o==='object')value=o.output??o.stdout??o.stderr??value;}catch{}return String(value).replace(/\s+/g,' ').slice(0,170);}
  function statusName(e){return t({ok:'statusOk',error:'statusError',pending:'statusPending',unknown:'statusUnknown'}[e.status]||'statusUnknown');}
  function statusBadge(e){return `<span class="status ${esc(e.status||'unknown')}">${esc(statusName(e))}</span>`;}
  function repeatIndices(r){const seen=new Set(),indices=new Set();r.events.forEach((e,i)=>{if(!invocation(e))return;if(seen.has(e.actionKey))indices.add(i);seen.add(e.actionKey);});return indices;}
  function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
  function download(name,text,type){const u=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=u;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  async function copy(text){try{if(!navigator.clipboard)throw new Error();await navigator.clipboard.writeText(text);toast(t('copied'));}catch{toast(t('copyUnavailable'));}}
  function load(parsed,demo=false){
    const next=S?S.enrich(parsed):parsed;
    const nextAnalysis=L.analyze(next);
    data=next;analysis=nextAnalysis;isDemo=demo;runId=data.runs[0].id;compareId=null;
    graphCache=null;activeBlock=null;
    eventIndex=run().events.findIndex(invocation);if(eventIndex<0)eventIndex=0;
    filter='all';view='timeline';$('show-messages').checked=!callsFor(run()).length;render();
  }
  function selectRun(id){if(!data.runs.some(r=>r.id===id))return;if(id===compareId)compareId=runId;runId=id;eventIndex=run().events.findIndex(invocation);if(eventIndex<0)eventIndex=0;filter='all';$('show-messages').checked=!callsFor(run()).length;render();}
  function selectEvent(id,index){if(!data.runs.some(r=>r.id===id)||!run(id).events[index])return;if(runId!==id){if(compareId===id)compareId=runId;runId=id;filter='all';}eventIndex=index;if(!invocation(selected()))$('show-messages').checked=true;render();const row=$('timeline').querySelector(`[data-event="${index}"]`);if(row&&view==='timeline')row.scrollIntoView({block:'nearest',behavior:'smooth'});}
  function render(){
    if(!data)return;
    I.apply();$('method-content').innerHTML=t('methodsHtml');
    $('data-kind').textContent=t(isDemo?'synthetic':'imported');$('data-kind').classList.toggle('imported',!isDemo);$('dataset-name').textContent=data.name||'Agent logs';
    $('run-select').innerHTML=data.runs.map(r=>`<option value="${esc(r.id)}" ${r.id===runId?'selected':''}>${esc(r.name||r.id)}</option>`).join('');
    $('compare-select').innerHTML=`<option value="">${esc(t('none'))}</option>`+data.runs.filter(r=>r.id!==runId).map(r=>`<option value="${esc(r.id)}" ${r.id===compareId?'selected':''}>${esc(r.name||r.id)}</option>`).join('');
    if(compareId===runId)compareId=null;
    const metrics=analysis.perRun.find(r=>r.id===runId);
    $('export-process-svg').disabled=!S||analysis.totals.calls>300||!analysis.totals.calls;
    $('run-metrics').innerHTML=['calls','failedCalls','repeatedCalls'].map(key=>`<span><b>${metrics[key]??0}</b>${esc(t({calls:'calls',failedCalls:'errors',repeatedCalls:'repeats'}[key]))}</span>`).join('');
    const r=run(),calls=callsFor(r),paired=calls.filter(({e})=>e.hasOutput??(e.status!=='pending'&&(e.outputText!==''||e.sourceRecords?.length>1))).length,orphans=r.events.filter(e=>e.unmatchedOutput||e.isInvocation===false&&e.kind==='tool').length;
    const source=typeof r.source==='object'?r.source:{};
    $('source-summary').innerHTML=`<span>${esc(t('sourceFormat'))}: <strong>${esc(source.format||data.format||'raw')}</strong>${source.filename?` · ${esc(source.filename)}`:''}</span><span><strong>${paired}</strong> ${esc(t('paired'))}</span><span><strong>${orphans}</strong> ${esc(t('unmatched'))}</span><span>${esc(r.outcome&&r.outcome!=='unknown'?t('recordedOutcome')+': '+r.outcome:t('unknownTask'))}</span>`;
    const notes=Array.isArray(data.warnings)?data.warnings:[];$('warnings').hidden=!notes.length;$('warning-summary').textContent=`${notes.length} ${t('warnings')}`;$('warning-list').innerHTML=notes.map(n=>`<p>${esc(typeof n==='string'?n:JSON.stringify(n))}</p>`).join('');
    renderComparison();renderTimeline();renderDetail();drawMap();if(view==='process')drawProcess();
    $('file-label').textContent=pendingFiles.length?t('fileChosen',{n:pendingFiles.length}):t('chooseFiles');
  }
  function renderComparison(){
    $('comparison').hidden=!compareId;if(!compareId)return;
    const result=L.compare(run(),run(compareId));
    $('comparison').innerHTML=`<div class="comparison-top"><h3>${esc(t('callSequence'))}</h3><span class="comparison-stat"><b>${result.commonPrefix}</b>${esc(t('prefix'))}</span><span class="comparison-stat"><b>${result.sharedActions}/${result.totalActions}</b>${esc(t('overlap'))} · ${(result.jaccard*100).toFixed(0)}%</span></div><p class="comparison-note">${esc(t(result.firstDifference?'differentSequence':'sameSequence'))}</p>`;
    if(result.firstDifference){
      const d=result.firstDifference;
      const sides=[{r:run(),i:d.aIndex},{r:run(compareId),i:d.bIndex}];
      const box=document.createElement('div');box.className='comparison-difference';
      box.innerHTML=sides.map(({r,i})=>{const e=i==null?null:r.events.find(e=>e.index===i)||r.events[i];return `<button ${e?`data-difference-run="${esc(r.id)}" data-difference-index="${r.events.indexOf(e)}"`:'disabled'}><span>${esc(r.name||r.id)} · ${esc(t('firstDifference'))}</span><strong>${esc(e?.tool||t('ended'))}</strong>${e?`<code>${esc(preview(e,160))}</code>`:''}</button>`;}).join('');
      $('comparison').append(box);box.querySelectorAll('[data-difference-run]').forEach(b=>b.onclick=()=>selectEvent(b.dataset.differenceRun,+b.dataset.differenceIndex));
    }
  }
  function renderTimeline(){
    const r=run(),repeated=repeatIndices(r),calls=callsFor(r),numbers=new Map(calls.map(({i},n)=>[i,n+1]));
    const includeMessages=$('show-messages').checked||!calls.length;
    const shown=eventsFor(r).filter(({e,i})=>invocation(e)?filter==='all'||filter==='failed'&&e.status==='error'||filter==='repeated'&&repeated.has(i):includeMessages&&filter==='all');
    document.querySelectorAll('[data-filter]').forEach(b=>{const active=b.dataset.filter===filter;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});
    for(const [id,value] of [['timeline-view','timeline'],['map-view','map'],['process-view','process']]){ $(id).classList.toggle('active',view===value);$(id).setAttribute('aria-pressed',view===value); }
    $('timeline').hidden=view!=='timeline';$('map-container').hidden=view!=='map';$('process-container').hidden=view!=='process';
    document.querySelector('.filter-row').hidden=view!=='timeline';$('timeline-explanation').hidden=view!=='timeline';
    $('view-heading').textContent=t({timeline:'timeline',map:'actionMap',process:'processMap'}[view]);
    $('timeline-explanation').textContent=calls.length?`${t('timelineCount',{shown:shown.filter(({e})=>invocation(e)).length,total:calls.length})}. ${t({all:'allExplanation',failed:'failedExplanation',repeated:'repeatExplanation'}[filter])}`:t('messageOnly');
    $('timeline').innerHTML=shown.length?shown.map(({e,i})=>{
      const tool=invocation(e),orphan=e.kind==='tool'&&!tool;
      const label=tool?e.tool:orphan?t('orphanLabel'):(e.role||t('messageLabel'));
      return `<div class="timeline-row ${tool?'':'message-row'}"><span class="call-number">${tool?String(numbers.get(i)).padStart(2,'0'):'·'}</span><button class="event-card ${i===eventIndex?'selected':''}" data-event="${i}" aria-pressed="${i===eventIndex}"><span class="event-title"><span class="tool-name">${esc(label)}</span><span class="event-badges">${tool?statusBadge(e):''}${repeated.has(i)?`<span class="repeat-badge">${esc(t('repeatLabel'))}</span>`:''}</span></span><code class="input-preview">${esc(preview(e,170))}</code>${tool?`<span class="output-preview">${esc(outputPreview(e)||t(e.hasOutput?'emptyOutput':'noOutput'))}</span>`:''}</button></div>`;
    }).join(''):`<p class="empty">${esc(t(calls.length?'noFilterMatches':'noEvents'))}</p>`;
    $('timeline').querySelectorAll('[data-event]').forEach(b=>b.onclick=()=>selectEvent(runId,+b.dataset.event));
  }
  function renderDetail(){
    const e=selected();if(!e){$('event-detail').innerHTML=`<p class="empty">${esc(t('noEvents'))}</p>`;$('features-section').hidden=true;$('related-section').hidden=true;return;}
    const tool=invocation(e),calls=callsFor(run()),number=calls.findIndex(({i})=>i===eventIndex)+1;
    $('event-location').textContent=`${run().name||runId} · ${t(tool?'callLabel':'eventLabel',{n:tool?number:eventIndex+1})}`;
    const block=(id,label,text,output=false)=>`<div class="detail-block"><div class="block-label"><span>${esc(label)}</span><button class="text-link" data-copy="${id}">${esc(t('copy'))}</button></div><pre class="code-text ${output?'output':''}" id="${id}">${esc(text)}</pre></div>`;
    $('event-detail').innerHTML=`<div class="detail-heading"><h2>${esc(tool?e.tool:e.kind==='tool'?t('orphanLabel'):(e.role||t('messageLabel')))}</h2>${tool?statusBadge(e):''}</div>${tool?`<p class="detail-status">${e.statusBasis?`${esc(t('statusBasis'))}: ${esc(typeof e.statusBasis==='string'?e.statusBasis:JSON.stringify(e.statusBasis))}`:esc(t('unknownTask'))}</p>`:''}${tool?block('input-record',t('toolInput'),e.inputText||''):''}${tool?block('output-record',t('pairedOutput'),e.outputText||(e.hasOutput?t('emptyOutput'):t('noOutput')),true):block('message-record',t(e.kind==='tool'?'outputRecord':'messageContent'),e.text||e.outputText||e.inputText||(e.hasOutput?t('emptyOutput'):''),true)}<details class="original-source"><summary>${esc(t('originalRecords'))} · ${e.sourceRecords?.length||0}</summary>${(e.sourceRecords||[]).map((record,n)=>`<p class="source-record-label">${esc(record.type||t('sourceRecord'))}${record.line!=null?` · ${esc(t('line'))} ${record.line}`:''}${record.path?` · ${esc(record.path)}`:''}</p><pre class="code-text">${esc(record.rawText??JSON.stringify(record.record,null,2))}</pre>`).join('')}</details>`;
    $('event-detail').querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>copy($(b.dataset.copy).textContent));
    const f=e.features||{},keys=Array.isArray(f.keys)?f.keys:[];
    $('features-section').hidden=!tool;$('related-section').hidden=!tool;
    $('feature-keys').innerHTML=keys.length?`<div class="feature-keys">${keys.map(k=>`<span class="feature-key">${esc(k)}</span>`).join('')}</div>`:`<p class="small muted" style="margin-top:10px">${esc(t('noFeatureKeys'))}</p>`;
    $('feature-evidence').innerHTML=(f.evidence||[]).map(item=>`<div class="feature-evidence-item"><code>${esc(item.key)}</code><p class="excerpt">${esc(item.excerpt||'')}</p><p class="rule">${esc(item.source||'')} · ${esc(item.rule||'')}</p></div>`).join('');
    const related=tool&&S?S.related(data,runId,eventIndex,{limit:3,excludeSameRun:false}):[];
    $('related-list').innerHTML=related.length?related.map(item=>{const r=run(item.runId),other=r.events[item.eventIndex],callNumber=callsFor(r).findIndex(v=>v.i===item.eventIndex)+1;return `<button class="related-call" data-related-run="${esc(item.runId)}" data-related-index="${item.eventIndex}"><span class="related-call-head"><strong>${esc(other.tool)} · ${esc(r.name||r.id)}</strong><span>${(item.similarity*100).toFixed(0)}% ${esc(t('similarity'))}</span></span><code>${esc(preview(other,140))}</code><small>${esc(t('callLabel',{n:callNumber}))} · ${esc(item.sharedKeys.join(' · '))}</small></button>`;}).join(''):`<p class="small muted" style="margin-top:12px">${esc(t('noRelated'))}</p>`;
    $('related-list').querySelectorAll('[data-related-run]').forEach(b=>b.onclick=()=>selectEvent(b.dataset.relatedRun,+b.dataset.relatedIndex));
  }
  function svgEl(tag,attrs={},text){const el=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([key,value])=>el.setAttribute(key,value));if(text!=null)el.textContent=text;return el;}
  function processData(){
    const k=+$('process-k').value,minSimilarity=+$('process-threshold').value,key=`${k}:${minSimilarity}`;
    if(!graphCache||graphCache.data!==data||graphCache.key!==key)graphCache={data,key,graph:S.processGraph(data,{k,minSimilarity,maxNodes:300})};
    return graphCache.graph;
  }
  function drawProcess(){
    const svg=$('process-map');svg.replaceChildren();processReady=false;
    if(!S){$('process-note').textContent=t('featuresUnavailable');$('export-process-svg').disabled=true;return;}
    const graph=processData(),blocks=$('process-blocks');blocks.replaceChildren();
    $('export-process-svg').disabled=graph.limited||!graph.nodes.length;
    if(graph.limited||!graph.nodes.length){
      svg.setAttribute('viewBox','0 0 650 150');svg.style.width='100%';svg.style.height='150px';
      svg.append(svgEl('text',{x:24,y:65,fill:'#716e65','font-family':'DM Sans, sans-serif','font-size':12},t(graph.limited?'processLimit':'messageOnly',{n:graph.totalNodes})));
      $('process-note').textContent=t(graph.limited?'processLimitDetail':'messageOnly');return;
    }
    const runs=data.runs.filter(r=>graph.nodes.some(n=>n.runId===r.id)),maxCalls=Math.max(...runs.map(r=>callsFor(r).length));
    const w=Math.max(580,Math.min(1600,180+maxCalls*56),$('process-container').clientWidth||0),h=Math.max(240,85+runs.length*122),left=60,right=w-45;
    svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.style.width=w+'px';svg.style.height=h+'px';
    svg.append(svgEl('rect',{x:0,y:0,width:w,height:h,fill:'#fffefa'}));
    const points=new Map(),cuts=new Set(graph.articulationPoints),block=graph.blocks.find(b=>b.id===activeBlock),members=new Set(block?.nodeIds||[]);
    runs.forEach((r,lane)=>{
      const y=78+lane*122,calls=callsFor(r);
      svg.append(svgEl('text',{x:left,y:y-34,fill:r.id===runId?'#8f1d2c':'#716e65','font-family':'DM Sans, sans-serif','font-size':12},`${r.name||r.id} · ${calls.length} ${t('calls')}`));
      svg.append(svgEl('line',{x1:left,y1:y,x2:right,y2:y,stroke:'#dcd8ce','stroke-width':1,'stroke-dasharray':'3 5',class:'order-guide'}));
      calls.forEach(({e,i},position)=>{
        const node=graph.nodes.find(n=>n.runId===r.id&&n.eventIndex===i);
        const x=calls.length===1?(left+right)/2:left+(right-left)*position/(calls.length-1);
        points.set(node.id,{x,y,number:position+1,e});
      });
    });
    graph.edges.forEach(edge=>{
      const a=points.get(edge.source),b=points.get(edge.target),related=edge.source===graph.nodes.find(n=>n.runId===runId&&n.eventIndex===eventIndex)?.id||edge.target===graph.nodes.find(n=>n.runId===runId&&n.eventIndex===eventIndex)?.id;
      const inBlock=members.has(edge.source)&&members.has(edge.target),lift=a.y===b.y?Math.min(48,Math.abs(b.x-a.x)*.17+15):0;
      const d=a.y===b.y?`M ${a.x} ${a.y} Q ${(a.x+b.x)/2} ${a.y-lift*2} ${b.x} ${b.y}`:`M ${a.x} ${a.y} C ${a.x} ${(a.y+b.y)/2}, ${b.x} ${(a.y+b.y)/2}, ${b.x} ${b.y}`;
      const path=svgEl('path',{d,fill:'none',stroke:inBlock?'#8f1d2c':related?'#8f1d2c':'#a89787','stroke-width':related||inBlock?2:1,opacity:activeBlock?(inBlock?.9:.12):related?.8:.3,'data-similarity':edge.similarity});
      path.append(svgEl('title',{},t('edgeOverlap',{n:(edge.similarity*100).toFixed(1)})));svg.append(path);
    });
    graph.nodes.forEach(node=>{
      const p=points.get(node.id),active=node.runId===runId&&node.eventIndex===eventIndex,color=p.e.status==='error'?'#8f1d2c':p.e.status==='ok'?'#3e6354':'#8c887d';
      const group=svgEl('g',{class:'process-node',role:'button',tabindex:0,'data-run':node.runId,'data-event':node.eventIndex,'aria-label':`${run(node.runId).name} · ${t('callLabel',{n:p.number})} · ${p.e.tool}`,opacity:activeBlock&&!members.has(node.id)?.28:1});
      group.append(svgEl('rect',{x:p.x-28,y:p.y-18,width:56,height:53,fill:'transparent',class:'process-hit-area'}));
      if(cuts.has(node.id))group.append(svgEl('circle',{cx:p.x,cy:p.y,r:13,fill:'none',stroke:'#8a6332','stroke-width':1.4,'stroke-dasharray':'2 2',class:'articulation-ring'}));
      group.append(svgEl('circle',{cx:p.x,cy:p.y,r:active?9:6,fill:color,stroke:active?'#fffefa':color,'stroke-width':2}));
      if(active)group.append(svgEl('circle',{cx:p.x,cy:p.y,r:12,fill:'none',stroke:'#8f1d2c','stroke-width':1.5}));
      const category=node.keys.find(key=>key.startsWith('CMD:'))?.slice(4)||p.e.tool.replace(/^.*[.:]/,'').replace('apply_patch','patch');
      group.append(svgEl('text',{x:p.x,y:p.y+26,'text-anchor':'middle',fill:'#716e65','font-family':'Consolas, monospace','font-size':10},`${String(p.number).padStart(2,'0')} ${category.slice(0,16)}`));
      group.append(svgEl('title',{},`${p.e.tool}\n${preview(p.e,180)}\n${statusName(p.e)}${cuts.has(node.id)?'\n'+t('connectionPoint'):''}`));
      const choose=()=>selectEvent(node.runId,node.eventIndex);group.onclick=choose;group.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};svg.append(group);
    });
    svg.append(svgEl('text',{x:left,y:h-17,fill:'#716e65','font-family':'DM Sans, sans-serif','font-size':10},t('processAxis')));
    $('process-note').textContent=t('processCount',{nodes:graph.nodes.length,edges:graph.edges.length,cuts:cuts.size});
    const intro=document.createElement('p');intro.className='small muted';intro.textContent=t('blocksExplanation');blocks.append(intro);
    const blockList=document.createElement('div');blockList.className='block-list';
    graph.blocks.forEach((b,i)=>{
      const button=document.createElement('button');button.className='text-link'+(b.id===activeBlock?' active':'');button.textContent=t(b.trivial?'bridgeBlock':'blockLabel',{n:i+1,calls:b.size,runs:b.runIds.length});button.setAttribute('aria-pressed',b.id===activeBlock);button.onclick=()=>{activeBlock=activeBlock===b.id?null:b.id;drawProcess();};blockList.append(button);
    });
    if(!graph.blocks.length)blockList.textContent=t('noBlocks');blocks.append(blockList);
    if(cuts.size){const label=document.createElement('p');label.className='small muted';label.textContent=t('connectionPoints');blocks.append(label);graph.nodes.filter(n=>cuts.has(n.id)).forEach(node=>{const b=document.createElement('button');b.className='text-link cut-link';b.textContent=`${run(node.runId).name} · ${t('callLabel',{n:points.get(node.id).number})}`;b.onclick=()=>selectEvent(node.runId,node.eventIndex);blocks.append(b);});}
    processReady=true;
  }
  function drawMap(){
    const svg=$('action-map');svg.replaceChildren();mapReady=false;
    const usedIds=[runId,...(compareId?[compareId]:[])],nodes=new Map(),edges=new Map(),refs=new Map();
    usedIds.forEach(id=>{let prev=null;callsFor(run(id)).forEach(({e,i},position)=>{if(!nodes.has(e.actionKey))nodes.set(e.actionKey,{key:e.actionKey,label:e.tool,preview:preview(e,45),refs:[]});nodes.get(e.actionKey).refs.push({runId:id,eventIndex:i,position});if(prev!=null){const pair=JSON.stringify([prev,e.actionKey]);if(!edges.has(pair))edges.set(pair,{source:prev,target:e.actionKey,count:0});edges.get(pair).count++;}prev=e.actionKey;});});
    $('export-svg').disabled=nodes.size>80||!nodes.size;
    if(nodes.size>80||!nodes.size){$('map-note').textContent=t(nodes.size>80?'mapLimit':'messageOnly');svg.setAttribute('viewBox','0 0 600 260');return;}
    const w=Math.max($('map-container').clientWidth,400),cols=w<520?2:3,nw=(w-60-(cols-1)*25)/cols,h=Math.max(300,Math.ceil(nodes.size/cols)*105+45),positions=new Map();svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.style.height=Math.min(h,650)+'px';
    const bg=svgEl('rect',{x:0,y:0,width:w,height:h,fill:'#fffdf8'});svg.append(bg);
    const defs=svgEl('defs'),marker=svgEl('marker',{id:'map-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(svgEl('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#b09898'}));defs.append(marker);svg.append(defs);
    [...nodes.values()].forEach((n,i)=>positions.set(n.key,{x:30+(i%cols)*(nw+25)+nw/2,y:45+Math.floor(i/cols)*105}));
    edges.forEach(edge=>{const a=positions.get(edge.source),b=positions.get(edge.target),d=edge.source===edge.target?`M ${a.x+20} ${a.y-22} C ${a.x+65} ${a.y-75}, ${a.x-65} ${a.y-75}, ${a.x-20} ${a.y-22}`:`M ${a.x} ${a.y+25} C ${a.x} ${a.y+58}, ${b.x} ${b.y-60}, ${b.x} ${b.y-25}`;const p=svgEl('path',{d,fill:'none',stroke:'#b9a3a3','stroke-width':1.2,opacity:.7,'marker-end':'url(#map-arrow)'});p.append(svgEl('title',{},`${edge.count} recorded call-order transitions`));svg.append(p);});
    nodes.forEach(n=>{const p=positions.get(n.key),active=n.key===selected()?.actionKey,g=svgEl('g',{class:'map-node',role:'button',tabindex:0,'aria-label':n.label+' '+n.preview,transform:`translate(${p.x},${p.y})`});g.append(svgEl('rect',{x:-nw/2,y:-25,width:nw,height:52,rx:3,fill:active?'#f1e7e7':'#f7f5f0',stroke:active?'#7c2d3a':'#dcd8ce','stroke-width':active?2:1}));g.append(svgEl('text',{x:0,y:-6,'text-anchor':'middle',fill:'#7c2d3a','font-family':'DM Sans, sans-serif','font-size':11},n.label));g.append(svgEl('text',{x:0,y:12,'text-anchor':'middle',fill:'#716e65','font-family':'Consolas, monospace','font-size':9},n.preview.length>28?n.preview.slice(0,27)+'…':n.preview));const choose=()=>{const ref=n.refs.find(r=>r.runId===runId)||n.refs[0];selectEvent(ref.runId,ref.eventIndex);};g.onclick=choose;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};svg.append(g);});
    $('map-note').textContent=t('mapCount',{nodes:nodes.size,edges:edges.size});mapReady=true;
  }
  async function readFiles(fileList){const files=[...fileList];if(files.some(f=>f.size>10*1024*1024)||files.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw new Error(t('fileLimit'));pendingFiles=await Promise.all(files.map(async f=>({name:f.name,text:await f.text()})));$('file-label').textContent=t('fileChosen',{n:pendingFiles.length});$('paste-input').value='';}
  function importError(error){$('import-error').textContent=error.message||String(error);$('import-error').hidden=false;}
  function openMethod(){$('method-content').innerHTML=t('methodsHtml');$('method-dialog').showModal();}
  $('language-button').onclick=()=>I.set(I.get()==='en'?'zh':'en');document.addEventListener('lens-language',render);
  $('run-select').onchange=e=>selectRun(e.target.value);$('compare-select').onchange=e=>{compareId=e.target.value||null;render();};
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;renderTimeline();});$('show-messages').onchange=renderTimeline;
  $('timeline-view').onclick=()=>{view='timeline';renderTimeline();};$('map-view').onclick=()=>{view='map';renderTimeline();drawMap();};$('process-view').onclick=()=>{view='process';renderTimeline();drawProcess();};
  ['process-k','process-threshold'].forEach(id=>$(id).onchange=()=>{activeBlock=null;drawProcess();});
  $('import-open').onclick=()=>{$('import-error').hidden=true;$('import-dialog').showModal();};
  $('method-open').onclick=openMethod;$('method-footer').onclick=openMethod;$('feature-help').onclick=openMethod;
  $('export-open').onclick=()=>{$('export-dialog').showModal();};
  document.querySelectorAll('.close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}));
  $('file-input').onchange=async e=>{if(e.target.files.length)try{await readFiles(e.target.files);}catch(error){importError(error);}};
  const drop=$('drop-zone');drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging');};drop.ondragleave=()=>drop.classList.remove('dragging');drop.ondrop=async e=>{e.preventDefault();drop.classList.remove('dragging');try{if(e.dataTransfer.files.length)await readFiles(e.dataTransfer.files);}catch(error){importError(error);}};
  $('paste-input').oninput=()=>{if($('paste-input').value.trim()){pendingFiles=[];$('file-input').value='';$('file-label').textContent=t('chooseFiles');}};
  $('import-confirm').onclick=()=>{try{const pasted=$('paste-input').value;const files=pendingFiles.length?pendingFiles:pasted.trim()?[{name:'pasted-log.json',text:pasted}]:[];if(!files.length)throw new Error(t('chooseOrPaste'));const parsed=L.importFiles(files);load(parsed,false);$('import-dialog').close();pendingFiles=[];$('file-input').value='';$('paste-input').value='';toast(t('loaded',{runs:data.runs.length,calls:analysis.totals.calls}));}catch(error){importError(error);}};
  $('reset-demo').onclick=()=>load(L.parse(JSON.stringify(window.TL_DEMO),'synthetic-openai.json'),true);
  $('download-demo').onclick=()=>{download('trajectory-lens-raw-example.json',JSON.stringify(window.TL_DEMO,null,2),'application/json');toast(t('exampleSaved'));};
  function exportReport(){
    let report=L.exportMarkdown(data);
    if(compareId){
      const a=run(),b=run(compareId),result=L.compare(a,b);
      report+=`\n\n## Selected call-sequence comparison\n\nRuns: ${a.name||a.id} / ${b.name||b.id}\n\n- Exact common prefix: ${result.commonPrefix} calls\n- Exact invocation-set overlap: ${result.sharedActions}/${result.totalActions} (${(result.jaccard*100).toFixed(1)}%)\n`;
      if(result.firstDifference){for(const [r,index] of [[a,result.firstDifference.aIndex],[b,result.firstDifference.bIndex]]){const e=index==null?null:r.events.find(e=>e.index===index)||r.events[index];report+=`\n### First differing call in ${r.name||r.id}\n\n${e?`${e.tool} · original event index ${index}\n\n`+e.inputText.split('\n').map(line=>'    '+line).join('\n'):'Run ended before a corresponding call.'}\n`;}}
      else report+='\nBoth runs have the same ordered invocations. Outputs and messages may differ.\n';
    }
    if(S){const graph=processData();report+=`\n\n## Observable TraceGraph process graph\n\nCorpus: all ${graph.totalNodes} imported calls.\n\n`+(graph.limited?'Graph disabled above 300 calls; no sampling.\n':`- Reciprocal neighbors k: ${graph.k}\n- Minimum IDF-weighted overlap: ${graph.minSimilarity}\n- Undirected similarity edges: ${graph.edges.length}\n- Biconnected blocks (including two-node bridges): ${graph.blocks.length}\n- Articulation points: ${graph.articulationPoints.length}\n\nBlocks and points describe the filtered similarity graph. They do not establish reward, failure basins or causal effects. Display coordinates show relative invocation order.\n`);}
    if(isDemo)report+='\n\n## Example provenance\n\nSynthetic teaching logs. The commands, outputs, and errors are hand-constructed, not experimental measurements.\n';
    return report;
  }
  $('export-report').onclick=()=>{download('trajectory-lens-report.md',exportReport(),'text/markdown;charset=utf-8');$('export-dialog').close();toast(t('reportSaved'));};
  $('export-json').onclick=()=>{download('trajectory-lens-raw.json',L.exportJSON(data),'application/json');$('export-dialog').close();toast(t('jsonSaved'));};
  $('export-svg').onclick=()=>{if(!mapReady){toast(t('mapUnavailable'));return;}const svg=$('action-map').cloneNode(true);svg.setAttribute('xmlns',NS);download('trajectory-lens-actions.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml');$('export-dialog').close();toast(t('svgSaved'));};
  $('export-process-svg').onclick=()=>{drawProcess();if(!processReady){toast(t('processUnavailable'));return;}const svg=$('process-map').cloneNode(true);svg.setAttribute('xmlns',NS);download('trajectory-lens-process.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml');$('export-dialog').close();toast(t('processSvgSaved'));};
  document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]')||['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(e.target.tagName)||e.target.getAttribute('role')==='button')return;const calls=callsFor(run()),pos=calls.findIndex(v=>v.i===eventIndex);if(e.key==='ArrowDown'&&calls[pos+1]){e.preventDefault();selectEvent(runId,calls[pos+1].i);}if(e.key==='ArrowUp'&&pos>0){e.preventDefault();selectEvent(runId,calls[pos-1].i);}});
  let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(data){drawMap();if(view==='process')drawProcess();}},150);});
  I.apply();try{if(!L)throw new Error(t('loadFailed'));load(L.parse(JSON.stringify(window.TL_DEMO),'synthetic-openai.json'),true);}catch(error){$('dataset-name').textContent=t('loadFailed');console.error(error);}
  window.TL_App={getData:()=>data,getAnalysis:()=>analysis,load:input=>load(typeof input==='string'?L.parse(input,'import.json'):input,false),selectRun,selectEvent,setLanguage:I.set,getState:()=>({runId,compareId,eventIndex,filter,view,language:I.get()})};
})();
