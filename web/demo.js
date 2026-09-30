// Synthetic native messages. No state IDs, trajectory labels or task outcomes.
(() => {
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const output = (id, exit_code, text) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify({ exit_code, output: text }) });
  const failure = 'FAILED tests/test_transform.py::test_empty_input\nIndexError: list index out of range\n  src/transform.py:8: first = items[0]\n1 failed, 2 passed';
  const task = 'transform([]) raises IndexError. It should return an empty list. Fix the bug and run the regression test.';
  window.TL_DEMO = {
    name: 'Empty-input bug · two raw repair logs',
    source: 'Synthetic teaching logs. Commands and results are hand-constructed; no commands were executed by this app.',
    runs: [
      { id: 'repeat-the-test', model: 'Example agent A', messages: [
        { role: 'user', content: task },
        { role: 'assistant', content: 'I will reproduce the failure.', tool_calls: [call('a1', 'exec_command', { cmd: 'pytest -q tests/test_transform.py' })] },
        output('a1', 1, failure),
        { role: 'assistant', content: 'I will look at the test.', tool_calls: [call('a2', 'exec_command', { cmd: 'cat tests/test_transform.py' })] },
        output('a2', 0, 'from src.transform import transform\n\ndef test_empty_input():\n    assert transform([]) == []'),
        { role: 'assistant', content: 'Retry the same command to confirm the failure.', tool_calls: [call('a3', 'exec_command', { cmd: 'pytest -q tests/test_transform.py' })] },
        output('a3', 1, failure),
        { role: 'assistant', content: 'The same failure is still present. I have not changed the implementation.' }
      ] },
      { id: 'inspect-then-patch', model: 'Example agent B', messages: [
        { role: 'user', content: task },
        { role: 'assistant', content: 'Inspect the implementation before editing.', tool_calls: [call('b1', 'exec_command', { cmd: 'cat src/transform.py' })] },
        output('b1', 0, 'def transform(items):\n    first = items[0]\n    return [normalize(first)] + [normalize(x) for x in items[1:]]'),
        { role: 'assistant', content: 'An empty input needs a guard before indexing.', tool_calls: [call('b2', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: src/transform.py\n@@\n def transform(items):\n+    if not items:\n+        return []\n     first = items[0]\n*** End Patch' })] },
        output('b2', 0, 'Updated src/transform.py'),
        { role: 'assistant', content: 'Run the focused regression test.', tool_calls: [call('b3', 'exec_command', { cmd: 'pytest -q tests/test_transform.py' })] },
        output('b3', 0, '... [100%]\n3 passed in 0.12s'),
        { role: 'assistant', content: 'The focused regression test now passes.' }
      ] }
    ]
  };
})();
