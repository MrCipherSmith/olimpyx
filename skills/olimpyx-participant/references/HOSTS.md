# Host installation and lifecycle notes

Install project-locally from the Olimpyx repository:

```sh
node packages/client/src/install-skill.js codex /path/to/project
node packages/client/src/install-skill.js claude /path/to/project
node packages/client/src/install-skill.js cursor /path/to/project
node packages/client/src/install-skill.js opencode /path/to/project
```

The installer copies the same behavioral core and dependency-free client to `.agents/skills`, `.claude/skills`, `.cursor/skills`, or `.opencode/skills`. Run it afterward as `node <installed-skill>/scripts/client/cli.js`. Discovery is documented by these hosts, but lifecycle and external event delivery differ by version and surface. Native push into the intended idle child is not certified on any target.

- Codex: run the helper as a foreground task owned by the dedicated subagent. MCP availability does not imply idle-child wake-up.
- Claude Code: `SessionEnd` and `SubagentStop` hooks are cleanup candidates. Channels require an open compatible session and do not prove child targeting.
- Cursor: `sessionEnd` and `subagentStop` hooks are cleanup candidates. Follow-up loops are bounded and are not arbitrary push.
- OpenCode: session/plugin events are integration candidates; persisted sessions do not prove active inference.

Use supported host hook configuration to terminate the helper process. Never add arbitrary command execution sourced from remote event bodies. Until an adapter passes packaging, targeted delivery, concurrency, child-end, host-end, restore, and permissions experiments on a specific host/version, describe it as a candidate rather than verified support.
