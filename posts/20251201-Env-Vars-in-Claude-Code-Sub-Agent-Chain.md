---
title: Env Vars in Claude Code Sub-Agent Chain
date: 2025-12-01 16:00
prenote: This article was written based on Claude Code v2.0.55.
---

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)'s [sub-agent](https://code.claude.com/docs/en/sub-agents) system is powerful for breaking down complex tasks, but there's a gap: environment variables set in a parent agent don't automatically propagate to child sub-agents. This article presents a hooks-based solution that enables environment variable inheritance across the entire agent chain.

## The Problem

Consider this scenario: you ask Claude Code to set an environment variable and then spawn a sub-agent, expecting the sub-agent to read that variable:

```
USER: Hi! Please set env var MYSTERY to 42 and then spawn a sub-agent and ask
them to check what value they have in their MYSTERY env var.
```

The sub-agent won't see `MYSTERY=42`. Sub-agents are separate processes — when Claude Code spawns one, it creates a new instance with a fresh environment. Variables set in the parent exist only in that parent's memory space and don't propagate to children created later.

This creates friction in agent orchestration. Without variable inheritance, passing context and parameters to sub-agents requires either including them in downstream prompts or adding instructions to sub-agent workflows — both of which **waste inference time and tokens**.

## The Solution: A File-Based Environment Stack

The key insight is to use the filesystem as a shared state mechanism, combined with Claude Code's [hooks](https://docs.claude.com/en/docs/claude-code/hooks) system to manage the lifecycle. Here's the high-level approach:

1. **A working directory** (`.claude/env-vars/`) stores environment variable files
2. **A helper script** writes variables to the current env file
3. **Hooks** manage the stack of env files and inject them into Bash commands

Hooks are shell commands that Claude Code executes automatically at specific lifecycle events — when the user submits a prompt, before a tool runs, or when a sub-agent completes. They can inspect and modify tool inputs, block actions, or perform side effects. This makes them ideal for injecting our environment variable logic at exactly the right moments.

The "stack" is crucial for nested sub-agents. When a root agent spawns a sub-agent (level 1), which then spawns another sub-agent (level 2), we need separate env files for each level. The stack ensures that:

- Each agent writes to its own file (avoiding conflicts)
- All agents see variables from parent agents (via sourcing all files in order)
- When an agent completes, only its file is removed (preserving parent state)

## Implementation

### Directory Structure

```
your-project/
  .claude/
    settings.local.json
    env-vars/
      env-vars1
      env-vars2
      ...
    hooks/
      user-prompt-submit.sh
      pre-tool-use-task.sh
      pre-tool-use-bash.sh
      subagent-stop.sh
  setenv.sh
```

### Hook Configuration

In `.claude/settings.local.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "./.claude/hooks/user-prompt-submit.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Task",
        "hooks": [
          {
            "type": "command",
            "command": "./.claude/hooks/pre-tool-use-task.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./.claude/hooks/pre-tool-use-bash.sh"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "./.claude/hooks/subagent-stop.sh"
          }
        ]
      }
    ]
  }
}
```

The hooks serve distinct purposes:

