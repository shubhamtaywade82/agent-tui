I would like to use
<https://github.com/shubhamtaywade82/ruby-agent-skills>
<https://github.com/shubhamtaywade82/ollama-sdk>
<https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro>

thse in a long running agentic process where we use minicpm5-2b ollama model which can do small small iterations of implementation using these ruby-agent-skills and implement. and complete project
where the context of this llm model is small we want to be a le to make sure we donot exceed that each iteration while completing small small pieces of the whole app along with some memory, context ext etc
Based on deterministic evidence gathering, I have analyzed the specified repositories, documentation, and model capabilities to formulate a robust architecture for your long-running agentic process.

### 1. Evidence Summary

- **`ruby-agent-skills`**: Provides a validated, five-layer agent operating model that explicitly mandates: *"Implement the smallest coherent change"* followed by *"Run focused verification"* [[1]]. This is ideal for iterative development.
- **`ollama-sdk`**: A production-grade TypeScript SDK featuring autonomous agent tool calling, Zod-powered structured outputs, and a first-class `McpBridge` to convert Model Context Protocol (MCP) tool descriptors into Ollama function definitions [[1]].
- **Model Context Protocol (MCP)**: An open-source standard acting as a "USB-C port for AI applications", allowing the agent to access external tools (e.g., file system, shell) without hardcoding tool logic into the prompt [[1]].
- **MiniCPM5-2B**: A 2.5B dense model from OpenBMB. While its native context length is documented at 131,072 tokens [[15]], 2B-class models experience attention degradation and practical VRAM limitations at scale. Therefore, strict context windowing is a necessary and correct architectural constraint.

---

### 2. Architectural Design

To achieve small, iterative implementations without exceeding the context window, the system should be decoupled into three distinct components:

1. **The Orchestrator (Ruby)**: Manages the high-level workflow, state, and iteration loop using the `ruby-agent-skills` routing logic.
2. **The LLM Interface (TypeScript/Node.js Sidecar)**: Utilizes `@nemesis-oss/ollama-sdk` to handle communication with `minicpm5-2b`. This leverages the SDK’s built-in `McpBridge` and structured output (Zod) enforcement, ensuring the small model outputs predictable, parseable actions.
3. **The MCP Server**: A lightweight local server exposing deterministic tools: `read_file`, `write_file`, `execute_shell`, and `run_focused_test`.

---

### 3. Context & Memory Management Strategy

To prevent context overflow, the agent must never hold the entire project state in its prompt. Instead, implement the **Externalized Scratchpad Pattern**:

- **`PROJECT_STATE.md` (Single Source of Truth)**: Maintained by the Orchestrator, not the LLM. It contains:
  - `overall_goal`: The final project objective.
  - `completed_steps`: A compressed list of the last 3 completed actions (e.g., "- Created User model with email validation").
  - `current_step`: The exact, narrow task for the current iteration (e.g., "Write RSpec for User email validation").
  - `active_files`: An array of file paths relevant *only* to the `current_step`.
- **Just-In-Time (JIT) Context Loading**: The Orchestrator reads `PROJECT_STATE.md`, uses the MCP `read_file` tool to fetch *only* the `active_files`, and injects only this minimal slice into the LLM prompt.
- **Diff-Only Outputs**: The LLM is constrained via Zod schema to output only file paths and unified diffs (or complete small file contents), never entire codebases.

---

### 4. Implementation Blueprint

#### Step A: Initialize the MCP Server

Create a simple MCP server that exposes file and shell operations. The `ollama-sdk` will consume this via its `McpBridge`.

```typescript
// mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";

const server = new McpServer({ name: "ruby-dev-tools", version: "1.0.0" });

server.tool("read_file", { path: z.string() }, async ({ path }) => {
  const content = await fs.readFile(path, "utf-8");
  return { content: [{ type: "text", text: content }] };
});

server.tool("write_file", { path: z.string(), content: z.string() }, async ({ path, content }) => {
  await fs.writeFile(path, content, "utf-8");
  return { content: [{ type: "text", text: `Successfully wrote to ${path}` }] };
});

server.tool("run_shell", { command: z.string() }, async ({ command }) => {
  const { exec } = require("child_process");
  return new Promise(resolve => exec(command, (error, stdout, stderr) => {
    resolve({ content: [{ type: "text", text: error ? stderr : stdout }] });
  }));
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

#### Step B: The Orchestrator Loop (Ruby)

The Ruby process manages the `ruby-agent-skills` workflow, delegating LLM calls to the TypeScript sidecar.

```ruby
# orchestrator.rb
require 'json'

class AgenticOrchestrator
  def initialize(project_state_path)
    @project_state_path = project_state_path
  end

  def run_iteration
    state = JSON.parse(File.read(@project_state_path))

    # 1. JIT Context Gathering
    context_files = state["active_files"].map do |file|
      { path: file, content: File.read(file) rescue "File not found" }
    end

    # 2. Construct Minimal Prompt (aligned with ruby-agent-skills)
    prompt = <<~PROMPT
      You are a Ruby expert agent. Follow the rule: "Implement the smallest coherent change".
      Overall Goal: #{state["overall_goal"]}
      Recently Completed: #{state["completed_steps"].last(2).join(", ")}
      Current Step: #{state["current_step"]}

      Relevant Files:
      #{context_files.map { |f| "### #{f[:path]}\n#{f[:content]}" }.join("\n")}

      Task: Provide the exact code to complete the Current Step.
      Output MUST be valid JSON matching the schema: { "file_path": String, "new_content": String, "shell_command_to_verify": String }
    PROMPT

    # 3. Delegate to Ollama SDK Sidecar (via HTTP or STDIO)
    response = call_ollama_sidecar(prompt, state["model"] || "minicpm5-2b")
    action = JSON.parse(response)

    # 4. Execute & Verify
    File.write(action["file_path"], action["new_content"])
    verification_result = `#{action["shell_command_to_verify"]} 2>&1`

    # 5. Update State (Memory Management)
    if $?.success?
      state["completed_steps"] << "Completed: #{state["current_step"]}"
      state["completed_steps"] = state["completed_steps"].last(5) # Sliding window memory
      state["current_step"] = state["next_steps"].shift
      state["active_files"] = determine_next_active_files(state["current_step"])
    else
      # Append error to current step for retry, preventing infinite loops by tracking retry count
      state["current_step"] += "\nERROR: #{verification_result}. Fix this specific error."
    end

    File.write(@project_state_path, JSON.pretty_generate(state))
  end

  private

  def call_ollama_sidecar(prompt, model)
    # Implementation to call your Node.js sidecar using @nemesis-oss/ollama-sdk
    # which enforces the Zod schema and utilizes the McpBridge if dynamic tooling is needed.
    # For simplicity, this example assumes a direct HTTP POST to a local wrapper.
    `curl -s -X POST http://localhost:3000/generate -H "Content-Type: application/json" -d '{"prompt": "#{prompt.gsub('"', '\"')}", "model": "#{model}"}'`
  end
end
```

---

### 5. Deterministic Recommendations for Success

1. **Enforce Strict Schemas**: MiniCPM5-2B, like all sub-3B models, can hallucinate formatting. Rely on the `ollama-sdk`’s `chatWithSchema` (Zod) feature to guarantee the output is machine-parseable before attempting file writes.
2. **Atomic Verification**: Do not run the entire test suite. The `ruby-agent-skills` methodology emphasizes *"focused verification"* [[1]]. Configure the agent to run only the specific RSpec file or Ruby script related to the `current_step`.
3. **Sidecar over Pure Ruby for LLM Calls**: While Ruby gems like `ollama-ruby` exist [[29]], the specified `@nemesis-oss/ollama-sdk` provides superior, built-in `McpBridge` capabilities and structured output enforcement [[1]]. Running it as a local Node.js sidecar service called by your Ruby orchestrator yields the most deterministic results.
4. **Retry Limit**: Implement a hard limit (e.g., 3 retries) per `current_step`. If the model fails to pass verification after 3 attempts, the Orchestrator should flag the step for human intervention rather than degrading the `PROJECT_STATE.md` with compounding errors.

Would you like me to generate the complete TypeScript sidecar code utilizing the `@nemesis-oss/ollama-sdk` and `McpBridge`, or refine the Ruby orchestrator's state-management logic further?

Yes. This can work, and the architecture should be **very different from a normal ReAct agent**.

The core idea is:

> **MiniCPM5-2B should never be responsible for remembering or understanding the whole project. It should only solve one bounded engineering slice at a time. The runtime owns the project state, task graph, memory, context budget, verification, and recovery.**

Your three components fit that model well:

- `ruby-agent-skills` = engineering policy/knowledge
- `ollama-sdk` = model/tool execution layer
- MCP = standardized workspace/tool boundary
- **new long-running host/runtime** = orchestration, memory, context budgeting, checkpoints

I would make the host TypeScript, not Ruby. Your target application can still be Rails/Ruby.

---

# 1. One important correction to the earlier architecture

I would **not** do:

```text
Ruby orchestrator
    ↓
