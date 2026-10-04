# Sessions

## Fresh vs reuse

Default (`session: "fresh"`): every turn opens a new ACP session and sends the
whole history. Correct and slow.

`session: "reuse"`: one ACP session per conversation, only the delta since the
last turn is sent. Measured on `copilot --acp`: per-turn latency ~3x lower and
flat instead of growing with the conversation. It brings no extra memory —
under `fresh`, the replayed history already carries the information.

```jsonc
{ "command": "copilot", "args": ["--acp"], "session": "reuse" }
```

## How a conversation is recognised

`LLMRequest` carries no session id, so recognition uses two levels:

1. **Index key** — `sha256(agent + cwd + model + first message)`. Stable as the
   conversation grows; it finds the live session in O(1).
2. **Continuity proof** — the turn resumes only if the received history exactly
   extends what the session already got, message by message. Any gap closes the
   session and starts a fresh one with the whole history.

| Case | Result |
| --- | --- |
| Normal next turn | Delta sent, session reused |
| Edited message, fork, prepend | Fresh session, whole history |
| `/compact` (rewrites the head) | Fresh session, old one closed |
| Model, `cwd` or agent change | Fresh session |
| Cancelled turn, dead agent | Session poisoned, closed; next turn starts fresh |
| Pool full (8 sessions per agent) | Least recently used closed, unless it carries a turn |

Two requests on the same conversation queue FIFO (ACP refuses two concurrent
prompts on one session). Different conversations run in parallel. Only the
history is deltafied — system, tools and output contract are resent in full
every turn. Sessions close on plugin unload.

## Token counting

Under `reuse`, some agents report a cumulative `input` instead of the real
window (measured ~4.4x on `copilot --acp`). The UI would show a context that
does not exist and compact too early. The reducer substitutes the window the
agent announces itself via `usage_update`, but only past a 2x gap — `fresh`
sits at ~1x and passes through untouched, and agents with no `usage_update`
are forwarded as-is. Only the input total is corrected; `output` stays the
agent's.

## Cancellation

`Esc` stops the turn within a few hundred ms: the agent gets `session/cancel`,
the stream ends with no orphan `finish`, and the session and process stay
usable. Under `reuse`, a cancelled turn still closes the ACP session — its
memory may have stopped mid-turn, so resuming it would corrupt the context
silently. Losing one `session/new` beats that.

## Agent recovery

The agent is a subprocess and can die anytime. Recovery depends on when:

| When | Result |
| --- | --- |
| `session/new`, `set_config_option` | Agent replaced silently, turn replays |
| Same failure twice | Reported; a command that cannot start must not respawn forever |
| Refused value (unknown model) | Reported at once with accepted values, never retried |
| During `session/prompt` | Reported, turn not replayed — tools may already have run |

Evicting an agent also closes its `reuse` pool: a session belongs to the
process that created it.
