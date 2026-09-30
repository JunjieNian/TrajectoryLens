# Raw records, with no manual state labels

All examples are synthetic. They illustrate exporter schemas and contain no
private session data, authentication information, or real benchmark results.

- `codex-session.jsonl`: native Codex response-item records with call IDs,
  command results, a repeated failing test and an `apply_patch` call. Five calls,
  two recorded nonzero exits and two repeats of the same test invocation.
- `anthropic-tools.json`: parallel `tool_use` blocks with outputs returned in
  reverse order. Pairing must use IDs, not whichever output appears next.
- `tracegraph-parsed.jsonl`: the parsed step schema consumed by the pinned
  TraceGraph extraction pipeline, with `raw_action` and `raw_observation`.

Import a file directly through the workspace. No `state`, `state_id`, `keys`, or
display-label fields are required. The commands are shown as evidence; this
application never executes them.