Node sidecar
    ↓
Ollama Agent
```

That adds an unnecessary process boundary.

Instead:

```text
                    Long-Running Agent Runtime
                         TypeScript Host
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
   ruby-agent-skills      ollama-sdk             MCP
   skill knowledge        inference              tools
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                    Project State / Memory
                              │
                     SQLite + filesystem
                              │
                        Git checkpoints
```

`ollama-sdk` already has the pieces needed here: `Agent`, `ToolRegistry`, `McpBridge`, `SkillRegistry`, model capability discovery, `num_ctx`, tool-call limits, and structured output. Your current SDK's `Agent` is deliberately a bounded multi-turn loop, which is exactly what we want **inside one micro-iteration**, not across the lifetime of the project.

The current SDK also automatically uses a 32K context default for tool-enabled agents unless overridden, so we should explicitly override this for MiniCPM rather than letting the SDK decide for us.

---

# 2. MiniCPM5-2B is actually a good fit for this

The current official Ollama distribution is:

```text
openbmb/minicpm5-2b
```

It supports native tool calling and has a 128K model context, but Ollama's published configuration currently defaults `num_ctx` to **4096**. ([Ollama][1])

The upstream model card reports a 131,072-token context capability and specifically positions MiniCPM5-2B for coding agents, tool use, long-context work, and local deployment. ([Hugging Face][2])

That does **not** mean we should use 128K.

For this architecture I would start with:

```yaml
model: openbmb/minicpm5-2b
num_ctx: 16384
num_predict: 2048
```

and benchmark:

```text
8K
12K
16K
24K
32K
```

The objective isn't "maximum context".

The objective is:

> **maximum useful reasoning per token while keeping each iteration predictable.**

---

# 3. The most important architectural decision

## Never run one giant Agent session for the whole project

Bad:

```text
Agent.run()
  ├── task 1
  ├── task 2
  ├── task 3
  ├── task 4
  ├── task 5
  ├── ...
  └── task 200
```

Your SDK `Agent` intentionally keeps:

```typescript
history: Message[] = [...input.messages];
```

and keeps appending assistant/tool messages.

That means the context grows with the iteration history.

Instead:

```text
Project
  │
  ├── Iteration 001 → fresh context → checkpoint
  ├── Iteration 002 → fresh context → checkpoint
  ├── Iteration 003 → fresh context → checkpoint
  ├── Iteration 004 → fresh context → checkpoint
  └── ...
```

Each iteration starts with a **new model context**.

The model does not remember iteration 1.

The runtime remembers iteration 1.

That distinction is fundamental.

---

# 4. The runtime should be the "brain"

I would define these components.

```text
AgentRuntime
├── TaskGraph
├── IterationRunner
├── ContextManager
├── MemoryStore
├── SkillResolver
├── RepositoryIndexer
├── MCPToolManager
├── VerificationEngine
├── GitCheckpointManager
├── RecoveryManager
└── EventLog
```

The LLM is only:

```text
Planner / Implementer / Debugger
```

It is **not**:

```text
database
scheduler
memory
source of truth
task manager
verification engine
context manager
```

---

# 5. Persistent state

Do not use `PROJECT_STATE.md` as the primary database.

Use SQLite.

For example:

```text
.agent/
├── state.db
├── config.yml
├── project.md
├── architecture.md
├── decisions/
├── checkpoints/
└── logs/
```

SQLite:

```text
projects
tasks
iterations
events
memories
facts
decisions
failures
files
verification_runs
checkpoints
```

A task might look conceptually like:

```typescript
interface Task {
  id: string;
  parentId?: string;

  title: string;
  objective: string;

  status:
    | "pending"
    | "ready"
    | "in_progress"
    | "verified"
    | "blocked"
    | "cancelled";

  priority: number;

  targetFiles: string[];
  requiredSkills: string[];

  acceptanceCriteria: string[];
  verificationCommands: string[];

  attempts: number;
  maxAttempts: number;
}
```

---

# 6. Do not let the LLM invent the whole project plan repeatedly

There should be a durable **Task Graph**.

Example:

```text
Build Authentication
│
├── Add User model
│   ├── test User validation
│   └── implement User validation
│
├── Add authentication service
│   ├── define service contract
│   ├── implement service
│   └── add integration tests
│
├── Add sessions
│   ├── migration
│   ├── model
│   ├── controller
│   └── request tests
│
└── Add UI
    ├── login component
    ├── form validation
    └── API integration
```

The model only sees:

```text
Current task:
Implement User email validation.

Parent:
Authentication → User model.

Acceptance:
1. Email required.
2. Email unique.
3. Existing project conventions preserved.

Relevant files:
app/models/user.rb
spec/models/user_spec.rb

Verification:
bundle exec rspec spec/models/user_spec.rb
```

That is manageable for a 2B model.

---

# 7. Micro-iteration design

This is where the system becomes powerful.

One iteration should look like:

```text
ITERATION N
     │
     ▼
Load current task
     │
     ▼
Resolve primary skill
     │
     ▼
Gather repository evidence
     │
     ▼
Build context
     │
     ▼
MiniCPM5-2B
     │
     ├── inspect
     ├── implement
     ├── test
     └── fix
     │
     ▼
Verification
     │
     ├── PASS
     │
     └── FAIL
          │
          ▼
     bounded retry
     │
     ▼
Checkpoint
     │
     ▼
Update task graph
     │
     ▼
Start completely new context
```

I'd cap one micro-iteration at roughly:

```yaml
max_model_turns: 4
max_tool_calls: 8
max_files_changed: 3
max_diff_lines: 150
max_retries: 3
```

Those are policy defaults, not immutable numbers.

---

# 8. Context management is the critical subsystem

This is more important than the agent prompt.

Define:

```typescript
interface ContextBudget {
  maxTokens: number;

  system: number;
  task: number;
  skills: number;
  memory: number;
  repository: number;
  tools: number;
  history: number;
  outputReserve: number;
}
```

For a 16K context:

```text
16,384 total
│
├── system rules             900
├── current task             700
├── skill                    2,500
├── repository state         800
├── code evidence            5,000
├── memory                    800
├── tool schemas             1,000
├── previous iteration       500
└── output reserve           2,184
```

The runtime must refuse to construct a request exceeding the budget.

---

# 9. Do not use naive "load the relevant files"

That will still kill the context.

Instead, context should be constructed in layers.

### Level 0 — always

```text
project summary
current task
acceptance criteria
runtime constraints
recent result
```

### Level 1 — repository evidence

```text
target files
neighboring tests
existing conventions
dependency declarations
relevant routes/models/services
```

### Level 2 — skill

```text
one primary SKILL.md
```

### Level 3 — patterns

```text
only patterns explicitly relevant
```

### Level 4 — references

```text
only when the skill says the reference is relevant
```

This is exactly aligned with the design of your `ruby-agent-skills` repository: the skill itself is the compact execution playbook and deeper knowledge sits behind `references/`.

Your current skill pack is already explicitly designed around progressive disclosure and bounded `SKILL.md` size.

---

# 10. Never load all 93 Ruby skills

Your current pack contains approximately:

```text
93 skills
443 patterns
476 evaluation cases
92 system/contract tests
```

That is excellent as a **knowledge corpus**.

It would be catastrophic as a prompt.

The runtime should do:

```text
task
  ↓
skill-manifest
  ↓
primary skill
  ↓
0–2 patterns
  ↓
optional reference
```

Example:

```text
Task:
Fix ActiveRecord association behavior.

Router:

primary:
rails-associations

