---
title: Claude Code Agent Chaining with Async Interventions
date: 2025-12-17 12:00
prenote: This article was written based on Claude Code v2.0.70. The full example is available in its <a href="https://github.com/iotalambda/claude-code-async-chain#readme">GitHub repo</a>.
---

The [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) allows building deeply nested sub-agent chains. An agent spawns a sub-agent, which spawns a sub-sub-agent, which spawns a sub-sub-sub-agent – each level delegating work downward. But what if a sub-agent deep down needs to ask something from the user?

Claude Code has an [AskUserQuestion](https://code.claude.com/docs/en/settings#tools-available-to-claude) tool, but it can't be used by sub-agents, only the main one.

Even if we could surface inquiries through the chain, it would be even more useful if every agent in the chain could end their turn while waiting for the user to respond (they might need hours or days), and then resume later from wherever the work was left.

## A Custom Spawn Convention

The idea is to define a simple convention in `CLAUDE.md` that agents follow. We create a `_spawn_` keyword that starts a sub-agent via a custom CLI (simplified here – see [the repo](https://github.com/iotalambda/claude-code-async-chain) for full implementation):

```markdown
## Actions

| Keyword             | Action                                         |
| ------------------- | ---------------------------------------------- |
| _spawn_ `{f}.md`    | Run `$PWD/agent-cli spawn $PWD/{f}.md`         |
| _terminate_ "{msg}" | Stop immediately, reply exactly "{msg}"        |
| _ask_ "{q}"         | Create question.md, then terminate with signal |
```

The CLI wraps the Agent SDK's `query()` function:

```typescript
async function spawn(instructionFile: string): Promise<void> {
  const prompt = `Read ${instructionFile} and follow its instructions.`
  const { output, sessionId } = await runAgent(prompt)
  console.log(formatOutput(output, sessionId))
}
```

Now we can create a 4-deep chain with simple instruction files:

```markdown
# ins1-a.md (Agent)

_spawn_ `ins2-sa.md`, then _terminate_ with the sub-agent's reply.

# ins2-sa.md (Sub-agent)

_spawn_ `ins3-ssa.md`, then _terminate_ with the sub-agent's reply.

# ins3-ssa.md (Sub-sub-agent)

_spawn_ `ins4-sssa.md`, then _terminate_ with the sub-agent's reply.

# ins4-sssa.md (Sub-sub-sub-agent)

_ask_ "When is your birthday?", then _terminate_ with the answer.
```

When the deepest agent needs to wait, it terminates with `SGN_PEND_STARTED`. Each parent sees this signal and propagates it upward. Every agent in the chain **ends their turn right there**.

The signals follow a simple protocol:

- `SGN_PEND_STARTED` – "I started waiting for something." Propagates upward, each agent stores its sub-agent's session ID before passing the signal up.
- `SGN_PEND_ONGOING` – "Still waiting." When resumed, if the wait condition isn't met yet, this bubbles up unchanged.
- `SGN_RESUME` – "Check if you can proceed." Sent downward on resume. Each agent forwards it to its sub-agent until reaching the one that's waiting.

When an agent receives `SGN_RESUME`, it checks: did I already finish? Then return my previous result. Was I waiting for something? Check if it's ready. Was my sub-agent pending? Forward `SGN_RESUME` to them. (See the [full SOP in CLAUDE.md](https://github.com/iotalambda/claude-code-async-chain/blob/main/CLAUDE.md?plain=1#standard-operating-procedure-sop).)

## Cracks in the Chain

Claude Code [started supporting resumable sub-agents in v2.0.60](https://www.reddit.com/r/ClaudeAI/comments/1phj60q/news_resumable_subagents_in_claude_code_v2060/), but only natively. So that doesn't help our custom Agent SDK based `_spawn_` – we need our own way to resume. Why not use native sub-agents? Because [sub-agents via the Task tool cannot spawn further sub-agents](https://www.reddit.com/r/ClaudeAI/comments/1maeefc/se_puede_ejecutar_un_agente_dentro_de_un/?tl=en), so the max depth would be 2, and we must go deeper.

The naive solution is straightforward – just resume the session:

```typescript
async function resume(sessionId: string): Promise<void> {
  const { output, sessionId: newId } = await runAgent("SGN_RESUME", sessionId)
  console.log(formatOutput(output, newId))
}
```

The flow works: we send `SGN_RESUME`, each agent checks if it can proceed, and either the result or `SGN_PEND_ONGOING` bubbles back up.

But there's a problem. If resume is called multiple times – say, polling every minute to check if the user has responded – each attempt adds messages to every agent's context, wasting tokens:

```
Attempt 1: SGN_RESUME → SGN_PEND_ONGOING
Attempt 2: SGN_RESUME → SGN_PEND_ONGOING
Attempt 3: SGN_RESUME → SGN_PEND_ONGOING
...
```

Poll 50 times and you've added 100 messages to each agent. **The context explodes.**

[Conversation compacting](https://code.claude.com/docs/en/costs#reduce-token-usage) would help, but then you risk losing actual important details from earlier – the original instructions, intermediate results, things the agent needs to remember.

## Better Solution: Fork on Resume

The [Claude Agent SDK supports session forking](https://platform.claude.com/docs/en/agent-sdk/sessions#forking-sessions) – creating a new branch from an existing session _without modifying the original_:

```typescript
async function resume(sessionId: string): Promise<void> {
  const { output, sessionId: forkedId } = await runAgent("SGN_RESUME", sessionId, { fork: true })
  console.log(formatOutput(output, forkedId))
}
```

Every resume creates a fork. What happens to it depends on the outcome:

- **If still pending** (`SGN_PEND_ONGOING`): The fork is _discarded_. We return the original session ID, keeping the checkpoint clean for the next attempt.

- **If progress was made**: The fork becomes the _new checkpoint_. We return the forked session ID for future resumes.

- **If a new pending started**: Some agent in the chain started pending for something new, so `SGN_PEND_STARTED` bubbles up with fresh session IDs on all levels. We return the forked session ID as the new checkpoint.

The `formatOutput` function handles this logic:

```typescript
function formatOutput(output: string, sessionId: string): string {
  if (output.includes("SGN_PEND_ONGOING")) {
    return "SGN_PEND_ONGOING" // Discard fork, keep original
  }
  if (output.includes("SGN_PEND_STARTED")) {
    return `SGN_PEND_STARTED (${sessionId})` // New checkpoint
  }
  return output // Actual result, fork kept
}
```

Now you can poll as aggressively as you want. Each unsuccessful attempt is just a throwaway fork and the original session's token budget is not wasted.

## Achievements

1. **Arbitrarily deep agent chains** – not limited to the native 2-level depth
2. **Async interventions** – sub-agents can pause for external input
3. **Full end turn/resume** – agents can end their turn and resume later
4. **Polling w/o wasting $$$** – fork-based resumption prevents context pollution

The `question.md` centered approach in the example is simplified for demonstration, and probably shouldn't be hard-coded in `CLAUDE.md`.
