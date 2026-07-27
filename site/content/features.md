### Dependency-ordered startup

Declare `dependsOn` between services; vibestackr starts each only once what it depends on is actually ready, not just spawned.

---

### Real liveness checks

Port, HTTP, or command checks flip a service to *ready* — no arbitrary sleeps, no guessing when the API can take traffic.

---

### One-shot steps

Migrations, builds, one-off docker runs — mark them `oneShot` and they run to completion instead of being treated as long-running.

---

### Keyboard shortcuts

Restart a service or run an arbitrary command without leaving the TUI — bind it once in config, use it every session.

---

### Background & reattach

Detach the TUI and the stack keeps running as a daemon; run `npx vibestackr` again from anywhere in the project to reattach.

---

### Per-service logs

Every service gets its own scrollback tab, with an optional `--persist-logs` if you want them on disk too.
