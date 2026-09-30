// Synthetic native messages. No manual states or whole-task outcome labels.
(() => {
  const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const output=(id,exit_code,text)=>({role:'tool',tool_call_id:id,content:JSON.stringify({exit_code,output:text})});
  const failure='FAILED tests/test_transform.py::test_empty_input\nIndexError: list index out of range\n  src/transform.py:8: first = items[0]\n1 failed, 2 passed';
  const task='transform([]) raises IndexError. It should return an empty list. Fix the bug and run the regression test.';
  const test='pytest -q tests/test_transform.py';
  function makeRun(id,name,retry){
    const messages=[{role:'user',content:task}];let count=0;
    const step=(tool,args,code,result,note)=>{const ref=id+'-'+(++count);messages.push({role:'assistant',content:note,tool_calls:[call(ref,tool,args)]},output(ref,code,result));};
    step('exec_command',{cmd:test},1,failure,'Reproduce the empty-input failure.');
    if(retry)step('exec_command',{cmd:test},1,failure,'Confirm the failure with the same test command.');
    step('exec_command',{cmd:'cat src/transform.py'},0,'import itertools\n\ndef transform(items):\n    first = items[0]\n    return [normalize(first)] + [normalize(x) for x in items[1:]]','Read the implementation.');
    step('exec_command',{cmd:'cat tests/test_transform.py'},0,'from src.transform import transform\n\ndef test_empty_input():\n    assert transform([]) == []','Inspect the regression test.');
    const patch='*** Begin Patch\n*** Update File: src/transform.py\n@@\n'+(retry?'':'-import itertools\n-\n')+' def transform(items):\n+    if not items:\n+        return []\n     first = items[0]\n*** End Patch';
    step('apply_patch',{patch},0,'Updated src/transform.py','Guard the empty input before indexing.');
    step('exec_command',{cmd:test},0,'... [100%]\n3 passed in 0.12s','Recheck the focused regression test.');
    step('exec_command',{cmd:'python -m ruff check src/transform.py'},retry?1:0,retry?'F401 src/transform.py:1:8 `itertools` imported but unused\nFound 1 error.':'All checks passed!','Check the edited file for lint errors.');
    messages.push({role:'assistant',content:retry?'The focused test passes. The final lint check still reports an unused import.':'The focused test and file lint check pass.'});
    return {id,name,model:name,messages};
  }
  window.TL_DEMO={name:'An empty-input bug, two repair attempts',source:'Synthetic teaching logs; commands and results are hand-constructed.',runs:[makeRun('retry-then-patch','Attempt A · retry, then patch',true),makeRun('inspect-and-repair','Attempt B · inspect and repair',false)]};
})();
