(() => {
 'use strict';
 const $=id=>document.getElementById(id), E=window.LensEngine, I=window.LensI18n, T=(key,values)=>I.t(key,values);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>Number(n).toLocaleString('en-US');
 let data, analysis, current, compare, stepIndex=0, selectedNode=null, playTimer=null, caseIndex=0, familyIndex=0, pendingFile=null, isDemo=true, importErrorMessage=null, kernelSelection=null;
 const demoRuns={'先试再修':'demoRunA','先查再改':'demoRunB','重复后停止':'demoRunC'};
 const demoLabels={'读取问题':'demoRead','定位函数':'demoLocate','复现错误':'demoReproduce','初版修改':'demoPatchA','测试未通过':'demoTestFail','检查边界':'demoInspectEdge','修正边界':'demoPatchB','验证通过':'demoTestPass','提交结果':'demoSubmit','预算结束':'demoStop'};
 const runName=id=>isDemo&&demoRuns[id]?T(demoRuns[id]):id;
 const stateLabel=value=>isDemo&&demoLabels[value.label]?T(demoLabels[value.label]):value.label;
 const modeName=mode=>T({explicit:'modeExplicit',keys:'modeKeys',action:'modeAction',text:'modeText'}[mode]);
 const NS='http://www.w3.org/2000/svg';
 function svgEl(tag,attrs={},text){const e=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));if(text!=null)e.textContent=text;return e;}
 function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,3500);}
 function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function downloadExample(){download('trajectory-lens-example.json',JSON.stringify(window.LENS_DEMO,null,2),'application/json');}
 function stop(){clearInterval(playTimer);playTimer=null;$('play-button').textContent=T('play');}
 function updateExportState(){const limited=analysis.nodes.length>100;$('export-svg').disabled=limited;$('export-svg').setAttribute('aria-disabled',String(limited));$('svg-export-note').hidden=!limited;}
 function setLanguage(language){I.setLanguage(language);if(pendingFile)$('drop-title').textContent=pendingFile.name;if(importErrorMessage)$('import-error').textContent=T('importError',{message:importErrorMessage});if(data){render();if(!$('released-view').hidden)renderReleased();}$('play-button').textContent=T(playTimer?'pause':'play');}
 function load(raw,demo=false){const next=raw?.__lensNormalized?raw:E.normalize(raw),nextAnalysis=E.analyze(next);stop();data=next;analysis=nextAnalysis;current=data.runs[0].id;compare=data.runs.length>1?data.runs[1].id:null;stepIndex=0;selectedNode=null;isDemo=demo;$('evidence-details').open=false;setView('workspace');render();}
 function currentRun(){return data.runs.find(r=>r.id===current);}
 function metric(id){return analysis.perRun.find(r=>r.id===id);}
 function path(id){return analysis.runPaths[id]||[];}
 function nodeIdAt(runId,index){return path(runId)[index];}
 function setView(view){stop();$('workspace-view').hidden=view!=='workspace';$('released-view').hidden=view!=='released';document.querySelectorAll('[data-view]').forEach(b=>{const active=b.dataset.view===view;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);});if(view==='released')renderReleased();else if(data)requestAnimationFrame(drawAtlas);}
 function render(){
  $('dataset-title').textContent=isDemo?T('demoName'):data.name;$('dataset-description').textContent=isDemo?T('demoDescription'):(data.description||T('fallbackDescription'));
  $('data-kind').textContent=T(isDemo?'demoKind':'importedKind');$('data-kind').classList.toggle('real',!isDemo);
  $('run-count').textContent=String(data.runs.length).padStart(2,'0');
  $('run-list').innerHTML=data.runs.map(r=>`<div class="run-card ${r.id===current?'current':r.id===compare?'compare':''}"><button class="run-select" data-run="${esc(r.id)}" aria-pressed="${r.id===current}"><span class="run-label">${esc(runName(r.id))}<span class="outcome ${esc(r.outcome)}">${T(r.outcome)}</span></span><span class="run-model">${esc(r.model)}</span></button><div class="run-card-bottom"><span>${T('runStats',{steps:r.steps.length,revisits:metric(r.id).revisits})}</span>${r.id!==current?`<button class="compare-button" data-compare="${esc(r.id)}" aria-pressed="${r.id===compare}">${T(r.id===compare?'cancelCompare':'compare')}</button>`:`<span>${T('currentRoute')}</span>`}</div></div>`).join('');
  document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>{stop();if(b.dataset.run===compare)compare=current;current=b.dataset.run;stepIndex=0;selectedNode=null;render();});
  document.querySelectorAll('[data-compare]').forEach(b=>b.onclick=()=>{compare=compare===b.dataset.compare?null:b.dataset.compare;render();});
  const counts=data.matching?.counts||{};
  const modeText=Object.entries(counts).filter(([,v])=>typeof v==='number'&&v>0).map(([k,v])=>T('modeCount',{mode:modeName(k),n:v})).join(' · ');
  const notes=[];if(counts.text)notes.push(T('textWarning',{n:counts.text}));if(counts.action)notes.push(T('actionWarning',{n:counts.action}));if(data.matching.modes.length>1)notes.push(T('mixedWarning'));if(!analysis.totals.tokensComplete)notes.push(T('tokenWarning',{known:analysis.totals.knownTokenSteps,total:analysis.totals.steps}));
  $('matching-note').innerHTML=`<strong>${T('matchingHeading')}</strong>${esc(modeText||T('matchingFallback'))}<div>${T('revisitNote')}</div>${notes.length?`<div class="warning-note">${esc(notes.join(' '))}</div>`:''}`;
  $('atlas-stat').innerHTML=T('atlasStats',{states:analysis.nodes.length,edges:analysis.edges.length});updateExportState();
  renderComparison();renderReplay();drawAtlas();renderEvidence();
 }
 function renderComparison(){
  const m=metric(current),n=compare?metric(compare):null;
  if(!compare){$('comparison').innerHTML='<span>'+T('singleRunLine',{steps:m.steps,states:m.uniqueStates,revisits:m.revisits})+'</span>';return;}
  const o=analysis.overlaps.find(o=>(o.a===current&&o.b===compare)||(o.b===current&&o.a===compare)),d=E.firstDivergence(data,current,compare);
  $('comparison').innerHTML='<span class="comparison-runs">'+esc(runName(current))+' / '+esc(runName(compare))+'</span><span>'+T(d.identical?'comparisonIdentical':'comparisonLine',{overlap:(100*o.jaccard).toFixed(0),step:d.index+1,a:m.revisits,b:n.revisits})+'</span>';
 }
 function layout(nodes,width,height){
  const columns=width<480?3:width<650?4:5, groups=Array.from({length:columns},()=>[]);
  nodes.forEach(n=>groups[Math.max(0,Math.min(columns-1,Math.round(n.progress*(columns-1))))].push(n));
  const biggest=Math.max(...groups.map(g=>g.length),1), h=Math.max(height,biggest*77+65),margin=64;
  const positions=new Map();groups.forEach((g,col)=>{g.sort((a,b)=>b.runIds.length-a.runIds.length||a.label.localeCompare(b.label));g.forEach((n,i)=>positions.set(n.id,{x:margin+col*(width-2*margin)/(columns-1),y:h/2+(i-(g.length-1)/2)*77}));});
  return {positions,height:h,nodeWidth:Math.min(110,(width-2*margin)/(columns-1)-14)};
 }
 function fitLabel(value,width,fontSize,family='Segoe UI, Microsoft YaHei, sans-serif'){const canvas=fitLabel.canvas||(fitLabel.canvas=document.createElement('canvas')),context=canvas.getContext('2d'),chars=Array.from(value);context.font=fontSize+'px '+family;if(context.measureText(value).width<=width)return value;while(chars.length&&context.measureText(chars.join('')+'…').width>width)chars.pop();return chars.join('')+'…';}
 function edgePath(a,b,source,target,width=106,bounds){
  const x=value=>bounds?Math.max(6,Math.min(bounds-6,value)):value;
  if(source===target)return `M ${x(a.x+width/3)} ${a.y-12} C ${x(a.x+width/2+35)} ${a.y-67}, ${x(a.x-width/2-35)} ${a.y-67}, ${x(a.x-width/3)} ${a.y-12}`;
  const dx=b.x-a.x,offset=width/2+3;
  if(Math.abs(dx)<30)return `M ${x(a.x+offset-8)} ${a.y} C ${x(a.x+offset+42)} ${a.y}, ${x(b.x+offset+42)} ${b.y}, ${x(b.x+offset-8)} ${b.y}`;
  const sx=a.x+(dx>0?offset:-offset),tx=b.x+(dx>0?-offset:offset), bend=Math.max(35,Math.abs(tx-sx)/2);
  if(dx<0)return `M ${x(sx)} ${a.y-12} C ${x(sx-35)} ${a.y-68}, ${x(tx+35)} ${b.y-68}, ${x(tx)} ${b.y-12}`;
  return `M ${x(sx)} ${a.y} C ${x(sx+bend)} ${a.y}, ${x(tx-bend)} ${b.y}, ${x(tx)} ${b.y}`;
 }
 function defs(svg){const d=svgEl('defs');[['teal','#8f1d2c'],['violet','#52657f'],['shared','#383833'],['dim','#b6b0a5']].forEach(([id,color])=>{const m=svgEl('marker',{id:'arrow-'+id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});m.append(svgEl('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:color}));d.append(m);});svg.append(d);}
 function drawAtlas(){
  if(!data||$('workspace-view').hidden)return;
  const svg=$('atlas'),width=$('graph-wrap').clientWidth||700;
  svg.replaceChildren();defs(svg);
  const nodes=analysis.nodes;
  if(nodes.length>100){$('graph-empty').hidden=false;$('graph-empty').textContent=T('graphLimit',{n:nodes.length});$('graph-wrap').style.height='335px';svg.setAttribute('viewBox',`0 0 ${width} 335`);return;}
  $('graph-empty').hidden=true;
  const l=layout(nodes,width,335);$('graph-wrap').style.height=l.height+'px';svg.setAttribute('viewBox',`0 0 ${width} ${l.height}`);
  svg.append(svgEl('title',{},T('graphTitle',{n:nodes.length,edges:analysis.edges.length,run:runName(current)})));
  const cur=new Set(path(current)),cmp=new Set(compare?path(compare):[]),activeId=selectedNode||nodeIdAt(current,stepIndex);
  const edgeGroup=svgEl('g');
  const routeEdges=id=>new Set((path(id)||[]).slice(1).map((x,i)=>path(id)[i]+'\u0000'+x));
  const currentEdges=routeEdges(current),compareEdges=compare?routeEdges(compare):new Set();
  analysis.edges.slice().sort((a,b)=>Number(currentEdges.has(a.source+'\u0000'+a.target))-Number(currentEdges.has(b.source+'\u0000'+b.target))).forEach(e=>{
   const key=e.source+'\u0000'+e.target,ca=currentEdges.has(key),cb=compareEdges.has(key),kind=ca&&cb?'shared':ca?'teal':cb?'violet':'dim',a=l.positions.get(e.source),b=l.positions.get(e.target);if(!a||!b)return;
   const p=svgEl('path',{d:edgePath(a,b,e.source,e.target,l.nodeWidth,width),fill:'none',stroke:{teal:'#8f1d2c',violet:'#52657f',shared:'#383833',dim:'#b6b0a5'}[kind],'stroke-width':ca||cb?2.2:1.2,opacity:ca||cb?.87:.42,'marker-end':'url(#arrow-'+kind+')'});
   p.append(svgEl('title',{},T('edgeTitle',{a:stateLabel(nodes.find(n=>n.id===e.source)),b:stateLabel(nodes.find(n=>n.id===e.target)),n:e.count})));edgeGroup.append(p);
  });svg.append(edgeGroup);
  nodes.forEach(n=>{const p=l.positions.get(n.id),a=cur.has(n.id),b=cmp.has(n.id),color=a&&b?'#383833':a?'#8f1d2c':b?'#52657f':'#918a7d',fill=a&&b?'#eeece5':a?'#f5e9e9':b?'#eaf0f5':'#f5f3ed',g=svgEl('g',{class:'graph-node',role:'button',tabindex:0,'aria-label':T('nodeAria',{label:stateLabel(n),visits:n.visits,runs:n.runIds.length}),transform:`translate(${p.x},${p.y})`});
   if(n.id===activeId)g.append(svgEl('rect',{x:-l.nodeWidth/2-4,y:-27,width:l.nodeWidth+8,height:54,rx:1,fill:'none',stroke:color,'stroke-width':1,opacity:.55}));
   g.append(svgEl('rect',{x:-l.nodeWidth/2,y:-23,width:l.nodeWidth,height:46,rx:1,fill,stroke:color,'stroke-width':n.id===activeId?2:1}));
   const fullLabel=stateLabel(n),label=fitLabel(fullLabel,l.nodeWidth-12,width<420?11:12);
   g.append(svgEl('text',{'text-anchor':'middle',y:-3,fill:a||b?'#191918':'#6b675f','font-family':'Segoe UI, Microsoft YaHei, sans-serif','font-size':width<420?11:12},label));
   g.append(svgEl('text',{'text-anchor':'middle',y:13,fill:color,'font-family':'Consolas, monospace','font-size':10},fitLabel(T('nodeMeta',{runs:n.runIds.length,visits:n.visits}),l.nodeWidth-10,10,'Consolas, monospace')));
   g.append(svgEl('title',{},T('nodeAria',{label:stateLabel(n),visits:n.visits,runs:n.runIds.length})));
   const choose=()=>{stop();$('evidence-details').open=true;selectedNode=n.id;const i=path(current).indexOf(n.id);if(i>=0)stepIndex=i;drawAtlas();renderReplay();renderEvidence();};g.onclick=choose;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};svg.append(g);
  });
  svg.append(svgEl('text',{x:18,y:l.height-15,fill:'#6b675f','font-family':'Consolas, monospace','font-size':10},T('early')));
  svg.append(svgEl('text',{x:width-18,y:l.height-15,'text-anchor':'end',fill:'#6b675f','font-family':'Consolas, monospace','font-size':10},T('lateProgress')));
 }
 function renderReplay(){
  const run=currentRun(),m=metric(current);stepIndex=Math.min(Math.max(stepIndex,0),run.steps.length-1);
  $('replay-name').textContent=runName(run.id);$('step-count').textContent=`${stepIndex+1} / ${run.steps.length}`;$('step-slider').max=run.steps.length-1;$('step-slider').value=stepIndex;
  $('prev-step').disabled=stepIndex===0;$('next-step').disabled=stepIndex===run.steps.length-1;
  const seen=new Set();$('step-track').innerHTML=run.steps.map((s,i)=>{const revisit=seen.has(s.state);seen.add(s.state);return `<button class="step-cell ${revisit?'revisit':''} ${i===stepIndex?'active':''}" data-step="${i}" aria-pressed="${i===stepIndex}"><span class="step-number">${String(i+1).padStart(2,'0')}${revisit?T('revisitMarker'):''}</span>${esc(stateLabel(s))}</button>`;}).join('');
  $('step-track').querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{stop();selectStep(+b.dataset.step);});
  $('run-metrics').innerHTML=`<span><b>${m.steps}</b>${T('stepsMetric')}</span><span><b>${m.uniqueStates}</b>${T('statesMetric')}</span><span><b>${(100*m.revisitRate).toFixed(0)}%</b>${T('revisitRate')}</span><span><b>${m.totalTokens==null?'—':fmt(m.totalTokens)}</b>tokens ${m.totalTokens!=null&&!m.tokensComplete?T('partialTokens'):m.totalTokens==null?T('missingTokens'):''}</span><span class="explain">${T(isDemo?'demoCosts':'importedCosts')}</span>`;
 }
 function selectStep(i){$('evidence-details').open=true;stepIndex=Math.max(0,Math.min(i,currentRun().steps.length-1));selectedNode=null;renderReplay();drawAtlas();renderEvidence();const cell=$('step-track').querySelector('.active');if(cell){const track=$('step-track');if(cell.offsetLeft<track.scrollLeft||cell.offsetLeft+cell.offsetWidth>track.scrollLeft+track.clientWidth)track.scrollTo({left:cell.offsetLeft-track.offsetLeft-15,behavior:'smooth'});}}
 function renderEvidence(){
  const id=selectedNode||nodeIdAt(current,stepIndex),node=analysis.nodes.find(n=>n.id===id);if(!node)return;
  const found=[];data.runs.forEach(r=>path(r.id).forEach((n,i)=>{if(n===id)found.push({r,i,s:r.steps[i]});}));
  const entry=found.find(v=>v.r.id===current&&v.i===stepIndex)||found[0];
  $('evidence-index').textContent=T('records',{n:found.length});
  const cleanState=entry.s.state.replace(/^explicit:(string|number):/,'').replace(/^(keys|text|action):/,'');
  $('evidence-content').innerHTML=`<h3 class="evidence-title">${esc(stateLabel(node))}</h3><div class="state-chip">${esc(cleanState.length>140?cleanState.slice(0,140)+'…':cleanState)}</div><p class="evidence-sub">${T('evidenceStep',{run:esc(runName(entry.r.id)),step:entry.i+1})}${entry.s.tokens!=null?` · ${fmt(entry.s.tokens)} tokens`:''}</p><p class="raw-label">${T('originalRecord')}</p><div class="raw-text">${esc(entry.s.text||T('missingText'))}</div><div class="occurrences"><p class="small muted">${T('occurrences')}</p>${found.slice(0,60).map(v=>`<button data-occ-run="${esc(v.r.id)}" data-occ-step="${v.i}" class="${v.r.id===entry.r.id&&v.i===entry.i?'active':''}">${esc(runName(v.r.id))} · ${v.i+1}</button>`).join('')}${found.length>60?`<p class="small muted">${T('occurrenceLimit',{n:found.length})}</p>`:''}</div>`;
  document.querySelectorAll('[data-occ-run]').forEach(b=>b.onclick=()=>{stop();if(b.dataset.occRun!==current){compare=current;current=b.dataset.occRun;}stepIndex=+b.dataset.occStep;selectedNode=null;render();});
 }
 function shortState(s){if(s==='EOS_correct')return [T('eosCorrect'),T('terminalCorrect')];if(s==='EOS_wrong')return [T('eosWrong'),T('terminalWrong')];const [role,phase,core]=s.split('|');return [role.replaceAll('_',' '),`${phase} · ${core}`];}
 function renderReleased(){
  const rel=window.LENS_RELEASED;if(!rel){toast(T('missingRelease'));return;}
  const c=rel.cases[caseIndex],f=c.families[familyIndex],N=c.all_states.length;
  $('case-select').innerHTML=rel.cases.map((c,i)=>`<option value="${i}" ${i===caseIndex?'selected':''}>${esc(c.problem_id)} · ${esc(c.model)}</option>`).join('');
  $('family-select').innerHTML=c.families.map((f,i)=>`<option value="${i}" ${i===familyIndex?'selected':''}>${T('familyOption',{id:f.family_id,n:f.size})}</option>`).join('');
  $('threshold-value').textContent=(+$('threshold').value).toFixed(2);
  const covered=c.families.reduce((n,f)=>n+f.size,0);
  $('release-counts').innerHTML=T('fullCase',{correct:c.n_correct_runs,wrong:c.n_wrong_runs})+'<br>'+T('familyCoverage',{covered,correct:c.n_correct_runs});
  $('family-summary').innerHTML=`<div class="family-big">${T('familyLabel',{id:f.family_id})}</div><p class="family-caption">${T('familyCorrectRuns',{n:f.size})}<br>${T('visitedStates',{n:f.visits.filter(v=>v>0).length})}</p>`;
  const max=Math.max(...f.visits,1);$('visits-chart').innerHTML=f.visits.map((v,i)=>({v,s:c.all_states[i]})).filter(v=>v.v>0).sort((a,b)=>b.v-a.v).map(v=>`<div class="visit-row"><span>${esc(shortState(v.s).join(' / '))}</span><div class="bar"><span style="width:${v.v/max*100}%"></span></div><span>${v.v}</span></div>`).join('');
  $('release-note').textContent=T('releaseVisits',{members:f.members.join(', ')});
  $('tv-summary').innerHTML=`<div class="tv-card"><span>${T('meanTV')}</span><strong>${c.mean_tv.toFixed(3)}</strong><p class="small muted">${T('tvNote')}</p>${c.families.map((g,i)=>i===familyIndex?'':`<div class="small">${T('familyLabel',{id:f.family_id})} × ${g.family_id}: ${c.pairwise_tv_matrix[familyIndex][i].toFixed(3)}</div>`).join('')}</div>`;
  $('provenance').innerHTML=`<p>${T('provenance')} <code>${esc(rel.provenance.commit)}</code></p><p>${rel.provenance.files.map(p=>`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join('')}</p>`;
  $('matrix').innerHTML=`<table class="matrix-table"><caption class="sr-only">${T('matrixCaption',{id:f.family_id})}</caption><thead><tr><th>${T('matrixAxes')}</th>${c.all_states.map(s=>`<th scope="col">${esc(s.replaceAll('|',' / '))}</th>`).join('')}</tr></thead><tbody>${f.kernel.map((row,i)=>`<tr class="${f.visits[i]===0?'zero-row':''}"><th scope="row">${esc(c.all_states[i].replaceAll('|',' / '))}</th>${row.map((v,j)=>`<td><button data-matrix-i="${i}" data-matrix-j="${j}" style="background:rgba(143,29,44,${.025+v*.23})" aria-label="${T('matrixAria',{a:esc(c.all_states[i]),b:esc(c.all_states[j]),p:v.toFixed(4)})}">${v.toFixed(2)}</button></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('[data-matrix-i]').forEach(b=>b.onclick=()=>{kernelDetail(+b.dataset.matrixI,+b.dataset.matrixJ);$('kernel-detail').scrollIntoView({behavior:'smooth',block:'nearest'});});
  if(kernelSelection)kernelDetail(...kernelSelection);else $('kernel-detail').textContent=T('selectKernel');drawKernel();
 }
 function kernelDetail(i,j){kernelSelection=[i,j];const c=window.LENS_RELEASED.cases[caseIndex],f=c.families[familyIndex],eos=c.all_states[i].startsWith('EOS'),base=.5/(f.visits[i]+.5*c.all_states.length);$('kernel-detail').innerHTML=j==null?`<strong>${esc(c.all_states[i])}</strong> · ${T('visitsCount',{n:f.visits[i]})} · ${eos?T('forcedSelfLoop'):f.visits[i]===0?T('unvisitedSmoothing'):T('smoothingBaseline',{p:base.toFixed(4)})}`:`<strong>${esc(c.all_states[i])}</strong> → <strong>${esc(c.all_states[j])}</strong> · P = ${f.kernel[i][j].toFixed(4)} · ${eos?T('forcedRow'):T('sourceVisits',{n:f.visits[i]})+' · '+T('smoothingBaseline',{p:base.toFixed(4)})}${!eos&&f.kernel[i][j]<=base+.0001?' · '+T('smoothingOnly'):''}`;}
 function drawKernel(){
  if($('released-view').hidden||!window.LENS_RELEASED)return;
  const c=window.LENS_RELEASED.cases[caseIndex],f=c.families[familyIndex],svg=$('kernel-graph'),w=svg.parentElement.clientWidth||800;
  const active=c.all_states.map((s,i)=>({s,i,visits:f.visits[i]})).filter(v=>v.visits>0),groups=[[],[],[],[]];
  active.forEach(v=>{const g=v.s.startsWith('EOS')?3:v.s.includes('|early|')?0:v.s.includes('|mid|')?1:2;groups[g].push(v);});
  const h=Math.max(210,Math.max(...groups.map(g=>g.length),1)*82+70);
  svg.parentElement.style.height=h+'px';svg.replaceChildren();defs(svg);svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.append(svgEl('title',{},T('kernelTitle',{problem:c.problem_id,id:f.family_id})));
  const points=new Map(),nw=Math.min(126,(w-30)/4-12),margin=nw/2+15;
  groups.forEach((g,k)=>g.forEach((v,i)=>points.set(v.i,{x:margin+k*(w-2*margin)/3,y:h/2+(i-(g.length-1)/2)*82})));
  const thresh=+$('threshold').value;
  f.kernel.forEach((row,i)=>{if(!points.has(i)||c.all_states[i].startsWith('EOS'))return;const base=.5/(f.visits[i]+.5*c.all_states.length);row.forEach((p,j)=>{if(!points.has(j)||p<thresh||p<=base+.0001)return;const pathEl=svgEl('path',{d:edgePath(points.get(i),points.get(j),i,j,nw,w),fill:'none',stroke:'#8f1d2c','stroke-width':1.1+p*5,opacity:.45+p*.45,'marker-end':'url(#arrow-teal)'});pathEl.append(svgEl('title',{},`${c.all_states[i]} → ${c.all_states[j]}: P=${p.toFixed(4)}`));svg.append(pathEl);});});
  active.forEach(v=>{const pos=points.get(v.i),[a,b]=shortState(v.s),g=svgEl('g',{class:'graph-node',role:'button',tabindex:0,transform:`translate(${pos.x},${pos.y})`,'aria-label':v.s+', '+T('visitsCount',{n:v.visits})}),core=v.s.includes('|core'),eos=v.s.startsWith('EOS'),color=core?'#52657f':eos?'#383833':'#8f1d2c';
   g.append(svgEl('rect',{x:-nw/2,y:-30,width:nw,height:60,rx:1,fill:core?'#eaf0f5':'#f5f2eb',stroke:color}));
   let lines=a.length>17?a.split(' '):[a];if(w<500&&a.includes(' '))lines=a.split(' ');
   lines.slice(0,2).forEach((s,i)=>g.append(svgEl('text',{'text-anchor':'middle',y:lines.length>1?-12+i*13:-7,fill:'#191918','font-family':'Consolas, monospace','font-size':w<500?10:12},fitLabel(s,nw-10,w<500?10:12,'Consolas, monospace'))));
   g.append(svgEl('text',{'text-anchor':'middle',y:14,fill:color,'font-family':'Consolas, monospace','font-size':w<500?8:10},fitLabel(b,nw-10,w<500?8:10,'Consolas, monospace')));g.append(svgEl('text',{'text-anchor':'middle',y:43,fill:'#6b675f','font-family':'Consolas, monospace','font-size':10},fitLabel(T('visitsCount',{n:v.visits}),nw-6,10,'Consolas, monospace')));
   const select=()=>kernelDetail(v.i);g.onclick=select;g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select();}};svg.append(g);
  });
  ['early','mid','late','eos'].forEach((s,k)=>svg.append(svgEl('text',{x:margin+k*(w-2*margin)/3,y:20,'text-anchor':'middle',fill:'#6b675f','font-family':'Consolas, monospace','font-size':10},T(s))));
 }
 async function readFile(file){if(file.size>10*1024*1024)throw new Error(T('fileTooLarge'));pendingFile=file;$('import-text').value=await file.text();$('drop-title').textContent=file.name;}
 function showImportError(e){importErrorMessage=e.message||String(e);$('import-error').textContent=T('importError',{message:importErrorMessage});$('import-error').hidden=false;}
 document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
 document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
 $('language-button').onclick=()=>setLanguage(I.getLanguage()==='en'?'zh':'en');
 $('import-button').onclick=()=>{stop();importErrorMessage=null;$('import-error').hidden=true;$('import-dialog').showModal();};
 $('method-button').onclick=()=>{stop();$('method-dialog').showModal();};$('export-button').onclick=()=>{stop();$('export-dialog').showModal();};
 $('download-example').onclick=downloadExample;$('method-example').onclick=downloadExample;
 $('reset-demo').onclick=()=>load(window.LENS_DEMO,true);
 $('file-input').onchange=async e=>{if(e.target.files[0])try{await readFile(e.target.files[0]);}catch(e){showImportError(e);}};
 const drop=$('drop-zone');drop.ondragover=e=>{e.preventDefault();drop.classList.add('dragging');};drop.ondragleave=()=>drop.classList.remove('dragging');drop.ondrop=async e=>{e.preventDefault();drop.classList.remove('dragging');if(e.dataTransfer.files[0])try{await readFile(e.dataTransfer.files[0]);}catch(e){showImportError(e);}};
 $('import-confirm').onclick=()=>{try{const txt=$('import-text').value;if(new Blob([txt]).size>10*1024*1024)throw new Error(T('textTooLarge'));const imported=E.parse(txt,pendingFile?.name||'pasted.json');load(imported,false);$('import-dialog').close();$('import-text').value='';pendingFile=null;importErrorMessage=null;$('file-input').value='';$('drop-title').textContent=T('chooseFile');toast(T('importedToast',{n:data.runs.length}));}catch(e){showImportError(e);}};
 $('prev-step').onclick=()=>{stop();selectStep(stepIndex-1);};$('next-step').onclick=()=>{stop();selectStep(stepIndex+1);};$('step-slider').oninput=e=>{stop();selectStep(+e.target.value);};
 $('play-button').onclick=()=>{if(playTimer){stop();return;}if(stepIndex>=currentRun().steps.length-1)selectStep(0);$('play-button').textContent=T('pause');playTimer=setInterval(()=>{if(stepIndex>=currentRun().steps.length-1){stop();return;}selectStep(stepIndex+1);},1100);};
 $('case-select').onchange=e=>{caseIndex=+e.target.value;familyIndex=0;kernelSelection=null;renderReleased();};$('family-select').onchange=e=>{familyIndex=+e.target.value;kernelSelection=null;renderReleased();};$('threshold').oninput=()=>{$('threshold-value').textContent=(+$('threshold').value).toFixed(2);drawKernel();};
 $('export-markdown').onclick=()=>{let md=E.exportMarkdown(data,analysis);md+='\n\n## Dataset provenance\n\n'+(isDemo?'This is a manually constructed teaching example. Its actions, outcomes, state labels and costs are illustrative, not published experiment results.':'User-imported records. Outcomes and numeric fields are supplied by the input, not inferred by this tool.');download('trajectory-lens-report.md',md,'text/markdown;charset=utf-8');$('export-dialog').close();toast(T('reportToast'));};
 $('export-json').onclick=()=>{download('trajectory-lens-data.json',E.exportJSON(data),'application/json');$('export-dialog').close();};
 $('export-svg').onclick=()=>{if(analysis.nodes.length>100){toast(T('svgUnavailable'));return;}const cloned=$('atlas').cloneNode(true);cloned.setAttribute('xmlns',NS);const bg=svgEl('rect',{x:0,y:0,width:'100%',height:'100%',fill:'#fffefa'});cloned.insertBefore(bg,cloned.firstChild);download('trajectory-lens-atlas.svg',new XMLSerializer().serializeToString(cloned),'image/svg+xml');$('export-dialog').close();};
 document.addEventListener('keydown',e=>{if($('workspace-view').hidden||document.querySelector('dialog[open]')||['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(e.target.tagName)||e.target.getAttribute('role')==='button')return;if(e.key==='ArrowRight'){e.preventDefault();stop();selectStep(stepIndex+1);}if(e.key==='ArrowLeft'){e.preventDefault();stop();selectStep(stepIndex-1);}});
 let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{drawAtlas();drawKernel();},120);});
 I.apply();
 if(!E){$('dataset-title').textContent=T('missingEngine');return;}
 load(window.LENS_DEMO,true);
 window.LensApp={getData:()=>data,getAnalysis:()=>analysis,load:raw=>load(raw,false),getLanguage:()=>I.getLanguage(),setLanguage,selectRun:id=>{if(!data.runs.some(r=>r.id===id))throw new Error('Unknown run');stop();if(id===compare)compare=current;current=id;stepIndex=0;selectedNode=null;render();},selectStep,setView};
 if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
  const register=t=>{try{Promise.resolve(document.modelContext.registerTool(t,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'read_trajectory_summary',title:'Read trajectory summary',description:'Read exact-state metrics and run IDs for the currently loaded dataset. Does not return original trace text.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:input=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('Expected an empty object.');return {name:data.name,matching:data.matching,totals:analysis.totals,runs:analysis.perRun,overlaps:analysis.overlaps.map(({a,b,jaccard,intersection,union})=>({a,b,jaccard,intersection,union}))};}});
  register({name:'navigate_trajectory_step',title:'Inspect a trajectory step',description:'Select a run and step in the visible workspace and display its original record. Step is one-based.',inputSchema:{type:'object',properties:{run_id:{type:'string'},step:{type:'integer',minimum:1}},required:['run_id','step'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:input=>{if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['run_id','step'].includes(k)))throw new Error('Expected run_id and step only.');const r=data.runs.find(r=>r.id===input.run_id);if(!r||!Number.isInteger(input.step)||input.step<1||input.step>r.steps.length)throw new Error('Unknown run or step outside the run.');stop();if(current!==r.id){compare=current;current=r.id;}stepIndex=input.step-1;selectedNode=null;setView('workspace');render();return {run_id:current,step:input.step,label:r.steps[stepIndex].label,record:r.steps[stepIndex].text};}});
 }
})();
