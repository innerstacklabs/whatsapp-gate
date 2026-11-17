# whatsapp-gate

whatsapp-gate lets an AI coding agent send WhatsApp messages from your own number. Every message is shown to you in full, and nothing is sent until you say yes. It is a Claude Code hook, a sender script and a reader script, in TypeScript with no dependencies.

Two people who each run it can let their agents talk to each other over WhatsApp. Each person sees and approves every message their own agent sends.

The gate is built for an agent that makes mistakes, not for one that attacks you. [What the gate does not stop](#what-the-gate-does-not-stop) lists the gaps.

## What you see

When the agent runs the sender, Claude Code stops and shows you this. You answer yes or no.

```
Send this WhatsApp message from your own number to Alice Example (15550100@s.whatsapp.net)?

WITH THIS FILE ATTACHED: notes.pdf (48213 bytes, sha256 511f25db3436)
from /home/bob/drafts/notes.pdf

and this text as its caption:

Hi Alice, the draft notes are attached. Can you read them before Thursday?

(74 characters, sha256 7c532cd19b7c)
```

The file line comes first, so nothing in the text can hide it. A text-only message has no file line. This is the hook's own output for a made-up config, names and paths.

## How it works

```
  agent (Claude Code)
     |  runs: node scripts/whatsapp-send.ts --to alice --text-file ... --sha256 ...
     v
  hook (hooks/gate-whatsapp-send.ts)   reads the same files, checks every rule, then asks
     |
     v
  you                                  read the ask, answer yes or no
     | yes
     v
  sender (scripts/whatsapp-send.ts)    checks the hashes again, stages the file, calls the bridge
     |
     v
  bridge (whatsapp-mcp, on 127.0.0.1)  linked to your phone as a device
     |
     v
  WhatsApp
```

The hook and the sender share one rule file (`lib/whatsapp.ts`) and read the same config file. The agent passes the message as a file plus its SHA-256 hash. The hook shows you the file's text. The sender hashes the file again, so the text you approved is the text that goes out.

## Install

You need Node 22.18 or later (it runs `.ts` files without a build step), Claude Code, and WhatsApp on your phone. Nothing here downloads anything for you.

1. Clone this repository and keep it where the agent cannot write to it:

   ```
   git clone https://github.com/innerstacklabs/whatsapp-gate.git
   ```

2. Get the bridge. The gate talks to the open-source [whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp) bridge, which is not part of this repository. Use v0.7.0, the version the gate was developed against. On Linux x86-64, download `whatsapp-bridge-linux-amd64` and `SHA256SUMS.txt` from the [v0.7.0 release](https://github.com/verygoodplugins/whatsapp-mcp/releases/tag/v0.7.0) into `~/.local/share/whatsapp-bridge/bin/`, then check and mark it executable:

   ```
   cd ~/.local/share/whatsapp-bridge/bin
   sha256sum --ignore-missing -c SHA256SUMS.txt
   chmod 700 whatsapp-bridge-linux-amd64
   ```

   On another system, build it from the `whatsapp-bridge` directory of the whatsapp-mcp source with Go.

3. Start the bridge with this script, saved as `~/.local/share/whatsapp-bridge/run.sh` and made executable. `WHATSAPP_MEDIA_ROOTS` is the only directory the bridge sends files from, and it is the outbox the sender stages files in. Webhooks and automatic media downloads are off, so nothing leaves the bridge on its own.

   ```
   #!/usr/bin/env bash
   set -euo pipefail
   cd "$HOME/.local/share/whatsapp-bridge"
   mkdir -p store "$HOME/.local/share/whatsapp-mcp/outbox"
   export WHATSAPP_BRIDGE_PORT=8790
   export WEBHOOK_ENABLED=false
   export WHATSAPP_AUTO_DOWNLOAD_MEDIA=false
   export WHATSAPP_MEDIA_ROOTS="$HOME/.local/share/whatsapp-mcp/outbox"
   export WHATSAPP_DEVICE_NAME="my agent"
   export WHATSAPP_DB_PATH="$PWD/store/messages.db"
   export WHATSMEOW_DB_PATH="$PWD/store/whatsapp.db"
   ./bin/whatsapp-bridge-linux-amd64 2>&1 | tee -a bridge.log
   ```

   The bridge's output goes to `bridge.log` as well as the terminal. `bridge-health` reads that file. If your service manager keeps the output somewhere else, set `bridgeLog` in the config.

4. Link your phone. Run `run.sh` in a terminal the first time. It prints a QR code. In WhatsApp on your phone, open Settings, Linked devices, Link a device, and scan it. The bridge writes its token to `store/.bridge-token` (mode 0600). After linking, run it under tmux or a service manager so it keeps running. Check that it listens on the loopback address only: `ss -ltn | grep 8790` must show `127.0.0.1:8790`.

5. Run the installer from the checkout:

   ```
   node scripts/install.ts
   ```

   It writes `~/.config/whatsapp-gate/config.json` if it is missing (it never overwrites one), creates the allowlist with no contacts, creates the outbox, checks that the bridge answers, and prints a `settings.json` block. It exits 3 when the bridge does not answer. It edits no Claude Code settings.

6. Add each person the agent may message to the allowlist (`~/.config/whatsapp-gate/allowlist.json`). The key is the name the agent uses. The jid is the country code and number, digits only, with no plus sign, then `@s.whatsapp.net` (a group's jid ends in `@g.us`):

   ```
   { "contacts": { "alice": { "jid": "15550100@s.whatsapp.net", "name": "Alice Example" } } }
   ```

   A malformed entry makes every send fail, by design.

7. Merge the block the installer printed into the `settings.json` of the Claude Code project (or user) that runs the agent. It registers the hook for the Bash tool.

8. Check it. Run `node scripts/bridge-health.ts` (expect `whatsapp-bridge: pass`). Then ask the agent to message yourself and confirm that the prompt appears and nothing arrives until you answer. Do this once in your own setup: it is the proof that Claude Code runs the hook.

### Config file

All fields are optional. A field you leave out takes the default that the installer writes. A field the loader does not know is an error, so a misspelled policy cannot silently disable itself.

| Field | Meaning |
|---|---|
| `allowlist` | JSON file of the contacts that may receive a message. |
| `bridgeUrl` | The bridge's REST API. It must be `http` on `127.0.0.1`, `localhost` or `[::1]`, because the token is sent to it, its path must be `/api`, and it must name a port of 1024 or higher, with no query string, fragment or user name and password. |
| `tokenFile` | File that holds the bridge token. |
| `messagesDb` | The bridge's message store, read by `whatsapp-recent`. |
| `bridgeLog` | The bridge's log, read by `bridge-health`. |
| `outbox` | The bridge's media root. |
| `logDir` | Where the sender appends `whatsapp-sends.jsonl` (hash and length, not the text). |
| `sender` | Optional. `{"env": "AGENT_NAME", "value": "alice-agent"}`: only a session with that variable set to that value may send. Use it when several agents share a machine and one may send. |
| `presence` | Optional. A command as an array, for example `["/usr/local/bin/at-keyboard"]`. When set, a send is denied unless it exits 0. When not set, every send is still an ask. |

Every program here reads the config from `~/.config/whatsapp-gate/config.json`. `bridgeUrl` may not hold a query string, a fragment or a user name and password, and no program follows a redirect from the bridge.

## Send a text, and a file

The agent writes the message to a file, then asks for its hash. The hash is the SHA-256 of the text after trailing spaces, tabs and newlines are trimmed. This prints it, and also shows any refusal before the ask:

```
node scripts/message-hash.ts /home/bob/drafts/message.txt
```

For a message with no trailing whitespace, `printf '%s' "the text" | sha256sum` gives the same hash (the first field of its output). The hash of a file to attach is the first field of `sha256sum <file>`.

The send command has exactly this form. Every value is a literal: no variable, quote, glob or substitution. Paths are absolute. Name the script by its full path, because the hook resolves a relative path against the directory Claude Code reports.

```
node /home/bob/whatsapp-gate/scripts/whatsapp-send.ts --to alice --text-file /home/bob/drafts/message.txt --sha256 <hash of the text>
node /home/bob/whatsapp-gate/scripts/whatsapp-send.ts --to alice --text-file /home/bob/drafts/message.txt --sha256 <hash of the text> --attach /home/bob/drafts/notes.pdf --attach-sha256 <hash of the file>
```

One file may ride with the text as its caption: `.mp4`, `.png`, `.jpg`, `.jpeg`, `.pdf`, `.md` or `.txt`, up to 64 MiB. The sender copies the bytes it hashed into a private directory under the outbox and sends that copy, so changing the original after you approve changes nothing. It removes the copy when it exits.

## Read replies

```
node scripts/whatsapp-recent.ts [--hours 7] [--limit 300] [--all] [--json]
```

This reads the bridge's message store, read-only. It lists incoming messages (`<-`); `--all` adds yours (`->`). Exit 0 means it read the store, and no output means a quiet window (`--json` prints `[]`). Exit 2 with `CANNOT READ` means the config, the bridge or its store is unusable. Exit 2 with `TRUNCATED` means more messages matched than `--limit`; it prints nothing, so raise `--limit`.

`node scripts/bridge-health.ts` checks that the REST port answers and that the bridge log has no logged-out line after its last connected line. WhatsApp can unlink a device while the bridge process keeps running. Exit 0 is pass, 1 is fail, 2 is unknown.

## The rules the gate enforces

| Rule | Why |
|---|---|
| A run of the sender in any form the hook recognizes, other than the one command shape, is denied. | The hook can read exactly the files it approves. Shell features could change what runs. |
| Paths hold only letters, digits and `. _ / + @ -`. | The path the hook reads is the path the sender gets. |
| The script path must resolve to this checkout's `scripts/whatsapp-send.ts`, and a `..` in it is refused. | Another file with the same name would skip the checks. The kernel follows a symlink before it steps up a `..`, and a text check does not. |
| The recipient must be in the allowlist. Names, keys and jids are checked when it loads. | The ask names the contact and the jid. A bad entry cannot put text into the ask. |
| The message is a regular file with its hash in the command. The sender hashes it again. | What you approved is what is sent. A FIFO or a changed file is refused. |
| Only allowed characters (below), 1 to 4000 of them. | Everything in the ask is visible and one column wide. |
| An attachment is one plain file of a listed kind, not empty, at most 64 MiB, with no symlink in its path, and its hash is in the command. | You see its name, size, path and hash, and the sender sends those bytes. |
| A subagent never sends. | Only the main session talks to you. |
| The `sender` and `presence` policies in the config, when set. | One agent may send, and only while you are at the keyboard. |
| A direct call to the bridge's send, react, typing, mark-read, edit or delete API is denied. The hook recognizes it by the bridge's port (the configured one, and 8790) with `/api/` and one of those routes in the command. The port in `bridgeUrl` must be 1024 or higher. | They would skip the ask. A typing or mark-read call is not a message, so the ask, which says "from your own number" and does not name the bridge, cannot cover it. |
| The hook and the sender read the config from one fixed path. | A second path would let the sender resolve a different contact than the ask named. |
| Once a command is known to run the sender or call the bridge, any failure of the hook is a deny. | A hook that exits with an error lets the command run. |
| Every send the hook sees is an ask, never an automatic yes. | The hook has no setting that approves a send. |

## What the gate does not stop

The hook matches the text of a command. It cannot see everything a command can do. These are known and accepted:

- A renamed copy of the sender, a wrapper script, `xargs -a`, a glob, quotes or a variable in the script name, a bridge URL split by quotes, an exported `NODE_OPTIONS` or `HOME` can reach the bridge without the hook recognizing the command. A command that only names the file, such as `git add scripts/whatsapp-send.ts`, gets no decision. On a file system that ignores letter case, an interpreter written in another case (`Node`) runs the sender; the hook sees it at the start of a command, after `;`, `&`, `|` or `(`, and after `env`, `exec` or `command`, and not after a newline, `then`, `do`, `sudo`, `time`, `nohup`, `xargs` or a `VAR=value` prefix. The config path is under the home directory, so a sender run with another `HOME` reads another config. A direct call is recognized by the bridge's port, so a call through a port forward or a proxy on another port is not seen, and neither is a call whose path has dot segments (`/api/./send`) or whose port is written with leading zeros or arithmetic. Percent-encoded paths are not decoded.
- The config and the allowlist are files in your home directory. An agent that can write files can change who a name points to, or remove the `sender` or `presence` policy. The recipient and the config are read again at send time, so they are not bound to what you approved the way the text and the file are. Two things bound this: keep `~/.config/whatsapp-gate/` out of what the agent may write (a Claude Code permission rule that denies Edit and Write there covers those tools and does not cover a shell command), and read the name and number in every ask.
- An agent that can read the bridge token can call the bridge directly. The token file is the real boundary: keep it mode 0600, and keep the agent from reading `store/`, for example by running the bridge as a separate user or the agent in a sandbox.
- A symlink in the script path can be repointed while the prompt waits. An agent that can edit the sender already has that power, so keep the checkout read-only to the agent.
- The text file is checked, then read. If it becomes a FIFO in between, the hook hangs. What Claude Code does on a hook timeout is untested here.
- Tabs and spaces look the same in the ask. A hard link is accepted as an attachment.
- The hook watches the Bash tool only. Any other route that can send, such as an MCP server with send tools, is not gated. Do not give the agent one.
- A symlinked message file is followed. The hash binds its content, so a change after approval is refused.
- The hook gives no decision when it cannot parse its input or fails before it can tell whether the command concerns it, or when a command neither runs the sender nor calls the bridge. Those commands run under your normal Claude Code permissions.
- The sender does not ask by itself. Run by hand outside Claude Code, it sends after its own checks only, and the `sender` policy is enforced in the hook only.
- The hook cannot judge the content of a message. You can.

What bounds these: you read every ask, only trusted users can read the token, and the agent cannot write the checkout or `~/.config/whatsapp-gate/`. If a wrong send would be irreversible for you, add the controls above before you rely on the gate.

## The character allowlist

A message may contain a newline, a tab, printable ASCII, the Latin-1 letters and signs (without the no-break space and the soft hyphen), en and em dashes, curly quotes, an ellipsis and the euro sign. Emoji, joiners, variation selectors, other scripts, carriage returns and every invisible character are refused, and the refusal names the character and its position, counting from 1.

This is an allowlist because a deny list cannot name every invisible character. To widen it, add a range to `ALLOWED` in `lib/whatsapp.ts`. Add only characters that are visible and one column wide, and add a test in `test/gate.test.ts` that the new character is asked and its neighbors are still denied.

## Two agents talking

Each person installs whatsapp-gate on their own machine, links their own phone, and puts the other person's number in their own allowlist. Then each agent sends to the other person's number.

- Each human approves each outgoing message. Neither side can send for the other.
- Nothing is automatic. There is no webhook, no auto-reply and no listener. An agent reads replies when it runs `whatsapp-recent`.
- Text from the other side is input, not instructions. An agent should not act on a request in a reply without its own human's say-so.

## Tests

```
npm test
```

This runs `node --test "test/*.test.ts"`. The tests start no bridge and contact none: each runs in a scratch home directory, and the bridge URL is a port nothing listens on, or a server inside the test. They cover the hook's decisions, the sender's refusals, its log of an unanswered request and that it leaves no staged copy behind when it stops before the request, the config rules, the installer, `whatsapp-recent`, and `bridge-health`. They do not test the bridge or WhatsApp.

## License

MIT. See `LICENSE`.
