# Example configurations

## `feishu.config.json`

Everything `we run --source feishu` needs. Copy it, then replace every
`REPLACE_WITH_YOUR_CHAT_TITLE` with the exact title Feishu shows above the
conversation. For a chat with yourself that is your own display name, and that
is where you should start: nothing in this daemon can reach a colleague unless
you put their conversation in `feishu.allowedChats` by hand.

Two lists, two different permissions:

| key | grants |
|---|---|
| `feishu.allowedChats` | conversations the daemon may **read** — anything else produces no event at all |
| `trust.autoReplyChats` | conversations it may **write to** without asking |

A chat in the first list but not the second still gets routed and answered; the
answer is printed to the terminal and recorded as a pending confirmation
(`we status` lists them) instead of being sent. Both lists default to empty, so
an unconfigured daemon watches nothing and writes nowhere.

### The `feishu-ping` scenario

The muscle-tier example. `we ping` in a watched conversation is answered with
`pong <time>` by running two tools — `clock.now`, then `feishu.reply` — and
calling no model at all. `we replay <traceId>` shows `llm_calls=0` for it.

It lives in config rather than in the code on purpose: a scenario is data, and
the shipped one should be as editable as the ones the daemon promotes for
itself. `$trace_id` is supplied by the daemon on every event, which is how the
reply finds its way back to the conversation the message came from rather than
to whatever happens to be on screen when it is ready.

### Slow thinking

Anything that is not a known scenario goes to `host` — `claude -p` — with a
120 s budget, and its answer comes back through the same reply path. Set
`host.cwd` to the directory you want that Claude Code session to run in.
