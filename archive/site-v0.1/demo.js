window.LENS_DEMO = {
 name:'Boundary condition · 三条修复路径',
 description:'手工构造的教学数据，演示分叉、重复与恢复；不是论文实验结果。',
 source:'Illustrative teaching data. All actions, outcomes and costs are manually constructed. State IDs are explicit teaching annotations.',
 runs:[
 {id:'先试再修',model:'Demo agent A',outcome:'success',steps:[
 {state:'read',label:'读取问题',text:'Issue: Empty input raises an exception. Expected behavior: return an empty result.',tokens:180},
 {state:'locate',label:'定位函数',text:'Action: open src/transform.py\nObservation: transform(items) reads items[0] before checking the input length.',tokens:320},
 {state:'reproduce',label:'复现错误',text:'Action: run the empty-input test\nObservation: IndexError at items[0].',tokens:210},
 {state:'patch-a',label:'初版修改',text:'Action: add a guard for None input.\nPatch: if items is None: return []',tokens:410},
 {state:'test-fail',label:'测试未通过',text:'Action: run test_empty_list\nObservation: FAILED — [] is not None; items[0] still raises IndexError.',tokens:240},
 {state:'inspect-edge',label:'检查边界',text:'Action: inspect existing tests and the function contract.\nObservation: None and [] both require an empty result. Non-empty input must keep its current behavior.',tokens:460},
 {state:'patch-b',label:'修正边界',text:'Action: replace the guard with if not items: return [].\nObservation: only the early empty-input branch is changed.',tokens:280},
 {state:'test-pass',label:'验证通过',text:'Action: run empty and non-empty input tests\nObservation: 3 passed. Regression test covers None, [], and [1, 2].',tokens:230},
 {state:'submit',label:'提交结果',text:'Final: empty inputs return []; existing non-empty transformation is preserved.\nOutcome annotation: success (illustrative).',tokens:160}]},
 {id:'先查再改',model:'Demo agent B',outcome:'success',steps:[
 {state:'read',label:'读取问题',text:'Issue: Empty input raises an exception. Expected behavior: return an empty result.',tokens:180},
 {state:'locate',label:'定位函数',text:'Action: open src/transform.py\nObservation: items[0] is evaluated without an empty-input check.',tokens:280},
 {state:'inspect-edge',label:'检查边界',text:'Action: inspect the contract before editing\nObservation: both None and [] require an empty result; tests also cover non-empty input.',tokens:420},
 {state:'patch-b',label:'修正边界',text:'Action: add if not items: return [] before items[0].',tokens:260},
 {state:'test-pass',label:'验证通过',text:'Action: run empty and non-empty input tests\nObservation: 3 passed.',tokens:230},
 {state:'submit',label:'提交结果',text:'Final: the fix matches the empty-input contract.\nOutcome annotation: success (illustrative).',tokens:140}]},
 {id:'重复后停止',model:'Demo agent C',outcome:'failure',steps:[
 {state:'read',label:'读取问题',text:'Issue: Empty input raises an exception. Expected behavior: return an empty result.',tokens:180},
 {state:'locate',label:'定位函数',text:'Action: open src/transform.py\nObservation: items[0] is the failing access.',tokens:280},
 {state:'reproduce',label:'复现错误',text:'Action: run test_empty_list\nObservation: IndexError at items[0].',tokens:210},
 {state:'patch-a',label:'初版修改',text:'Action: add a guard for None input.\nPatch: if items is None: return []',tokens:390},
 {state:'test-fail',label:'测试未通过',text:'Action: run test_empty_list\nObservation: FAILED — [] bypasses the None guard.',tokens:240},
 {state:'reproduce',label:'复现错误',text:'Action: rerun the same empty-list case without changing the patch\nObservation: same IndexError.',tokens:200},
 {state:'patch-a',label:'初版修改',text:'Action: reformat the None guard.\nObservation: the condition is still items is None.',tokens:340},
 {state:'test-fail',label:'测试未通过',text:'Action: run test_empty_list again\nObservation: FAILED — empty list is still not handled.',tokens:230},
 {state:'inspect-edge',label:'检查边界',text:'Action: inspect function tests\nObservation: [] and None are separate cases. The run ends before applying a corrected patch.',tokens:380},
 {state:'stop',label:'预算结束',text:'Final: no successful patch was submitted.\nOutcome annotation: failure (illustrative).',tokens:120}]}
 ]
};
