/* SPDX-License-Identifier: Apache-2.0
 * Observable process-map display. This module does not alter graph topology,
 * infer task outcomes, or enter the TraceGraph structural computation.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LensProcess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLORS = {background:'#fffefa',text:'#191918',muted:'#6b675f',line:'#dcd7cd',accent:'#8f1d2c',
    green:'#3e6354',amber:'#8a6332',unknown:'#8c887d',edge:'#a89787'};
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const pairId = edge => JSON.stringify([edge.source, edge.target]);
  function layout(data, graph, options = {}) {
    const available = Math.max(280, finite(options.width, 650));
    const zoom = Math.max(0.25, Math.min(4, finite(options.zoom, 1)));
    const grouped = new Map();
    for (const node of graph.nodes || []) {
      if (!grouped.has(node.runId)) grouped.set(node.runId, []);
      grouped.get(node.runId).push(node);
    }
    const runs = (data.runs || []).filter(run => grouped.has(run.id));
    const maximum = Math.max(1, ...runs.map(run => grouped.get(run.id).length));
    const left = 62, rightMargin = 62, spacing = Math.max(36, 72 * zoom);
    // Natural width grows with the longest run. No cap squeezes hundreds of
    // occurrences into overlapping invisible targets; the parent can scroll.
    const width = Math.max(available, left + rightMargin + Math.max(1, maximum - 1) * spacing);
    const height = Math.max(210, 60 + runs.length * 112 + 35), right = width - rightMargin;
    const points = [], lanes = [];
    runs.forEach((run, laneIndex) => {
      const nodes = grouped.get(run.id).slice().sort((a, b) => a.eventIndex - b.eventIndex);
      const y = 77 + laneIndex * 112;
      const gap = nodes.length > 1 ? (right - left) / (nodes.length - 1) : width;
      const hitWidth = Math.min(48, Math.max(8, gap - 8));
      const labelEvery = Math.max(1, Math.ceil(86 / Math.max(1, gap)));
      lanes.push({runId:run.id,name:run.name || run.id,y,left,right,count:nodes.length,gap});
      nodes.forEach((node, ordinal) => {
        const x = nodes.length === 1 ? (left + right) / 2 : left + gap * ordinal;
        const event = run.events?.[node.eventIndex] || {};
        points.push({id:node.id,node,runId:run.id,eventIndex:node.eventIndex,event,x,y,ordinal,number:ordinal + 1,
          hitWidth,hitHeight:48,labelEvery,showLabel:ordinal === nodes.length - 1 || ordinal % labelEvery === 0 && nodes.length - 1 - ordinal >= labelEvery});
      });
    });
    return {width,height,zoom,spacing,left,right,lanes,points};
  }
  function short(value, maximum) {
    const text = String(value ?? '');
    return text.length > maximum ? text.slice(0, maximum - 1) + '…' : text;
  }
  function fitText(value, pixels, fontSize = 12) {
    const text = String(value ?? ''), characters = Array.from(text);
    const width = character => character.codePointAt(0) >= 0x2e80 ? fontSize : fontSize * .57;
    if (characters.reduce((sum,character)=>sum+width(character),0) <= pixels) return text;
    let result = '', used = fontSize;
    for (const character of characters) {if (used+width(character)>pixels) break;result+=character;used+=width(character);}
    return result+'…';
  }
  function inputPreview(event) {
    let text = event.inputText || '';
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') text = value.cmd || value.command || value.path || value.file_path || value.patch || text;
    } catch (_) {}
    return short(text, 240);
  }
  function draw(svg, options) {
    const {data,graph,selected,activeBlock,onSelect,onEdgeSelect} = options;
    const t = options.t || (key => key), document = svg.ownerDocument;
    const element = (tag, attributes = {}, text) => {
      const node = document.createElementNS(NS, tag);
      for (const [key,value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    svg.replaceChildren();
    svg.setAttribute('xmlns', NS);svg.setAttribute('role','group');
    svg.setAttribute('aria-label', t('processSvgTitle'));
    svg.append(element('title',{},t('processSvgTitle')),element('desc',{},t('processSvgDescription')));
    if (graph.limited || !graph.nodes?.length) {
      const width = Math.max(280, finite(options.width,650)), height = 180;
      svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.style.width = width + 'px';svg.style.height = height + 'px';
      svg.append(element('rect',{width,height,fill:COLORS.background}));
      const message = t(graph.limited ? 'processLimit' : 'messageOnly',{n:graph.totalNodes});
      // Wrap warnings inside the SVG instead of placing one clipped text line.
      const limit = Math.max(24,Math.floor((width - 48) / 6));
      const words = String(message).match(/\S+\s*/g) || [''];
      const lines = [];let line = '';
      for (const word of words) {
        if (line && (line + word).length > limit) {lines.push(line.trim());line='';}
        if (word.length > limit) {
          if (line) {lines.push(line.trim());line='';}
          for (let offset=0;offset<word.length;offset+=limit) lines.push(word.slice(offset,offset+limit).trim());
        } else line += word;
      }
      if (line) lines.push(line.trim());
      const label = element('text',{x:24,y:55,fill:COLORS.muted,'font-family':'DM Sans, sans-serif','font-size':12});
      lines.forEach((value,index)=>label.append(element('tspan',{x:24,dy:index ? 19 : 0},value)));svg.append(label);
      return {ready:false,width,height,revealSelected(){}};
    }
    const geometry = layout(data, graph, options), {width,height,lanes,points} = geometry;
    const pointById = new Map(points.map(point => [point.id,point]));
    const selectedPoint = points.find(point => point.runId === selected?.runId && point.eventIndex === selected?.eventIndex);
    const selectedId = selectedPoint?.id, neighborhood = new Set(selectedId ? [selectedId] : []);
    for (const edge of graph.edges || []) {
      if (edge.source === selectedId) neighborhood.add(edge.target);
      if (edge.target === selectedId) neighborhood.add(edge.source);
    }
    const focus = Boolean(options.focusOnly && selectedId);
    const chosenBlock = graph.blocks?.find(block => block.id === activeBlock);
    const blockMembers = new Set(chosenBlock?.nodeIds || []), cuts = new Set(graph.articulationPoints || []);
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.style.width = width + 'px';svg.style.height = height + 'px';
    svg.append(element('rect',{width,height,fill:COLORS.background}));
    const restoreFocus = (attribute, value) => {
      const restore = () => {
        // The parent callback may rebuild this same SVG. Locate the new element
        // by stable occurrence/edge identity after that rebuild, not the old DOM.
        const target = Array.from(svg.querySelectorAll('[' + attribute + ']')).find(node => node.getAttribute(attribute) === value);
        if (target && typeof target.focus === 'function') target.focus({preventScroll:true});
      };
      const win = document.defaultView;
      if (win?.requestAnimationFrame) win.requestAnimationFrame(restore);else restore();
    };
    for (const lane of lanes) {
      const suffix = ` · ${lane.count} ${t('calls')}`, labelWidth = Math.max(80,width-geometry.left-62-suffix.length*7);
      const label = element('text',{x:geometry.left,y:lane.y-33,fill:lane.runId===selected?.runId?COLORS.accent:COLORS.muted,
        'font-family':'DM Sans, sans-serif','font-size':12},`${fitText(lane.name,Math.min(labelWidth,320))}${suffix}`);
      label.append(element('title',{},lane.name));svg.append(label);
      svg.append(element('line',{x1:lane.left,y1:lane.y,x2:lane.right,y2:lane.y,stroke:COLORS.line,
        'stroke-width':1,'stroke-dasharray':'3 5','pointer-events':'none',class:'order-guide'}));
    }
    for (const edge of graph.edges || []) {
      const source = pointById.get(edge.source), target = pointById.get(edge.target);
      if (!source || !target) continue;
      const incident = edge.source === selectedId || edge.target === selectedId;
      const inBlock = blockMembers.has(edge.source) && blockMembers.has(edge.target);
      const inFocus = neighborhood.has(edge.source) && neighborhood.has(edge.target);
      const opacity = (chosenBlock && !inBlock ? .09 : 1) * (focus && !inFocus ? .07 : incident || inBlock ? .82 : .28);
      const lift = Math.min(50, Math.abs(target.x-source.x)*.13+16);
      const path = source.y===target.y ? `M ${source.x} ${source.y} Q ${(source.x+target.x)/2} ${source.y-lift*2} ${target.x} ${target.y}`
        : `M ${source.x} ${source.y} C ${source.x} ${(source.y+target.y)/2}, ${target.x} ${(source.y+target.y)/2}, ${target.x} ${target.y}`;
      const id = pairId(edge), sharedKeys = source.node.keys.filter(key => target.node.keys.includes(key) && (graph.idf?.[key] || 0)>0)
        .sort((a,b)=>(graph.idf[b] || 0)-(graph.idf[a] || 0)||a.localeCompare(b));
      const title = t('processSimilarityEdge',{source:`${source.runId} #${source.number}`,target:`${target.runId} #${target.number}`,
        overlap:(edge.similarity*100).toFixed(1)}) + '\n' + sharedKeys.join(' · ');
      const group = element('g',{class:'process-edge',role:'button',tabindex:0,'data-process-edge':id,'aria-label':title});
      const hit = element('path',{d:path,fill:'none',stroke:'transparent','stroke-width':9,'pointer-events':'stroke',class:'process-edge-hit'});
      const visible = element('path',{d:path,fill:'none',stroke:incident||inBlock?COLORS.accent:COLORS.edge,
        'stroke-width':incident||inBlock?2:1,opacity,'pointer-events':'none','data-similarity':edge.similarity});
      group.append(hit,visible,element('title',{},title));
      group.addEventListener('focus',()=>visible.setAttribute('stroke-width','3'));
      group.addEventListener('blur',()=>visible.setAttribute('stroke-width',incident||inBlock?'2':'1'));
      const choose = () => {onEdgeSelect?.({edge,source:source.node,target:target.node,sharedKeys});restoreFocus('data-process-edge',id);};
      group.addEventListener('click',choose);group.addEventListener('keydown',event=>{
        if (event.key==='Enter'||event.key===' ') {event.preventDefault();choose();}
      });svg.append(group);
    }
    for (const point of points) {
      const {node,event,x,y} = point, active = point.id === selectedId;
      const dimmed = !active && ((chosenBlock && !blockMembers.has(point.id)) || (focus && !neighborhood.has(point.id)));
      const status = event.status || 'unknown', color = status==='error'?COLORS.accent:status==='ok'?COLORS.green:status==='pending'?COLORS.amber:COLORS.unknown;
      const statusLabel = t({ok:'statusOk',error:'statusError',pending:'statusPending',unknown:'statusUnknown'}[status]||'statusUnknown');
      const title = t('processNodeTitle',{run:lanes.find(lane=>lane.runId===point.runId)?.name||point.runId,
        call:t('callLabel',{n:point.number}),tool:event.tool||node.label||'',status:statusLabel}) + '\n' + inputPreview(event)
        + (cuts.has(point.id)?'\n'+t('connectionPoint'):'');
      const group = element('g',{class:'process-node',role:'button',tabindex:0,'data-run':point.runId,'data-event':point.eventIndex,
        'data-process-node':point.id,'aria-label':title,'aria-pressed':active,opacity:dimmed?.2:1});
      // Neighbor centers have gap > hitWidth + 8 in every lane. Later siblings
      // therefore cannot intercept clicks intended for earlier occurrences.
      group.append(element('rect',{x:x-point.hitWidth/2,y:y-20,width:point.hitWidth,height:point.hitHeight,
        fill:'transparent','pointer-events':'all',class:'process-hit-area'}));
      if (cuts.has(point.id)) group.append(element('circle',{cx:x,cy:y,r:15,fill:'none',stroke:COLORS.amber,
        'stroke-width':1.3,'stroke-dasharray':'2 2','pointer-events':'none',class:'articulation-ring'}));
      const marker = status==='pending'
        ? element('path',{d:`M ${x} ${y-7} L ${x+7} ${y} L ${x} ${y+7} L ${x-7} ${y} Z`,fill:COLORS.background,stroke:color,'stroke-width':1.8})
        : element('circle',{cx:x,cy:y,r:active?8:6,fill:status==='unknown'?COLORS.background:color,stroke:color,'stroke-width':1.8});
      group.append(marker);
      const selection = element('circle',{cx:x,cy:y,r:active?11:10,fill:'none',stroke:COLORS.accent,'stroke-width':1.5,
        visibility:active?'visible':'hidden','pointer-events':'none',class:'process-selection-ring'});
      group.append(selection);
      const category = node.keys.find(key=>key.startsWith('CMD:'))?.slice(4)
        || String(event.tool||node.label||'').replace(/^.*[.:]/,'').replace('apply_patch','patch');
      const nearSelectedLabel = selectedPoint && point.runId===selectedPoint.runId && Math.abs(x-selectedPoint.x)<102;
      if (active || point.showLabel && !nearSelectedLabel) {
        const label = `${String(point.number).padStart(2,'0')} ${short(category,geometry.zoom<1?7:11)}`;
        const labelElement = element('text',{x,y:y+27,'text-anchor':'middle',fill:active?COLORS.accent:COLORS.muted,
          'font-family':'Consolas, monospace','font-size':10,'pointer-events':'none'},label);
        if (active) {
          const length = label.length*6.1;
          group.append(element('rect',{x:x-length/2-3,y:y+15,width:length+6,height:17,fill:COLORS.background,'pointer-events':'none'}));
        }
        group.append(labelElement);
      }
      group.append(element('title',{},title));
      group.addEventListener('focus',()=>selection.setAttribute('visibility','visible'));
      group.addEventListener('blur',()=>selection.setAttribute('visibility',active?'visible':'hidden'));
      const choose = () => {onSelect?.(point.runId,point.eventIndex);restoreFocus('data-process-node',point.id);};
      group.addEventListener('click',choose);group.addEventListener('keydown',event=>{
        if (event.key==='Enter'||event.key===' ') {event.preventDefault();choose();}
        else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
          const laneIndex=lanes.findIndex(lane=>lane.runId===point.runId);
          let destination;
          if (event.key==='ArrowLeft'||event.key==='ArrowRight') {
            destination=points.find(other=>other.runId===point.runId&&other.ordinal===point.ordinal+(event.key==='ArrowRight'?1:-1));
          } else {
            const otherLane=lanes[laneIndex+(event.key==='ArrowDown'?1:-1)];
            if (otherLane) destination=points.filter(other=>other.runId===otherLane.runId)
              .sort((a,b)=>Math.abs(a.x-x)-Math.abs(b.x-x)||a.ordinal-b.ordinal)[0];
          }
          if (destination) {
            event.preventDefault();onSelect?.(destination.runId,destination.eventIndex);
            restoreFocus('data-process-node',destination.id);
          }
        }
      });svg.append(group);
    }
    const axis = element('text',{x:geometry.left,y:height-15,fill:COLORS.muted,'font-family':'DM Sans, sans-serif','font-size':10},fitText(t('processAxis'),width-geometry.left-30,10));
    axis.append(element('title',{},t('processAxis')));svg.append(axis);
    return {ready:true,width,height,revealSelected(){
      if (!selectedPoint) return;
      const holder = svg.closest('.process-scroll') || svg.parentElement;
      if (!holder) return;
      const left = Math.max(0,selectedPoint.x-holder.clientWidth/2), top = Math.max(0,selectedPoint.y-holder.clientHeight/2);
      const motionReduced = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (typeof holder.scrollTo==='function') holder.scrollTo({left,top,behavior:motionReduced?'auto':'smooth'});
      else {holder.scrollLeft=left;holder.scrollTop=top;}
    }};
  }
  return {draw,layout};
});
