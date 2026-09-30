## Built for you *and* your AI coding agent

Not a human-facing Terminal UI with an API bolted on after the fact — the
agent-facing surface is a first-class citizen.

- `vibestackr init` hands an agent the job of writing your config in the first place.
- `vibestackr mcp` lets an agent read status/logs, restart a service, or trigger a shortcut mid-session, without leaving its own context.
- `vibestackr config "add a postgres docker instance and make the java service depend on it"` updates your config file using your installed agent CLI.

Your agent can now write code, restart the running service, check the status, read the logs (including a progress bar or prompt that hasn't printed a newline yet), debug the issue, and iterate.
