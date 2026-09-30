# Third-party source and method provenance

`web/signatures.js` adapts observable feature extraction and similarity code from
[JunjieNian/TraceGraph](https://github.com/JunjieNian/TraceGraph), pinned at
`bc830d534b6d75174a7ada89e786f6f5b6b35402`, under the Apache License 2.0.
The project license is included in `LICENSE`.

Adapted source:

- [`tracegraph/signature.py`](https://github.com/JunjieNian/TraceGraph/blob/bc830d534b6d75174a7ada89e786f6f5b6b35402/tracegraph/signature.py): tool/action keys; ordered command regex classification; observation and diff regexes; file extension and last-two-components path signatures; temporal phase; IDF weights; weighted Jaccard distance.
- [`scripts/pipeline/extract_signatures.py`](https://github.com/JunjieNian/TraceGraph/blob/bc830d534b6d75174a7ada89e786f6f5b6b35402/scripts/pipeline/extract_signatures.py): `extract_cxcmu_slice_keys`, for the project's already-parsed trace exports. Explicit parsed metadata is retained with `tracegraph:parsed-record:*` evidence rules. Its `<= .33` / `<= .67` phase thresholds are preserved for this input type.
- [`tracegraph/graph_construction.py`](https://github.com/JunjieNian/TraceGraph/blob/bc830d534b6d75174a7ada89e786f6f5b6b35402/tracegraph/graph_construction.py): reciprocal k-nearest-neighbor edge membership and `exp(-distance / 0.35)` edge weights, rounded to six places; iterative Tarjan articulation-point and biconnected-component algorithms.

The JavaScript rewrite is dependency-free and runs locally in the browser. Its
strict extraction functions are checked against golden results produced by the
actual pinned Python sources. Pairwise distances preserve NumPy's float32
rounding; IDF and mutual graph weights are also tested against those sources.
Synthetic fixtures and a regeneration script are included under `tests/`.
Graph structure is also checked against the actual Python algorithms on chains,
cycles, a bowtie, disconnected graphs, isolated nodes, and the displayed threshold
graph derived from the pinned signature fixtures.
No private conversations or session logs are bundled.

## Local changes and explicit extensions

- Raw imported tool events are paired by call ID before feature extraction.
  Each invocation is a node; user prose, assistant prose, and unmatched tool
  outputs are not silently treated as invocations. Phase uses invocation order,
  not elapsed wall-clock time; a singleton is early.
- Standard Codex `exec_command`, `apply_patch`, and related tool names are
  supported in addition to upstream's generic bash/execute/edit names.
  JSON argument text can be decoded for command/path/patch extraction.
  Relative and Windows file paths, patch headers, node/npm/PowerShell command
  categories, and evidence records are additions. Added evidence rules start
  with `lens-extension:`. The strict `extractSliceKeys` API disables these
  additions unless requested explicitly; the interactive viewer enables them.
- Path case is preserved. File signatures keep only the final two components,
  as upstream does, so different complete paths can share a signature. The
  matching key is not proof that two paths identify the same file. Evidence
  retains the original path fragment for inspection.
- Every key includes its source, rule and an original matching fragment.
  Observation, command and diff keys are regex hits. Quoted examples, source
  listings, and documentation can match; an `OBS:AssertionError` or
  `OBS:test_failed` key is not a verified execution failure. Imported execution
  status is kept separate and is not inferred from those signatures.
- IDF uses every loaded invocation: `log((1 + N) / (1 + df(key)))`.
  Similarity is IDF-weighted Jaccard over observable key sets, not semantic
  reasoning equivalence. Keys shared by all invocations have weight zero.
  When the union has zero total weight, similarity is zero, including
  singleton datasets. Related-step search omits zero-similarity results.
- Neighbor ties use stable source order because NumPy's `argpartition` tie
  order is unspecified. The optional graph applies a displayed minimum
  similarity threshold after reciprocal neighbor construction, and defaults
  to hiding similarities below 0.2. This filter is a viewer extension.
- The browser graph is disabled above 300 invocations instead of silently
  sampling. Chronology, signatures and related-step search still include the
  entire imported dataset. This differs from the offline pipeline's larger
  cap and random sampling policy.
- Biconnected blocks and articulation points describe the displayed undirected
  similarity graph, after the viewer's minimum-similarity filter. Raising the
  filter may change both. A block is a graph structure, not a semantic cluster,
  successful region, reward estimate or trap. Its run coverage counts loaded
  runs only. Cut vertices can belong to multiple blocks; isolated nodes belong
  to none; two-node bridges are explicitly marked trivial. No temporal path
  edges are added to the graph used for this decomposition.

This viewer does not implement TraceGraph's block roles, reward propagation,
recovery gates, failure basins, clustering,
or outcome estimates. It visualizes recorded tool activity and automatically
derived observable similarities. Its display coordinates are layout choices,
not activations or learned embeddings. Similarity, repetition and graph
membership are inspection aids, not diagnoses of wasted work or causal effects.