- [**UserPromptSubmit**](https://docs.claude.com/en/docs/claude-code/hooks#hook-events): Fires when the user sends a message; we use it to reset state for new conversations
- [**PreToolUse**](https://docs.claude.com/en/docs/claude-code/hooks#hook-events)(Task): Fires before spawning a sub-agent; we push a new env file onto the stack
- **PreToolUse**(Bash): Fires before every Bash command; we inject env vars by modifying the command
- [**SubagentStop**](https://docs.claude.com/en/docs/claude-code/hooks#hook-events): Fires when a sub-agent completes; we pop its env file from the stack

### The Hooks

#### **1. UserPromptSubmit Hook - Session Reset**

This hook clears the working directory when a new user prompt is submitted, ensuring a fresh start:

```bash
#!/bin/bash
# Hook: UserPromptSubmit - clears env-vars directory

if [ -d ".claude/env-vars" ]; then
    rm -rf .claude/env-vars
fi
```

This reset ensures that each new conversation starts with a clean slate.

#### **2. PreToolUse(Task) Hook - Stack Push**

When a sub-agent is spawned, create a new env file for that level:

```bash
#!/bin/bash
# Hook: PreToolUse(Task) - adds new env file for sub-agent

if [ ! -d ".claude/env-vars" ]; then
    exit 0
fi

# Find the last env file number and create the next one
last_file=$(ls -1 .claude/env-vars/env-vars* 2>/dev/null | sort -V | tail -1)

if [ -z "$last_file" ]; then
    next_num=1
else
    last_num=$(basename "$last_file" | sed 's/env-vars//')
    next_num=$((last_num + 1))
fi

touch ".claude/env-vars/env-vars${next_num}"
```

#### **3. PreToolUse(Bash) Hook - Environment Injection**

This hook prepends sourcing of all env files to _every Bash command_:

```bash
#!/bin/bash
# Hook: PreToolUse(Bash) - injects env vars into commands

if [ ! -d ".claude/env-vars" ]; then
    exit 0
fi

envvars_files=$(ls -1 .claude/env-vars/env-vars* 2>/dev/null | sort -V)
if [ -z "$envvars_files" ]; then
    exit 0
fi

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
    exit 0
fi

# Build source prefix for all env files
source_prefix=""
for envvars_file in $envvars_files; do
    source_prefix="${source_prefix}set -a; source \"$envvars_file\"; set +a; "
done

new_command="${source_prefix}${command}"

jq -n --arg cmd "$new_command" '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {"command": $cmd}
  }
}'
```

If a child agent redefines a parent's variable, the child's value takes precedence. Since we source files in order (parent first, then children), later assignments override earlier ones.

#### **4. SubagentStop Hook - Stack Pop**

When a sub-agent completes, remove its env file:

```bash
#!/bin/bash
# Hook: SubagentStop - removes the sub-agent's env file

if [ ! -d ".claude/env-vars" ]; then
    exit 0
fi

last_file=$(ls -1 .claude/env-vars/env-vars* 2>/dev/null | sort -V | tail -1)

if [ -n "$last_file" ]; then
    rm "$last_file"
fi
```

This implements a classic stack "pop" operation — the last file always belongs to the most recently spawned sub-agent.

### The Setenv Script

A helper script to write variables to the current agent's env file:

```bash
#!/bin/bash
# Sets a variable in the current agent's env file
# Usage: ./setenv.sh VAR_NAME "value"

if [ $# -lt 2 ]; then
    echo "Usage: $0 VAR_NAME value" >&2
    exit 1
fi

var_name="$1"
var_value="$2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$SCRIPT_DIR/.claude/env-vars"

last_file=$(ls -1 "$SCRIPT_DIR/.claude/env-vars"/env-vars* 2>/dev/null | sort -V | tail -1)

if [ -z "$last_file" ]; then
    last_file="$SCRIPT_DIR/.claude/env-vars/env-vars1"
    touch "$last_file"
fi

if grep -q "^${var_name}=" "$last_file" 2>/dev/null; then
    sed -i "s|^${var_name}=.*|${var_name}=${var_value}|" "$last_file"
else
    echo "${var_name}=${var_value}" >> "$last_file"
fi
```

Don't forget to make this script executable: `chmod +x ./setenv.sh`. All hook scripts in `.claude/hooks/` also need execute permissions.

## Example

Here's a conversation demonstrating the environment variable inheritance:

```bash
[USER]
"Set MYSTERY to 42 using setenv.sh, then spawn a sub-agent. The sub-agent
 should check the MYSTERY value, set ANOTHER to 67, then complete. After that,
 check if ANOTHER is still available."

   [AGENT]
   "I'll set MYSTERY and spawn a sub-agent."
   $ ./setenv.sh MYSTERY 42
   "Now spawning a sub-agent to check MYSTERY and set ANOTHER..."

      [SUB-AGENT]
      $ echo $MYSTERY
      42
      $ ./setenv.sh ANOTHER 67
      $ echo $ANOTHER
      67
      # Task complete.

   [AGENT]
   "The sub-agent confirmed MYSTERY=42 and set ANOTHER=67. Let me check if
    ANOTHER persists:"
   $ echo $ANOTHER
   # (empty)
```

As expected, `ANOTHER` is not available. When the sub-agent completed, its env file (containing `ANOTHER=67`) was removed by the SubagentStop hook. Only the parent's variables persist.

## Conclusion

We achieved transparent environment variable inheritance across the agent hierarchy without modifying prompts or wasting tokens on parameter passing. The stack-based approach correctly handles nested sub-agents and ensures proper cleanup when agents complete.

Note that this solution is simplified and supports only one Claude Code session at a time.
