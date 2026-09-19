# Codebase Memory

> A fast, AST-based knowledge graph of the repo. Backlinked from [[README]].

## What it is

`codebase-memory-mcp` is a tool that indexes the repo into a queryable knowledge graph. It's:
- **Fast**: 9 seconds to index the entire m59-harness repo (57,620 nodes, 127,458 edges)
- **AST-based**: Uses tree-sitter, not LLM extraction
- **No infrastructure**: Single static binary, no Docker, no LLM server
- **15 MCP tools**: search, trace, architecture, impact analysis, etc.

## The setup

```bash
# Install (one-line)
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash

# Index the repo
codebase-memory-mcp cli index_repository --repo-path /Users/costas/Documents/Projects/m59-harness --name m59-harness

# Start the persistent daemon (faster queries)
codebase-memory-mcp daemon start

# Enable the 3D graph UI
codebase-memory-mcp --ui=true
# View at http://localhost:9749
```

## The 15 tools

| Tool | What it does |
|------|-------------|
| `index_repository` | Index a repo into the graph |
| `search_graph` | BM25 search over the graph |
| `query_graph` | Cypher queries |
| `trace_path` | Trace call chains (inbound/outbound) |
| `get_code_snippet` | Get the source code of a function/variable |
| `get_graph_schema` | Get the graph schema |
| `get_architecture` | Get the architecture (layers, boundaries, clusters, hotspots) |
| `search_code` | Regex search over the code |
| `list_projects` | List indexed projects |
| `delete_project` | Delete a project from the graph |
| `index_status` | Check index status |
| `check_index_coverage` | Check what's indexed |
| `detect_changes` | Detect file changes (incremental update) |
| `manage_adr` | Manage Architecture Decision Records |
| `ingest_traces` | Ingest runtime traces |

## The 3D graph UI

The 3D graph UI is served at `http://localhost:9749` when the daemon is running.
It shows:
- **Nodes**: Files, functions, variables, classes, routes, etc.
- **Edges**: IMPORTS, CALLS, DEFINES, USAGE, CONFIGURES, etc.
- **Layouts**: Force-directed, hierarchical, circular
- **Filters**: By node type, edge type, file, language

## The MCP integration

`codebase-memory-mcp` is integrated with:
- **Claude Code**: MCP tools available as `mcp__codebase-memory__*`
- **Codex CLI**: MCP tools available as `codebase-memory.*`
- **Pi**: MCP tools available via the extension

After installing, restart your coding agent to pick up the MCP tools.

## When to use it

| Question | Tool |
|----------|------|
| "What does this file do?" | `get_architecture` |
| "What calls X?" | `trace_path --function-name X --direction inbound` |
| "What does X call?" | `trace_path --function-name X --direction outbound` |
| "Where is X defined?" | `search_graph --query X` then `get_code_snippet` |
| "What files would I need to touch?" | `search_graph` + `trace_path` |
| "Is there dead code?" | `get_architecture --aspects cycles` |
| "What changed since last index?" | `detect_changes` |

## Comparison with Graphiti

| | Graphiti | codebase-memory-mcp |
|---|---|---|
| **Indexing time** | 2.5 hours | 9 seconds |
| **Infrastructure** | Neo4j Docker + vLLM + Python venv | Single binary |
| **LLM needed** | Yes (entity extraction) | No (AST-based) |
| **MCP tools** | 0 (Python API only) | 15 |
| **Visualization** | None | 3D graph UI |

**codebase-memory-mcp is a strict upgrade.** Graphiti has been removed.

## Links

- [[ARCHITECTURE]] — the big picture
- [[FILES]] — what each file does
- [[REPO-MODEL]] — the full repo model