secondary:
rails-active-record
ruby-tdd-refactoring
```

But even then, I would normally inject:

```text
rails-associations/SKILL.md
```

and only the specific referenced material needed.

---

# 11. SkillRegistry is useful here

Your `ollama-sdk` already has:

```typescript
SkillRegistry
```

which discovers and loads `SKILL.md`.

That means the runtime does not need to implement another skill loader.

Use:

```typescript
const registry = new SkillRegistry({
  directory: "/path/to/ruby-agent-skills/skills"
});
```

Then:

```text
list()
  ↓
skill routing
  ↓
load(primarySkill)
```

The important part is that **routing happens outside the LLM** whenever possible.

The model should not be given all 93 descriptions and asked:

> "Which skill should I use?"

The runtime can do deterministic matching against:

```text
skill-manifest.yml
ROUTING.md
task keywords
changed files
repository structure
```

and then ask the model to validate the selected skill if necessary.

---

# 12. MCP should be the workspace boundary

MCP 2026-07-28 is a good fit because the host can expose the coding environment through standardized tools.

The current MCP TypeScript SDK exposes tools, resources, and prompts. ([MCP TypeScript SDK][3])

I'd expose something like:

```text
repo.search
repo.read
repo.read_range
repo.patch
repo.diff
repo.test
repo.lint
repo.status
repo.symbol
```

Not:

```text
run_any_shell_command
```

unless you have a strong sandbox.

For an autonomous coding agent, unrestricted shell is a major control-plane hole.

---

# 13. MCP tool output must also be budgeted

This is a subtle but critical problem.

Imagine:

```text
repo.search("User")
```

returns:

```text
800 lines
```

Your LLM context is now blown.

So MCP tools themselves should enforce output caps.

Example:

```typescript
repo.search
  maxMatches = 12
  maxSnippetLines = 8
  maxOutputTokens = 1200
```

`repo.read`:

```typescript
maxLines = 250
```

`repo.read_range`:

```typescript
explicit start/end
```

`repo.diff`:

```typescript
maxDiffLines = 200
```

The tool must return:

```text
TRUNCATED
requested: 430 lines
returned: 120 lines
next_cursor: ...
```

instead of silently dumping everything.

---

# 14. MCP Bridge has one limitation you should account for

Your current `McpBridge` converts:

```text
MCP tools
      ↓
Ollama tools
```

and registers them through `ToolRegistry`.

That is useful.

But it is **not your full context-management system**.

The MCP bridge is fundamentally a tool adapter.

Your runtime should separately manage:

```text
MCP resources
    ↓
ContextManager
    ↓
bounded prompt
```

That gives you:

```text
MCP tools:
  actions

MCP resources:
  durable/contextual information

Runtime SQLite:
  actual long-term memory
```

---

# 15. Important MCP 2026-07-28 detail

Do not build long-term state around MCP sessions.

The 2026-07-28 protocol moved toward a stateless request lifecycle, with server/client interaction carried through each request rather than relying on the old session model. ([Model Context Protocol Blog][4])

So:

```text
MCP session ≠ agent memory
```

Use:

```text
SQLite
+
files
+
git
```

for durable state.

MCP Tasks are useful when an individual tool operation itself becomes asynchronous or long-running; the Tasks extension defines polling via `tasks/get`, updates, and cancellation. ([MCP Tasks Extension][5])

But I would **not** use MCP Tasks as your core agent loop.

The agent runtime should own that.

---

# 16. Memory architecture

I would use five memory types.

## Project memory

Long-lived facts:

```text
Ruby 3.4
Rails 8.x
PostgreSQL
RSpec
Sidekiq
```

## Architecture memory

```text
Authentication lives in app/services/authentication/
API uses JSON
Service objects are preferred for external integrations
```

## Task memory

```text
Current task
Dependencies
Acceptance criteria
Verification command
```

## Failure memory

```text
Attempt 1 failed because:
missing factory

