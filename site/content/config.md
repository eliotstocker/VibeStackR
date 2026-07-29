## One YAML file, your whole stack

<!-- CONFIG_GUIDE_START -->
```yaml
name: MyApp
services:
  - name: postgres
    cwd: .
    command: sh
    args: ["-c", "docker start myapp-postgres 2>/dev/null || docker run -d --name myapp-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16"]
    oneShot: true
    liveness: { type: command, command: docker exec myapp-postgres pg_isready -U postgres }
  - name: api
    cwd: api
    command: npm
    args: ["run", "dev"]
    note: http://localhost:4000
    dependsOn: ["postgres"]
    liveness: { type: http, url: http://localhost:4000/health }
```
<!-- CONFIG_GUIDE_END -->

**Every field, every check type, and full examples are in the [complete configuration guide →](config-details.html)**
