# @dbydd/omp-hindsight

[English](README.md) | [简体中文](README.zh-CN.md)

`omp-hindsight` is a long-term memory and knowledge base plugin for the `oh-my-pi` (omp) coding assistant. It connects self-hosted or cloud Hindsight instances as a native external memory cortex for agents, delivering persistent recall, cross-session knowledge accumulation, and autonomous workflow guideline awareness across complex research and software engineering tasks.

---

## Key Capabilities

1. **Virtual Multi-Modal Resource Tree (`hindsight://`)**:
   Maps remote memory banks—including original documents, chunks, atomic facts, observations, structured knowledge pages, mental models, and async operations—into a read-only virtual filesystem. Agents explore remote memories naturally via standard `read`, `grep`, and `find` tools.
   - `hindsight://`: Overview of all configured banks and queue status.
   - `hindsight://<bank>/facts/<id>`: Atomic fact details and context.
   - `hindsight://<bank>/knowledge-base/pages/<id>`: Structured knowledge page.
   - `hindsight://<bank>/mental-models/<id>`: Mental model text and evolutionary logs.
   - `hindsight://<bank>/operations/<id>`: Async job progress and processing status.
   - `hindsight://queue`: Local offline retry queue overview and inspection.
   - `hindsight://plugin/config`: Active global and per-bank runtime configuration.

2. **Single Tool with Hierarchical System One Routing**:
   Replaces dozens of scattered tool APIs with a single typed entrypoint: `hindsight({ intent, content?, file?, target? })`:
   - `intent`: Single-step natural language directive (query, search, retain file, update page, etc.).
   - `content`: Inline text body payload (zero-hallucination passing).
   - `file`: Local physical file path (streamed directly by the plugin without context window penalty).
   - `target`: Explicit virtual path or bank target (the most reliable disambiguation anchor).
   Powered by omp's native `modelRoles.judge` (System One decision model) with the principle: *"Action object determines asset type; verb intent determines read/write direction"*, achieving sub-second, highly accurate intention routing.

3. **Bank Write Isolation (`autoTarget` Gate)**:
   Supports configuring `banks[].retain.autoTarget: false` for sensitive banks (e.g. organizational standards, project skills). Autonomous writes without explicit targets are hard-excluded from these banks, protecting core knowledge assets from unintended test logs or volatile session chatter.

4. **Lock-Free Offline Retry Queue**:
   When remote network or service interruptions occur, write requests are atomically staged under `.omp/retry-queue/pending/` and replayed with PID isolation during session boot and post-compaction phases, ensuring eventual consistency.

---

## Installation & Configuration

### 1. Installation

Install within your omp environment:

```bash
omp plugin add @dbydd/omp-hindsight
```

Or configure in your project's `.omp/config.yml`:

```yaml
plugins:
  - "@dbydd/omp-hindsight"
```

### 2. Configuration File

Configuration is loaded and deeply merged across `~/.omp/agent/hindsight-omp.json` (global) and `<cwd>/.omp/hindsight-omp.json` (workspace).

Example configuration (`<cwd>/.omp/hindsight-omp.json`):

```json
{
  "baseUrl": "http://127.0.0.1:8888",
  "apiKeyEnvVar": "HINDSIGHT_API_KEY",
  "banks": [
    {
      "id": "vault",
      "bankId": "project-vault",
      "access": "read-write",
      "description": "Primary research and engineering knowledge base: facts, key concepts, and paper readings",
      "retain": {
        "mode": "manual",
        "scopes": "per_tag",
        "autoTarget": true
      }
    },
    {
      "id": "agent-memo",
      "bankId": "agent-${ROLE}",
      "access": "read-write",
      "description": "Agent working memory: session decisions, progress, debugging traces, and tool insights",
      "retain": {
        "mode": "decision",
        "scopes": "per_tag",
        "autoTarget": true
      }
    },
    {
      "id": "standards",
      "bankId": "org-standards",
      "access": "read-write",
      "description": "Organizational standards and architectural rules (protected bank, explicit writes only)",
      "retain": {
        "mode": "manual",
        "scopes": "per_tag",
        "autoTarget": false
      }
    },
    {
      "id": "archive",
      "bankId": "project-archive",
      "access": "read",
      "description": "Read-only archive bank containing frozen historical records",
      "retain": {
        "mode": "off",
        "scopes": "per_tag"
      }
    }
  ]
}
```

---

## Prompt Packs

All decision questions and criteria prompts are externalized into Markdown files, layered and resolved in order:

| Layer | Path | Scope |
|---|---|---|
| **Bundled Fallback** | `packs/default/` | Distributed with package, always available |
| **User Global** | `~/.omp/agent/hindsight-prompts/` | Machine-wide shared |
| **Workspace Local** | `<cwd>/.omp/prompts/hindsight/` | Project-specific overrides |
| **Explicit Config** | `promptPack` configuration key | Custom path or pack name |

Pack directory structure:
- `judge/action_family.md`: First-tier action family classification.
- `judge/retrieval_depth.md`: Retrieval depth (recall facts vs reflect synthesis).
- `judge/knowledge_base_action.md`: Knowledge base page and directory operations.
- `judge/mental_model_action.md`: Mental model lifecycle management.
- `judge/operation_action.md`: Async operations and physical document removal.
- `judge/target_bank.md`: Target memory bank disambiguation.
- `judge/retain_source.md`: Content source determination (inline / reference / session).
- `judge/inject_decision.md`: Decision gate for autonomous context injection.
- `recall/rerank.md`: Cross-bank candidate reranking prompt.
- `decomposer/system.md`: Complex intent sentence decomposition.
- `guidance/tool_description.md`: Tool description displayed to the caller LLM.
- `guidance/retain_nudge.md`: Mid-task memory retention nudge prompt.

---

## Quality Gates & Verification

The plugin strictly follows a Single Source of Truth (SSOT) specification in `ssot/spec.ts`.

Run the full verification and test suite:

```bash
bun run verify
```

Test breakdown:
- `bun run test:core`: Local config, virtual path matching, rendering, and offline retry queue.
- `bun run test:adapter`: Multi-tier config loading, persistent updates, and live health probes.
- `bun run test:pack`: Prompt pack resolution, layer fallback, and schema validation.
- `bun run test:judge`: Full decision dataset against System One judge endpoint (248 unit decisions + 130 end-to-end cascades).

---

## Core Documentation

- [docs/01-system-architecture.md](docs/01-system-architecture.md): Overall architecture and interaction contracts.
- [docs/02-judge-system.md](docs/02-judge-system.md): System One tiered judge mechanics and context isolation.
- [docs/03-runtime-lifecycle.md](docs/03-runtime-lifecycle.md): Runtime lifecycle and adaptive recall mechanism.
- [docs/generated/](docs/generated/): SSOT-generated listings of routes, actions, configurations, and invariants.

---

## License

[MIT License](LICENSE) © 2026 dbydd