Attempt 2 failed because:
factory references old association
```

But don't permanently inject all failure history.

Only retrieve failures relevant to:

```text
same task
same file
same error
same subsystem
```

## Evidence memory

Store:

```text
file hash
test result
diff
command
exit code
timestamp
```

This is vastly more useful than storing model prose.

---

# 17. Do not build vector memory first

I would **not** start with embeddings.

For a coding agent:

```text
SQLite + FTS5
+
file paths
+
symbols
+
task tags
+
error strings
```

will be easier to debug and more deterministic.

Later:

```text
semantic retrieval
```

can be added when the repository becomes large enough that lexical retrieval becomes weak.

---

# 18. Context should be evidence-driven

Suppose the task is:

```text
Add email uniqueness validation.
```

The context builder should retrieve:

```text
app/models/user.rb
spec/models/user_spec.rb
schema.rb
Gemfile
existing validation examples
```

It should **not** retrieve:

```text
app/controllers/*
app/jobs/*
entire README
all models
all routes
all tests
```

The retrieval algorithm can be:

```text
task
 ↓
target files
 ↓
references from target files
 ↓
tests
 ↓
nearest conventions
 ↓
framework configuration
```

---

# 19. Use an "evidence pack"

Instead of dumping arbitrary context, create a formal structure:

```typescript
interface EvidencePack {
  task: Task;
  repository: RepositorySnapshot;
  skills: SkillEvidence[];
  files: FileEvidence[];
  tests: TestEvidence[];
  recentFailures: FailureEvidence[];
  decisions: DecisionEvidence[];
}
```

Example:

```json
{
  "task": {
    "id": "AUTH-003",
    "objective": "Add unique email validation"
  },

  "skills": [
    {
      "name": "rails-validations"
    }
  ],

  "files": [
    {
      "path": "app/models/user.rb",
      "sha": "...",
      "excerpt": "..."
    }
  ],

  "tests": [
    {
      "command": "bundle exec rspec spec/models/user_spec.rb",
      "lastResult": "failed"
    }
  ]
}
```

This makes the entire process replayable.

---

# 20. Model interaction should be tiny

The MiniCPM prompt should resemble:

```text
You are implementing exactly one bounded engineering task.

Project:
Rails application.

Task:
Add unique email validation to User.

Acceptance criteria:
1. Email is required.
2. Email uniqueness is enforced.
3. Existing conventions remain unchanged.

Primary engineering skill:
rails-validations

Relevant patterns:
pattern:unique-validation-contract

Relevant files:

app/models/user.rb
...

spec/models/user_spec.rb
...

Previous attempt:
Added validation, but test failed because...

Allowed change:
Maximum 3 files.

Required verification:
bundle exec rspec spec/models/user_spec.rb

Do not:
- refactor unrelated code
- modify other domains
- invent missing architecture
- skip verification

Implement only this task.
```

That is the kind of workload a 2B model can repeatedly handle.

---

# 21. Model actions should be constrained

I would define an iteration action contract such as:

```typescript
type IterationIntent =
  | {
      type: "inspect";
      reason: string;
    }
  | {
      type: "implement";
      files: string[];
      summary: string;
    }
  | {
      type: "verify";
      command: string;
    }
  | {
      type: "finish";
      evidence: string[];
    }
  | {
      type: "blocked";
      reason: string;
    };
```

Use structured output for planning/status where appropriate.

Your SDK's `chatWithSchema()` is useful here because the SDK validates and parses the response against a schema.

But this needs one correction from the previous architecture:

> **Schema validation guarantees parseability/type conformance, not that the code is correct.**

Correctness still comes from tests, linting, static analysis and diff inspection.

---

# 22. Verification should be deterministic

The model should never be allowed to say:

```text
Tests should pass.
```

The runtime executes:

```text
bundle exec rspec spec/models/user_spec.rb
```

and stores:

```json
{
  "command": "...",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 2814
}
```

Then:

```text
PASS
```

is an observed fact.

Not an LLM assertion.

This fits your `ruby-agent-skills` philosophy very well: the repository explicitly requires implementation, focused verification, regression verification where applicable, and evidence reporting.

---

# 23. Git should be a hard checkpoint mechanism

After successful verification:

```text
git diff
   ↓
scope check
   ↓
tests
   ↓
commit
```

Example:

```text
iteration-001
    ↓
commit a81e3f

iteration-002
    ↓
commit b92f1a

iteration-003
    ↓
commit 1c42da
```

If the next iteration destroys something:

```text
HEAD = previous verified checkpoint
```

This makes recovery trivial.

I would strongly prefer a dedicated worktree:

```text
project/
.agent/
workspace/
   └── worktree/
```

so the agent never modifies the user's primary checkout accidentally.

---

# 24. Scope enforcement

This should be deterministic.

For every task:

```yaml
max_files: 3
max_additions: 120
max_deletions: 80
max_new_dependencies: 0
max_public_interfaces: 1
```

If MiniCPM generates:

```text
17 files changed
+893
-421
```

the runtime rejects it.

The model receives:

```text
Your proposed change exceeds the task scope.

Allowed:
3 files

Proposed:
17 files

Split the work into smaller coherent changes.
```

This is exactly how you compensate for the limited planning ability of the small model.

---

# 25. Recovery loop

Do not blindly retry.

Use:

```text
Attempt 1
   ↓
failure
   ↓
same task + error
   ↓
Attempt 2
   ↓
failure
   ↓
refresh repository evidence
   ↓
Attempt 3
   ↓
failure
   ↓
BLOCKED
```

Important distinction:

```text
RETRY
```

versus:

```text
REFRESH CONTEXT
```

If the model failed because it misunderstood the code, repeating the exact context is stupid.

The runtime should deliberately retrieve new evidence.

---

# 26. Detect infinite loops

You need a stagnation detector.

For example:

```text
same task
same files
same diff hash
same test failure
3 iterations
```

=> stop.

Also:

```text
no repository mutation
same tool calls
same reasoning outcome
```

=> stop.

And:

```text
task repeatedly expands scope
```

=> split the task.

---

# 27. Long-running state machine

I'd use something like:

```text
BOOTSTRAPPING
    ↓
PLANNING
    ↓
READY
    ↓
CONTEXT_BUILDING
    ↓
IMPLEMENTING
    ↓
VERIFYING
    ├── PASS → CHECKPOINTED
    └── FAIL → RECOVERING
                   ├── RETRY
                   ├── REFRESH
                   └── BLOCKED

CHECKPOINTED
    ↓
NEXT_TASK
    ↓
READY
```

Terminal:

```text
COMPLETE
BLOCKED
ABORTED
```

---

# 28. The complete system

The architecture I'd actually build is:

```text
                       ┌──────────────────────┐
                       │     Agent Runtime    │
                       │      TypeScript      │
                       └──────────┬───────────┘
                                  │
              ┌───────────────────┼──────────────────┐
              │                   │                  │
              ▼                   ▼                  ▼
       ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
       │ Task Graph  │    │ Context      │    │ Memory Store │
       │             │    │ Manager      │    │ SQLite       │
       └─────────────┘    └──────┬───────┘    └──────────────┘
                                  │
                  ┌───────────────┼────────────────┐
                  ▼               ▼                ▼
          ruby-agent-skills    Repository       MCP Resources
               router           Evidence
                  │
                  ▼
            Selected Skill
                  │
                  ▼
            Pattern/Reference
                  │
                  ▼
          ┌────────────────────┐
          │ Context Budgeter   │
          │ hard token ceiling │
          └─────────┬──────────┘
                    │
                    ▼
          ┌────────────────────┐
          │   OllamaClient     │
          │ MiniCPM5-2B        │
          │ num_ctx = 16K      │
          └─────────┬──────────┘
                    │
             max 3–4 turns
                    │
                    ▼
          ┌────────────────────┐
          │    MCP Tools       │
          │ search/read/patch  │
          │ test/lint/diff     │
          └─────────┬──────────┘
                    │
                    ▼
          ┌────────────────────┐
          │ Verification       │
          └─────────┬──────────┘
                    │
             ┌──────┴──────┐
             ▼             ▼
           PASS           FAIL
             │             │
             ▼             ▼
         Git commit     Recovery
             │             │
             └──────┬──────┘
                    ▼
              New iteration
              New context
```

---

# 29. What each of your three projects does

| Component           | Responsibility                                                         |
| ------------------- | ---------------------------------------------------------------------- |
| `ruby-agent-skills` | Ruby/Rails engineering knowledge and routing                           |
| `ollama-sdk`        | Ollama client, structured output, tool execution, skills, MCP bridging |
| MCP                 | Standardized tool/resource boundary                                    |
| **Agent Runtime**   | Long-running orchestration                                             |
| SQLite              | Durable state/memory                                                   |
| Git                 | Recovery/checkpoints                                                   |
| Repository tools    | Deterministic evidence                                                 |
| MiniCPM5-2B         | Local reasoning and implementation                                     |

That separation is clean.

---

# 30. I would add one capability to `ollama-sdk`

Your current SDK is already strong, but this runtime will expose one gap:

## `ContextBudget`

Something conceptually like:

```typescript
interface ContextBudgetOptions {
  maxContextTokens: number;
  reservedOutputTokens: number;

  estimateTokens(input: {
    messages: readonly Message[];
    tools?: readonly ToolDefinition[];
  }): number;

  onBudgetExceeded?: (info: {
    estimatedTokens: number;
    maxTokens: number;
  }) => void;
}
```

Then:

```typescript
client.chat(...)
```

could optionally perform:

```text
context estimation
        ↓
budget validation
        ↓
request
```

Even better:

```typescript
Agent({
  contextBudget: {
    maxTokens: 16384,
    reservedOutputTokens: 2048
  }
})
```

But I would **not** make the SDK own project-memory policies.

That belongs in the long-running runtime.

---

# 31. Exact token counting needs care

This is one place where I would not fake certainty.

A character-based estimator such as:

```text
chars / 3
```

is useful as a conservative heuristic, but it is not a mathematical guarantee.

For a truly hard context ceiling:

```text
MiniCPM tokenizer
        ↓
exact tokenization
        ↓
budget calculation
```

is preferable.

Then `prompt_eval_count` from Ollama can be recorded after the request and used as runtime evidence/calibration. Your SDK already exposes `prompt_eval_count`, `prompt_eval_cached_count`, and `eval_count`.

So the production design should eventually be:

```text
exact tokenizer
+
runtime safety margin
+
observed prompt token metrics
```

rather than pretending a character heuristic is exact.

---

# 32. Elicitation / human intervention

For autonomous operation, you don't want the model constantly asking questions.

But you absolutely want a controlled escalation path:

```text
agent
  ↓
ambiguous requirement
  ↓
NEEDS_HUMAN
  ↓
MCP elicitation
  ↓
answer persisted
  ↓
new iteration
```

The current 2026-07-28 MCP model handles this through `input_required` / multi-round-trip interactions rather than the old server-initiated request model. ([MCP TypeScript SDK][6])

So human interaction becomes another durable state transition rather than breaking the agent runtime.

---

# 33. What I would build first

Do not start by writing a giant autonomous agent.

Build it in these waves.

### Wave 1 — Runtime foundation

```text
AgentRuntime
Task
TaskGraph
SQLite StateStore
Iteration
EventLog
```

### Wave 2 — Repository intelligence

```text
repo.index
repo.search
repo.read
repo.read_range
repo.symbol
repo.diff
```

### Wave 3 — `ruby-agent-skills`

```text
SkillResolver
SkillRegistry
manifest routing
pattern selection
reference loading
```

### Wave 4 — MCP

```text
MCP client
McpBridge
tool registry
resource reader
output limits
```

### Wave 5 — Context engine

```text
ContextBudgeter
EvidencePack
priority-based packing
token accounting
truncation
```

### Wave 6 — MiniCPM micro-agent

```text
fresh Agent per iteration
max 3–4 turns
max 8 tool calls
small output budget
```

### Wave 7 — Verification

```text
test runner
lint runner
diff gate
scope gate
evidence recording
```

### Wave 8 — Recovery

```text
retry
context refresh
stagnation detection
blocked state
human escalation
```

### Wave 9 — Git checkpointing

```text
worktree
commit per verified slice
rollback
resume
```

### Wave 10 — Full autonomous loop

```text
task graph
    ↓
micro-task
    ↓
context
    ↓
MiniCPM
    ↓
implementation
    ↓
verification
    ↓
checkpoint
    ↓
next task
    ↓
...
    ↓
project complete
```

---

# 34. The most important operating rule

The runtime should optimize for:

```text
ONE TASK
ONE SMALL CHANGE
ONE VERIFICATION
ONE CHECKPOINT
ONE NEW CONTEXT
```

Not:

```text
"Build the application."
```

That single architectural decision is what makes a 2B model viable for a long-running coding process.

Your `ruby-agent-skills` repository is already unusually well aligned with this approach because its operating contract explicitly emphasizes repository inspection, selecting applicable skills, incremental implementation, focused verification, simplification, and evidence reporting.

Useful references:

[ruby-agent-skills](https://github.com/shubhamtaywade82/ruby-agent-skills?utm_source=chatgpt.com)
[ollama-sdk](https://github.com/shubhamtaywade82/ollama-sdk?utm_source=chatgpt.com)
[MCP 2026-07-28 introduction](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro?utm_source=chatgpt.com)

## Recommended target

I would make this a **generic `LongRunningCodingAgent` runtime**, with the following core API:

```typescript
const runtime = new CodingAgentRuntime({
  model: "openbmb/minicpm5-2b",
  context: {
    maxTokens: 16_384,
    outputReserve: 2_048,
  },

  skills: {
    root: "./ruby-agent-skills",
  },

  workspace: {
    root: "./target-project",
  },

  limits: {
    maxTurnsPerIteration: 4,
    maxToolCalls: 8,
    maxFilesChanged: 3,
    maxRetries: 3,
  },

  verification: {
    required: true,
  },

  checkpointing: {
    git: true,
  },
});

await runtime.run();
```

The next implementation step should be to build **Wave 1–4 together: the persistent runtime state machine + bounded context engine + Ruby skill resolver + MCP workspace layer**, because those are the pieces that make the MiniCPM loop reliable.

[1]: https://ollama.com/openbmb/minicpm5-2b?utm_source=chatgpt.com "openbmb/minicpm5-2b"
[2]: https://huggingface.co/openbmb/MiniCPM5-2B?utm_source=chatgpt.com "openbmb/MiniCPM5-2B · Hugging Face"
[3]: https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/?utm_source=chatgpt.com "@modelcontextprotocol/server | MCP TypeScript SDK"
[4]: https://blog.modelcontextprotocol.io/posts/2026-07-28/?utm_source=chatgpt.com "The 2026-07-28 Specification | Model Context Protocol Blog"
[5]: https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks?utm_source=chatgpt.com "Tasks | MCP Tasks Extension"
[6]: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28?utm_source=chatgpt.com "Supporting protocol revision 2026-07-28 | MCP TypeScript SDK"

Here is the complete, deterministic implementation of the architecture. It is strictly divided into three components to ensure separation of concerns, enforce small context windows, and leverage the specific capabilities of the tools you selected.

---

### 1. The MCP Server (`mcp-server.ts`)

This server exposes deterministic, low-level operations. It runs independently and communicates via standard I/O (stdio), adhering to the Model Context Protocol standard.

```typescript
// mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const server = new McpServer({ name: "ruby-dev-mcp", version: "1.0.0" });

// Tool 1: Read File (JIT Context Loading)
server.tool("read_file", { path: z.string().describe("Absolute or relative path to the file") }, async ({ path }) => {
  try {
    const content = await fs.readFile(path, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error reading file: ${e.message}` }], isError: true };
  }
});

// Tool 2: Write File (Smallest Coherent Change)
server.tool("write_file", {
  path: z.string().describe("Path to the file"),
  content: z.string().describe("The complete new content of the file")
}, async ({ path, content }) => {
  try {
    await fs.writeFile(path, content, "utf-8");
    return { content: [{ type: "text", text: `Successfully wrote to ${path}` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error writing file: ${e.message}` }], isError: true };
  }
});

// Tool 3: Focused Verification (ruby-agent-skills principle)
server.tool("run_shell", {
  command: z.string().describe("The exact shell command to run, e.g., 'rspec spec/user_spec.rb'")
}, async ({ command }) => {
  try {
    // Timeout prevents infinite hangs from small models generating bad commands
    const { stdout, stderr } = await execAsync(command, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return { content: [{ type: "text", text: stdout || stderr || "Command executed successfully with no output." }] };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Command failed.\nStdout: ${e.stdout}\nStderr: ${e.stderr}\nError: ${e.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server initialized and listening on stdio");
}

main().catch(console.error);
```

---

### 2. The TypeScript Sidecar (`sidecar.ts`)

This component bridges the MCP server and the `minicpm5-2b` model using `@nemesis-oss/ollama-sdk`. It uses the `McpBridge` to dynamically register MCP tools and enforces a strict Zod schema to guarantee the small model outputs machine-parseable actions.

```typescript
// sidecar.ts
import express from "express";
import { OllamaClient, Agent, ToolRegistry, McpBridge } from "@nemesis-oss/ollama-sdk";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
app.use(express.json());

// Initialize Ollama Client
const ollamaClient = new OllamaClient({
  baseUrl: process.env.OLLAMA_HOST || "http://localhost:11434"
});

async function createAgentWithMcpTools() {
  // 1. Connect to the local MCP Server
  const mcpClient = new Client({ name: "ollama-sidecar-client", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["ts-node", "mcp-server.ts"] // Ensure ts-node is installed, or use compiled JS
  });
  await mcpClient.connect(transport);

  // 2. Use McpBridge to convert MCP descriptors to Ollama SDK tools
  const mcpBridge = new McpBridge(mcpClient);

  // 3. Define a strict schema for the final output to ensure deterministic parsing by Ruby
  const ActionSchema = z.object({
    file_path: z.string().describe("The single file to create or update"),
    new_content: z.string().describe("The complete, valid new content of the file"),
    verification_command: z.string().describe("A focused command to verify this specific change, e.g., 'ruby -c app/models/user.rb' or 'rspec spec/user_spec.rb'")
  });

  // 4. Create a "submit" tool that forces the LLM to output matching the schema
  const submitTool = {
    name: "submit_final_action",
    description: "Call this EXACTLY ONCE when you have determined the file changes and verification command needed to complete the current step.",
    parameters: ActionSchema,
    execute: async (args: z.infer<typeof ActionSchema>) => {
      return { status: "submitted", data: args };
    }
  };

  // 5. Register both MCP tools and the submit tool
  const registry = new ToolRegistry([
    ...await mcpBridge.getOllamaTools(), // Converts MCP tools to SDK format
    submitTool
  ]);

  // 6. Initialize Agent with strict iteration limits to prevent context bloat
  return new Agent(ollamaClient, { tools: registry, maxIterations: 6 });
}

let agentPromise: Promise<Agent> | null = null;

app.post("/execute", async (req, res) => {
  try {
    const { prompt, model = "minicpm5-2b" } = req.body;

    if (!agentPromise) {
      agentPromise = createAgentWithMcpTools();
    }
    const agent = await agentPromise;

    const response = await agent.run({
      model,
      messages: [{ role: "user", content: prompt }],
      // Enable thinking/reasoning tokens if the specific MiniCPM variant supports it
      think: true
    });

    // Extract the deterministic payload from the submit tool call
    const submitCall = response.toolCalls.find((tc: any) => tc.name === "submit_final_action");

    if (submitCall && submitCall.result?.status === "submitted") {
      res.json({ success: true, action: submitCall.result.data });
    } else {
      res.status(400).json({
        success: false,
        error: "Agent failed to converge on a valid final action within the iteration limit.",
        raw_trace: response.toolCalls.map((tc: any) => ({ name: tc.name, result: tc.result }))
      });
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sidecar running deterministically on port ${PORT}`));
```

---

### 3. The Enhanced Ruby Orchestrator (`orchestrator.rb`)

This script manages the macro-state, enforces the `ruby-agent-skills` workflow (Classify → Route → Implement → Verify), and prevents context overflow via a sliding memory window.

```ruby
# orchestrator.rb
require 'json'
require 'net/http'
require 'uri'

class AgenticOrchestrator
  MAX_RETRIES_PER_STEP = 3
  SIDECAR_URL = ENV.fetch('SIDECAR_URL', 'http://localhost:3000/execute')
  MODEL = ENV.fetch('OLLAMA_MODEL', 'minicpm5-2b')

  def initialize(state_path)
    @state_path = state_path
    @state = load_state
  end

  def run
    puts "Starting agentic loop for: #{@state['overall_goal']}"

    until @state['current_step'].nil? || @state['completed']
      execute_iteration
    end

    puts "Process finished. Final State:"
    puts JSON.pretty_generate(@state)
  end

  private

  def load_state
    if File.exist?(@state_path)
      JSON.parse(File.read(@state_path))
    else
      {
        "overall_goal" => "Build a Ruby CLI tool that fetches weather data",
        "completed_steps" => [],
        "current_step" => "Initialize the project with a Gemfile and basic directory structure",
        "active_files" => ["Gemfile", "lib/weather_cli.rb"],
        "retry_count" => 0,
        "completed" => false
      }
    end
  end

  def save_state
    File.write(@state_path, JSON.pretty_generate(@state))
  end

  def execute_iteration
    step = @state['current_step']
    puts "\n--- Executing Step: #{step} (Attempt #{@state['retry_count'] + 1}/#{MAX_RETRIES_PER_STEP}) ---"

    # 1. JIT Context Gathering (Prevents context window overflow)
    context_snippets = @state['active_files'].map do |file|
      content = File.exist?(file) ? File.read(file) : "<FILE DOES NOT EXIST YET>"
      "### FILE: #{file}\n#{content}"
    end.join("\n\n")

    # 2. Construct Minimal, Directive Prompt (Aligned with ruby-agent-skills)
    prompt = <<~PROMPT
      You are a Ruby expert agent. Follow the rule: "Implement the smallest coherent change".

      OVERALL GOAL: #{@state['overall_goal']}
      RECENTLY COMPLETED: #{@state['completed_steps'].last(3).join(" | ") || "None"}
      CURRENT STEP: #{step}

      RELEVANT FILES (Read these before acting):
      #{context_snippets}

      INSTRUCTIONS:
      1. Use the `read_file` tool if you need to see files not listed above.
      2. Determine the exact code change required.
      3. Use the `write_file` tool to apply the change.
      4. Use the `run_shell` tool to verify the change (e.g., `ruby -c` or a specific `rspec` command).
      5. Once verified, call `submit_final_action` with the file path, new content, and the verification command you used.
    PROMPT

    # 3. Delegate to TS Sidecar
    response = call_sidecar(prompt)

    # 4. Evaluate Result and Update State
    if response['success']
      action = response['action']

      # Double-check: The sidecar's MCP already wrote the file, but we update active_files for the next loop
      @state['active_files'] = [action['file_path']].uniq

      # Advance state
      @state['completed_steps'] << "Completed: #{step}"
      @state['completed_steps'] = @state['completed_steps'].last(5) # Sliding window memory
      @state['current_step'] = @state['next_steps']&.shift # Assuming you populate this, or set to nil to finish
      @state['retry_count'] = 0 # Reset retries on success

      if @state['current_step'].nil?
        @state['completed'] = true
        puts "✅ All steps completed successfully."
      end
    else
      @state['retry_count'] += 1
      if @state['retry_count'] >= MAX_RETRIES_PER_STEP
        puts "❌ Max retries reached for step: #{step}. Halting for human intervention."
        @state['current_step'] = "HALTED: #{step}. Manual review required."
      else
        # Inject error context back into the next iteration's prompt
        @state['current_step'] = "#{step}\n\nPREVIOUS ERROR: #{response['error']}. Analyze this error and fix it."
        puts "⚠️ Verification failed. Retrying with error context..."
      end
    end

    save_state
  end

  def call_sidecar(prompt)
    uri = URI(SIDECAR_URL)
    req = Net::HTTP::Post.new(uri)
    req.content_type = 'application/json'
    req.body = { prompt: prompt, model: MODEL }.to_json

    begin
      response = Net::HTTP.start(uri.hostname, uri.port) do |http|
        http.request(req)
      end
      JSON.parse(response.body)
    rescue StandardError => e
      { "success" => false, "error" => "Sidecar connection failed: #{e.message}" }
    end
  end
end

# Execution
# orchestrator = AgenticOrchestrator.new('project_state.json')
# orchestrator.run
```

---

### 4. Execution Protocol

To run this stack deterministically:

1. **Install Dependencies**:

   ```bash
   # For the TypeScript sidecar and MCP server
   npm install express zod @nemesis-oss/ollama-sdk @modelcontextprotocol/sdk
   npm install -D ts-node typescript @types/node @types/express

   # Ensure Ollama is running and the model is pulled
   ollama pull minicpm5-2b
   ```

2. **Start the Stack**:

   ```bash
   # Terminal 1: Start the TypeScript Sidecar (it will spawn the MCP server internally)
   npx ts-node sidecar.ts

   # Terminal 2: Run the Ruby Orchestrator
   ruby orchestrator.rb
   ```

### 5. Why This Architecture is Deterministic

1. **Context Containment**: The Ruby orchestrator never sends the whole codebase to the LLM. It sends only `active_files`, strictly bounding the token count for `minicpm5-2b`.
2. **Schema Enforcement**: The `submit_final_action` tool, backed by Zod in the `ollama-sdk`, guarantees that the LLM cannot output free-form text that breaks the Ruby parser. It must output the exact JSON structure.
3. **Bounded Loops**: The `maxIterations: 6` in the Agent and `MAX_RETRIES_PER_STEP = 3` in Ruby prevent infinite, context-bloating loops if the model hallucinates.
4. **Focused Verification**: Aligning with `ruby-agent-skills`, the agent is forced to run a specific, narrow verification command (e.g., `rspec spec/x.rb`) rather than a full suite, keeping shell output small and actionable.

The design is directionally correct, but I would **not call this a complete deterministic long-running implementation yet**. It is a useful prototype, but there are several hard correctness gaps that will prevent it from reliably completing a real application with MiniCPM5-2B.

I checked the current `ruby-agent-skills` and `ollama-sdk` implementations and verified the current MCP TypeScript SDK / 2026-07-28 direction as well.

## Verdict

Your intended architecture should be:

```text
                  LONG-RUNNING CODING RUNTIME
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
   Task Graph          Context Engine     Persistent Memory
        │                  │                  │
        └──────────────┬───┴──────────────────┘
                       ▼
                ruby-agent-skills
                       │
                       ▼
                  ollama-sdk
                       │
                       ▼
                MiniCPM5-2B
                       │
                       ▼
                      MCP
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        read         patch        inspect
          │            │            │
          └────────────┼────────────┘
                       ▼
                  Deterministic
                  Verification
                       │
                 PASS / FAIL
                       │
                       ▼
                    Git
                  checkpoint
                       │
                       ▼
                NEW ITERATION
```

The biggest difference from your implementation is:

> **The runtime, not the LLM, owns planning state, context limits, verification, task progression, and recovery.**

---

# 1. There are currently compile/API mismatches

This is the most immediate problem.

Your code uses:

```typescript
await mcpBridge.getOllamaTools()
```

but your current `ollama-sdk` does not expose `getOllamaTools()`.

The actual bridge API includes:

```typescript
bridge.listTools()
bridge.definitions()
bridge.loadTools()
bridge.register(registry)
```

So this:

```typescript
const tools = await mcpBridge.getOllamaTools();
```

needs to become something based on:

```typescript
const tools = await mcpBridge.loadTools();
```

or:

```typescript
await mcpBridge.register(registry);
```

depending on how you want to construct the registry.

The current SDK's `ToolRegistry` also expects tools with:

```typescript
name
description
schema
execute
definition
```

Your `submitTool` only supplies:

```typescript
name
description
parameters
execute
```

so it does not conform to the SDK's actual tool contract.

Your SDK already provides `defineTool()`, which is the correct way to construct it.

---

# 2. `AgentResult` is being read incorrectly

This is another hard failure.

Your code does:

```typescript
response.toolCalls
```

and:

```typescript
tc.name
tc.result
```

But the current SDK's `AgentResult` is:

```typescript
{
  finalMessage,
  turns,
  totalIterations
}
```

There is no top-level:

```typescript
response.toolCalls
```

And a `ToolCall` is shaped like:

```typescript
{
  id,
  function: {
    name,
    arguments
  }
}
```

The execution result is stored separately in `AgentTurn.toolResults`.

So your extraction logic cannot work as written.

More importantly, I would **remove this extraction mechanism entirely**.

---

# 3. Do not use `submit_final_action` as proof of completion

This is a conceptual flaw.

Right now you are effectively doing:

```text
LLM
 ↓
write_file
 ↓
run_shell
 ↓
submit_final_action
 ↓
Ruby trusts response
```

That is not deterministic.

The model is merely claiming:

> "I believe this is the final action and verification passed."

The runtime must independently establish:

```text
file actually changed
+
diff is within policy
+
verification command actually passed
+
repository is in expected state
```

So the proper protocol is:

```text
MiniCPM
   ↓
propose change
   ↓
runtime applies change
   ↓
runtime verifies
   ↓
runtime decides PASS/FAIL
```

Not:

```text
MiniCPM
   ↓
claims PASS
```

---

# 4. The model must not choose arbitrary verification commands

This is the largest security problem in the implementation.

You currently give it:

```typescript
run_shell(command)
```

and explicitly tell it to generate:

```text
verification_command
```

That allows MiniCPM to potentially produce:

```bash
rm -rf ...
git reset --hard
curl ...
npm install ...
bundle exec ...
```

or anything else the operating-system user can execute.

For a long-running autonomous coding system, that is too much authority.

Instead, the runtime should own verification.

For example:

```typescript
interface VerificationPlan {
  allowedCommands: string[];
  workingDirectory: string;
}
```

For a Rails task:

```text
ruby -c app/models/user.rb
bundle exec rspec spec/models/user_spec.rb
bundle exec rubocop app/models/user.rb
```

The model can **request** verification, but the runtime chooses the actual command.

Even better:

```text
MCP:
  test_rspec
  test_ruby
  lint_rubocop
  git_diff
```

instead of a generic:

```text
run_shell
```

---

# 5. `read_file` and `write_file` need a workspace boundary

Currently:

```typescript
fs.readFile(path)
fs.writeFile(path)
```

allows arbitrary paths.

That means the model could theoretically access:

```text
/etc/*
~/.ssh/*
.env
other projects
credentials
```

The server should receive exactly one workspace root:

```text
/workspaces/project
```

and every path must resolve inside it.

Conceptually:

```typescript
resolveWorkspacePath(workspaceRoot, requestedPath)
```

and reject:

```text
../../
absolute paths outside root
symlink escapes
```

This should be deterministic and tested.

---

# 6. `write_file` should not be the primary mutation primitive

Your implementation does:

```text
write entire file
```

That is dangerous for a small model.

MiniCPM can accidentally regenerate a whole file and destroy unrelated behavior.

Instead I would expose:

```text
read_file
read_range
search
apply_patch
diff
```

and make:

```text
apply_patch
```

the preferred mutation operation.

The model should produce something like:

```diff
@@
 class User < ApplicationRecord
+  validates :email, presence: true
 end
```

The runtime applies it.

Then:

```text
git diff
```

becomes the authoritative mutation evidence.

This also dramatically reduces output tokens.

---

# 7. Your context is not actually bounded yet

This is the most important issue for your original objective.

You claim:

> active_files bounds the context.

It does not.

You currently have:

```text
Ruby state
 +
active_files
 +
prompt
 +
MCP tool outputs
 +
Agent message history
 +
tool definitions
 +
thinking
 +
model output
```

Your current `ollama-sdk` `Agent` intentionally maintains:

```typescript
const history: Message[] = [...input.messages];
```

and then appends every assistant/tool turn.

Therefore:

```text
maxIterations: 6
```

does **not** mean:

```text
6 × bounded contexts
```

It means:

```text
one growing context
with up to 6 turns
```

That is precisely what you don't want.

---

# 8. The solution: one Agent = one micro-iteration

This is the architectural change I consider mandatory.

Do:

```text
Iteration 1
  Agent.run()
  destroy context

Iteration 2
  Agent.run()
  destroy context

Iteration 3
  Agent.run()
  destroy context
```

Do not do:

```text
Agent.run()
 ├── task 1
 ├── task 2
 ├── task 3
 └── task 4
```

Your SDK's `Agent` is a **turn-loop**, not a project-long memory engine.

Use it as:

```text
micro-implementation worker
```

and put the long-term loop around it.

---

# 9. The runtime needs an actual context budgeter

Do not just say:

```typescript
num_ctx: 16384
```

That only tells Ollama the maximum context capacity.

It doesn't prevent you from constructing a terrible prompt.

You need:

```typescript
class ContextBudgeter {
  maxTokens: number;

  build(evidence: EvidencePack): Context;
}
```

For example:

```text
16,384 tokens
────────────────────────
System rules       1,000
Task                 600
Skill              2,500
Patterns             700
Repository state     700
Code evidence      4,500
Memory               800
Tool definitions   1,200
Output reserve     4,384
────────────────────────
Total             16,384
```

The actual allocation should be configurable.

And eventually you want **actual MiniCPM tokenizer counting**, not a crude character estimate.

Ollama exposes prompt token metrics in responses, and your SDK already preserves those metrics, so you can calibrate the runtime against actual usage.

---

# 10. MiniCPM's official Ollama ID should be explicit

The current official Ollama model is:

```text
openbmb/minicpm5-2b
```

and Ollama currently documents:

- ~2.5B parameters
- native tool calling
- 128K native context
- default `num_ctx` of 4096
- Think / No-Think support
- coding-agent/tool-use positioning ([Ollama][1])

So I would use:

```yaml
model: openbmb/minicpm5-2b
```

rather than:

```yaml
model: minicpm5-2b
```

unless you deliberately create a local alias.

And despite the model's 128K capability, I would still start much smaller:

```text
8K
12K
16K
```

and benchmark from there.

---

# 11. MCP is appropriate, but your MCP layer is too primitive

The current MCP TypeScript SDK supports stdio transport for local child processes, and the 2026-07-28 protocol line is now represented in the SDK v2 architecture. ([MCP TypeScript SDK][2])

Your choice of:

```text
Sidecar
  ↓
StdioClientTransport
  ↓
MCP server
```

is technically reasonable.

But don't stop at:

```text
read_file
write_file
run_shell
```

For a coding agent, I'd rather have:

```text
workspace.read
workspace.readRange
workspace.search
workspace.symbol
workspace.applyPatch
workspace.diff

verification.ruby
verification.rspec
verification.rubocop

git.status
git.diff
git.checkpoint
```

The model gets a much smaller and safer tool surface.

---

# 12. Do not use MCP as your memory system

This remains an architectural rule.

Use:

```text
MCP
  = external capability boundary
```

Use:

```text
SQLite
  = persistent agent state
```

Use:

```text
Git
  = code checkpoint/recovery
```

Use:

```text
files
  = human-readable project state / artifacts
```

The new MCP architecture also has explicit support for server/client interactions such as elicitation, and 2026-07-28 changes how request state is handled; those should not be confused with durable application memory. ([MCP TypeScript SDK][3])

---

# 13. Your Ruby orchestrator is still too simplistic

This part:

```ruby
@state['current_step'] = @state['next_steps']&.shift
```

is not a real task graph.

Your default state doesn't even define `next_steps`.

So your example effectively becomes:

```text
step 1
 ↓
nil
 ↓
completed
```

That is not long-running project completion.

You need:

```text
TaskGraph
```

with dependencies.

Example:

```text
TASK-001 Create Rails app
TASK-002 Add User model
  depends_on TASK-001

TASK-003 Add authentication service
  depends_on TASK-002

TASK-004 Add session controller
  depends_on TASK-003

TASK-005 Add request tests
  depends_on TASK-004
```

Then the runtime asks:

```text
What tasks are READY?
```

rather than asking the model to decide everything.

---

# 14. `active_files` should be generated from evidence

Currently:

```ruby
@state['active_files']
```

is manually maintained.

That won't scale.

Instead:

```text
Task
 ↓
target files
 ↓
repository graph
 ↓
related tests
 ↓
related configuration
 ↓
minimal evidence pack
```

For example:

```text
Task:
Modify User validation

Evidence:
app/models/user.rb
spec/models/user_spec.rb
db/schema.rb

Not:
app/controllers/users_controller.rb
app/services/*
app/jobs/*
all specs
```

---

# 15. Sliding memory is not enough

This:

```ruby
completed_steps.last(5)
```

is useful as a display aid, but weak as actual memory.

You need typed memory.

```text
PROJECT_FACT
ARCHITECTURE_DECISION
TASK_RESULT
FAILURE
VERIFICATION
FILE_FACT
DEPENDENCY_FACT
HUMAN_DECISION
```

For example:

```json
{
  "type": "failure",
  "task_id": "AUTH-003",
  "error_signature": "RSpec::MockExpectationError",
  "files": ["spec/services/authentication_spec.rb"],
  "resolution": "Use existing session factory"
}
```

Then retrieve memory by relevance.

Don't keep injecting the last 100 model messages.

---

# 16. The runtime needs a stagnation detector

Suppose MiniCPM produces:

```text
attempt 1 → same error
attempt 2 → same error
attempt 3 → same error
```

You should detect:

```text
same task
same files
same diff
same test failure
```

and stop.

A useful fingerprint is:

```text
hash(
  task_id +
  relevant_file_hashes +
  failing_test +
  normalized_error
)
```

If the same failure fingerprint repeats, don't waste another model call with identical evidence.

---

# 17. Retry should refresh evidence

Your current strategy is:

```text
error → append error to prompt → retry
```

Better:

```text
failure
 ↓
classify failure
 ↓
refresh repository evidence
 ↓
inspect failing file
 ↓
inspect associated test
 ↓
inspect dependency/convention
 ↓
new context
 ↓
MiniCPM
```

That makes retry meaningfully different.

---

# 18. Verification must happen outside the sidecar

This is another architectural boundary I would change.

Currently:

```text
sidecar
  ├── model
  ├── MCP
  └── verification
```

Instead:

```text
Runtime
  ├── task
  ├── context
  ├── model call
  ├── mutation
  ├── verification
  └── checkpoint
```

The model worker should return:

```typescript
{
  status: "implemented",
  changedFiles: [...],
  summary: "..."
}
```

Then the runtime executes the deterministic verification plan.

---

# 19. The final result should be evidence-based

A successful iteration should produce something like:

```json
{
  "iterationId": "iter_0042",
  "taskId": "AUTH-003",

  "filesChanged": [
    "app/models/user.rb",
    "spec/models/user_spec.rb"
  ],

  "diffStats": {
    "files": 2,
    "additions": 8,
    "deletions": 1
  },

  "verification": [
    {
      "command": "bundle exec rspec spec/models/user_spec.rb",
      "exitCode": 0,
      "durationMs": 2148
    }
  ],

  "status": "verified",

  "checkpoint": {
    "commit": "a81c92..."
  }
}
```

This is the memory that matters.

---

# 20. I'd change the tool contract substantially

Instead of:

```text
read_file
write_file
run_shell
submit_final_action
```

I'd use:

```text
inspect_repository
read_file
read_range
search_code
apply_patch
inspect_diff
```

and let the runtime expose verification as deterministic operations.

The model does:

```text
inspect
 ↓
reason
 ↓
patch
 ↓
inspect diff
```

Runtime does:

```text
verify
 ↓
checkpoint
```

---

# 21. Elicitation belongs in the runtime state machine

For genuine ambiguity:

```text
MiniCPM
 ↓
cannot safely infer requirement
 ↓
NEEDS_INPUT
 ↓
MCP elicitation
 ↓
persist answer
 ↓
new iteration
```

The current MCP client APIs explicitly support server-initiated elicitation handlers, and the 2026-07-28 protocol has a newer multi-round-trip interaction model. ([MCP TypeScript SDK][3])

That fits your long-running architecture nicely.

---

# 22. The architecture I would actually implement

I'd drop the Ruby/sidecar split and build one TypeScript runtime:

```text
coding-agent-runtime/
│
├── src/
│   ├── runtime/
│   │   ├── agent-runtime.ts
│   │   ├── iteration-runner.ts
│   │   └── state-machine.ts
│   │
│   ├── tasks/
│   │   ├── task-graph.ts
│   │   ├── task-store.ts
│   │   └── scheduler.ts
│   │
│   ├── context/
│   │   ├── context-budgeter.ts
│   │   ├── evidence-builder.ts
│   │   ├── token-counter.ts
│   │   └── packer.ts
│   │
│   ├── memory/
│   │   ├── memory-store.ts
│   │   ├── retrieval.ts
│   │   └── fingerprints.ts
│   │
│   ├── skills/
│   │   ├── resolver.ts
│   │   └── router.ts
│   │
│   ├── mcp/
│   │   ├── client.ts
│   │   ├── workspace.ts
│   │   └── verification.ts
│   │
│   ├── model/
│   │   └── micro-agent.ts
│   │
│   ├── verification/
│   │   ├── verifier.ts
│   │   ├── policy.ts
│   │   └── evidence.ts
│   │
│   └── checkpoint/
│       └── git.ts
│
├── .agent/
│   ├── state.db
│   ├── config.yml
│   └── logs/
│
└── target-project/
```

---

# 23. The actual loop

The loop becomes:

```text
while project not complete

  task = taskGraph.nextReadyTask()

  skill = skillResolver.resolve(task)

  evidence = repositoryAnalyzer.gather(task)

  memory = memoryStore.retrieve(task, evidence)

  context = contextBudgeter.build(
    task,
    skill,
    evidence,
    memory
  )

  result = microAgent.run(
    model: openbmb/minicpm5-2b,
    context: context
  )

  validateScope(result)

  applyMutation(result)

  verification = verifier.run(task)

  if verification.pass
    checkpoint()
    markTaskVerified()
  else
    recordFailure()
    recoverOrBlock()

end
```

That is the real long-running architecture.

---

# 24. Recommended MiniCPM configuration

I'd start with:

```yaml
model: openbmb/minicpm5-2b

context:
  max_tokens: 16384
  output_reserve: 2048

agent:
  max_iterations: 4
  max_tool_calls: 8

iteration:
  max_files_changed: 3
  max_diff_lines: 150

retry:
  max_attempts: 3

verification:
  required: true

checkpoint:
  enabled: true
```

And then benchmark `8192`, `12288`, and `16384`.

The official model supports considerably more context, but there is no reason to consume the full 128K just because it exists. Ollama itself currently defaults the model to a 4096 context and documents increasing it when longer inputs are needed. ([Ollama][1])

---

# 25. What your three repositories become

This is the clean separation I would preserve:

### `ruby-agent-skills`

```text
WHAT SHOULD A GOOD RUBY/RAILS ENGINEER DO?
```

It already has the correct concepts:

```text
Discover
Inspect
Route
Implement incrementally
Test
Verify
Report evidence
```

and progressive disclosure via `SKILL.md` + `references/`.

### `ollama-sdk`

```text
HOW DO WE TALK TO THE MODEL?
```

Provides:

```text
OllamaClient
Agent
ToolRegistry
Structured outputs
SkillRegistry
McpBridge
telemetry
timeouts
tool validation
```

### MCP

```text
HOW DOES THE MODEL/RUNTIME ACCESS THE ENVIRONMENT?
```

Provides standardized:

```text
tools
resources
prompts
elicitation
transport
```

The current MCP TypeScript SDK specifically separates MCP host/client functionality from the server/tool implementations, with stdio available for local spawned processes. ([MCP TypeScript SDK][2])

### New runtime

```text
HOW DOES THE WHOLE PROJECT GET COMPLETED OVER HUNDREDS OF SMALL ITERATIONS?
```

That is the missing component.

---

# Bottom line

Your implementation is **a good proof of concept, but not yet the long-running architecture you originally described**.

The critical changes are:

| Area             | Current              | Required                                         |
| ---------------- | -------------------- | ------------------------------------------------ |
| Agent lifetime   | multi-turn request   | **one micro-iteration**                          |
| Long-term memory | sliding JSON         | **SQLite typed memory**                          |
| Planning         | `next_steps` array   | **dependency-aware task graph**                  |
| Context          | active files         | **hard-budget EvidencePack**                     |
| Verification     | model chooses shell  | **runtime-owned verification policy**            |
| Mutation         | full `write_file`    | **patch/diff-first**                             |
| Security         | arbitrary filesystem | **workspace sandbox**                            |
| Security         | arbitrary shell      | **restricted verification tools**                |
| Completion       | model submits        | **runtime observes evidence**                    |
| Recovery         | append error         | **failure classification + refreshed evidence**  |
| Progress         | text list            | **persistent task/iteration state**              |
| Checkpoint       | absent               | **Git checkpoint per verified slice**            |
| MCP              | tool bridge only     | **tools + resources + elicitation where useful** |

The **most important implementation milestone is not the MCP server or sidecar**. It is the **runtime/context engine**. Once that exists, `ruby-agent-skills` + `ollama-sdk` + MCP become clean plug-ins to it.

I would implement the next version as **`coding-agent-runtime` in TypeScript**, using your existing `ollama-sdk` rather than modifying the SDK's `Agent` into a project-long agent. That preserves the SDK's current boundaries and gives MiniCPM5-2B a fresh, aggressively bounded context on every iteration.

