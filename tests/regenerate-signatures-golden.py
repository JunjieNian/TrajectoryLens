"""Regenerate public synthetic golden values directly from pinned TraceGraph.

Usage: python tests/regenerate-signatures-golden.py PATH_TO_TRACEGRAPH_CHECKOUT
Requires numpy and tqdm already available in that Python environment.
No user sessions are read. Only the synthetic examples defined below are used.
"""
from pathlib import Path
import importlib.util
import json
import subprocess
import sys

PIN = "bc830d534b6d75174a7ada89e786f6f5b6b35402"
reference = Path(sys.argv[1]).resolve()
head = subprocess.check_output(["git", "-C", str(reference), "rev-parse", "HEAD"], text=True).strip()
if head != PIN:
    raise SystemExit(f"Expected pinned source {PIN}; received {head}")
sys.path.insert(0, str(reference))
from tracegraph.signature import extract_slice_keys, build_idf_weights, compute_pairwise_distances, compute_knn
from tracegraph.graph_construction import build_mutual_knn_edges, build_adjacency_list, find_articulation_points, find_biconnected_components

pipeline_spec = importlib.util.spec_from_file_location("pinned_pipeline", reference / "scripts/pipeline/extract_signatures.py")
pipeline = importlib.util.module_from_spec(pipeline_spec)
pipeline_spec.loader.exec_module(pipeline)

fixtures = [
    {"name": "bash classification precedence and error", "action": {"tool_calls": [{"function": {"name": "bash", "arguments": "python -m pytest /repo/tests/test_case.py"}}]}, "observation": {"content": "Traceback (most recent call last)\nAssertionError: expected 2\n1 failed test"}, "progress": 0},
    {"name": "structured replace and file", "action": {"tool_calls": [{"function": {"name": "str_replace_editor", "arguments": {"path": "/repo/pkg/math.py", "old_str": "def old():\n    pass", "new_str": "def new():\n    return 2"}}}]}, "observation": {"content": "successfully changed"}, "progress": 0.5},
    {"name": "legacy function and relative argument", "action": {"function_call": {"name": "read_file", "arguments": {"file_path": "src/INDEX.TS"}}}, "observation": {"content": [{"text": "module imported"}, {"text": "TypeError in documentation"}]}, "progress": 1},
    {"name": "patch operations", "action": {"tool_calls": [{"function": {"name": "edit", "arguments": "+import os\n+class A:\n+if ready:\n+try:\n+return x\n+assert x\n-def old():\n /repo/main.py"}}]}, "observation": {"content": "test ERROR\nNo such file\nPermission denied\ntimed out"}, "progress": 1 / 3},
    {"name": "multiple tools", "action": {"tool_calls": [{"function": {"name": "execute", "arguments": {"cmd": "rg token /repo/main.py"}}}, {"function": {"name": "create_file", "arguments": {"filename": "newfile"}}}]}, "observation": {"content": "5 passed tests"}, "progress": 2 / 3},
    {"name": "unclassified and null observation", "action": {"tool_calls": [{"function": {"name": "bash", "arguments": "unknown-command"}}]}, "observation": {"content": None}, "progress": 0.99},
    {"name": "empty singleton", "action": {}, "observation": {}, "progress": 0},
    {"name": "unicode boundary is not ASCII boundary", "action": {"tool_calls": [{"function": {"name": "bash", "arguments": "运行pytest命令"}}]}, "observation": {"content": "这是FAILED消息 与success一起"}, "progress": 0.33},
    {"name": "Unicode function and path", "action": {"tool_calls": [{"function": {"name": "edit", "arguments": "+def 函数():\n /工程/测试.文件"}}]}, "observation": {"content": "IndexError KeyError NameError OSError ValueError ImportError SyntaxError AttributeError RuntimeError"}, "progress": 0.67},
    {"name": "Windows paths preserve strict behavior", "action": {"tool_calls": [{"function": {"name": "read", "arguments": {"path": "D:\\Repo\\MixedCase.PY"}}}]}, "observation": {"content": "AssertionError mentioned; all tests passed"}, "progress": 0.1},
]
for fixture in fixtures:
    fixture["keys"] = sorted(extract_slice_keys(fixture["action"], fixture["observation"], fixture["progress"]))
parsed = [
    {"name": "pipeline metadata", "step": {"tool_name": "terminal", "command_class": "pytest", "action_type": "test", "observation_signature": ["test_failed", "AssertionError"], "files_read": ["src/MAIN.PY", "single.py"], "files_touched": ["pkg/edited.py"]}, "progress": 0.33},
    {"name": "pipeline other defaults", "step": {}, "progress": 0.67},
    {"name": "pipeline late", "step": {"tool_name": "read_file", "command_class": "other", "action_type": "", "files_read": ["no-extension"]}, "progress": 0.671},
]
for fixture in parsed:
    fixture["keys"] = sorted(pipeline.extract_cxcmu_slice_keys(fixture["step"], fixture["progress"]))
sets = [set(fixture["keys"]) for fixture in fixtures]
idf = build_idf_weights(sets)
distance = compute_pairwise_distances(sets, idf)
# k=n-1 avoids unspecified NumPy tie ordering; deterministic smaller-k ties
# in JS are tested separately as an explicit browser implementation policy.
knn, knn_distance = compute_knn(distance, len(sets) - 1)
edges = build_mutual_knn_edges(knn, knn_distance, neighbor_k=len(sets) - 1)
result = {"source_commit": PIN, "source_files": ["tracegraph/signature.py", "tracegraph/graph_construction.py", "scripts/pipeline/extract_signatures.py"], "cases": fixtures, "parsed_cases": parsed, "idf": idf, "distances": distance.tolist(), "mutual_edges": sorted(edges, key=lambda edge: (edge["source"], edge["target"]))}
bcc_cases = [
    {"name": "empty", "adjacency": []},
    {"name": "isolated", "adjacency": [[], [], []]},
    {"name": "chain", "adjacency": [[1], [0, 2], [1, 3], [2]]},
    {"name": "cycle", "adjacency": [[1, 3], [0, 2], [1, 3], [2, 0]]},
    {"name": "bowtie", "adjacency": [[1, 2], [0, 2], [0, 1, 3, 4], [2, 4], [2, 3]]},
    {"name": "disconnected cycle bridge isolated", "adjacency": [[1, 2], [0, 2], [0, 1], [4], [3], []]},
    {"name": "root with multiple DFS children", "adjacency": [[1, 2, 3], [0], [0], [0]]},
    {"name": "invalid and self adjacency ignored", "adjacency": [[0, 1, -1, 8], [0, 1], []]},
]
for case in bcc_cases:
    case["articulation_points"] = find_articulation_points(case["adjacency"])
    case["blocks"] = [sorted(block) for block in find_biconnected_components(case["adjacency"])]
result["bcc_cases"] = bcc_cases
visible_edges = [edge for edge in result["mutual_edges"] if 1 - float(distance[edge["source"], edge["target"]]) > 0 and 1 - float(distance[edge["source"], edge["target"]]) >= 0.2]
process_adj = build_adjacency_list(visible_edges, len(sets))
result["process_graph_structure"] = {"k": len(sets) - 1, "min_similarity": 0.2, "edges": visible_edges, "articulation_points": find_articulation_points(process_adj), "blocks": [sorted(block) for block in find_biconnected_components(process_adj)]}
destination = Path(__file__).parent / "fixtures/tracegraph-signatures-golden.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {destination}: {len(fixtures)} raw cases, {len(parsed)} parsed cases, {len(bcc_cases)} BCC cases")
