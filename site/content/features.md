### Dependency-ordered startup

Declare `dependsOn` between services, and on installed tools.

---

### Real liveness checks

Port, HTTP, or command checks flip a service to *ready*.

---

### One-shot steps

Migrations, builds, one-off docker runs — mark them `oneShot` and they run to completion instead of being treated as long-running.

---

### Keyboard shortcuts

Restart a service or run an arbitrary command with a shortcut key, or from your agent. Need a value at run time? Prompt for it with a text box, or a dropdown of fixed `options`.

---

### Background & reattach

Detach the UI and the stack keeps running as a daemon; run `npx vibestackr` again from anywhere in the project to reattach.

---

### Per-service logs

Every service gets its own scrollback tab, with an optional `--persist-logs` if you want them on disk too. Progress bars and spinners redraw in place instead of repeating a line per frame, and a line still being written shows up live.
