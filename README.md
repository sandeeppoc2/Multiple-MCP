# Overall MCP

Four MCP servers in one configuration, side by side:

| Server | Transport | What it unlocks |
|---|---|---|
| **Figma** | HTTP (remote) | Read design context from Figma files — frames, components, variables |
| **Playwright** | stdio (local) | Drive a real browser: navigate, click, fill, screenshot, read console/network |
| **Snyk** | stdio (local) | Security scans — SCA, SAST, IaC, containers, secrets, SBOM |
| **GitHub** | HTTP (remote) | Repos, issues, pull requests, code search across your account |

`[.mcp.json](.mcp.json)` is the deliverable. Everything else supports it.

## Remote vs local - the one distinction to understand

MCP has two transport types, and this config deliberately uses both:

| | **REMOTE** (`"type": "http"`) | **LOCAL** (stdio, no `"type"`) |
|---|---|---|
| Who runs the code | A vendor's server, someone else's machine | Your MCP client starts a child process here |
| How they talk | HTTPS over the network | JSON-RPC over stdin/stdout |
| To install | Nothing | A package, into `node_modules` |
| Auth | Bearer token or OAuth | Whatever the local tool uses |
| Works offline | No | Yes |
| Version pinned | No - the vendor updates it | Yes - you control it |
| Risk shape | The vendor sees every tool call | The package runs with your privileges |
| In this config | Figma, GitHub | Playwright, Snyk |

Short version: **remote = someone else's server over the network; local = a program your client launches and pipes to.**

### Comments live in `.mcp.jsonc`, not `.mcp.json`

JSON has no comment syntax, so a commented `.mcp.json` would not parse and would
break your client. Instead:

- **[.mcp.json](.mcp.json)** - strict JSON, comment-free, the file your client loads
- **[.mcp.jsonc](.mcp.jsonc)** - the same config annotated, marking each server
  `REMOTE` or `LOCAL` and explaining its transport, auth, and trade-offs

`npm run check` strips the comments from `.mcp.jsonc`, parses it, and **fails if its
servers differ from `.mcp.json`** - so the annotations cannot silently go stale.

## Quick start

```bash
npm install            # installs @playwright/mcp and the Snyk CLI locally
cp .env.example .env   # then fill in the two tokens
npm run check          # verifies every server actually answers
```

Expected output once the tokens are in place:

```
Checking 4 MCP servers from .mcp.json

.env present: yes
annotated copy .mcp.jsonc: in sync

  figma       [http] ...  OK  (after you finish Figma OAuth in your client)
  playwright  [stdio] ... OK  Playwright ..., 25 tools
  snyk        [stdio] ... OK  Snyk MCP Server ..., 14 tools
  github      [http] ...  OK  HTTP 200
```

## Server-by-server setup

### Figma — remote, OAuth, nothing to install

`https://mcp.figma.com/mcp` is Figma's official hosted server. It authenticates through
OAuth from inside your MCP client, so **no token lives in this repo**.

1. Start the server from your client.
2. A browser opens; sign in to Figma and authorize.
3. Use an account that can already access the file you want.

No Figma desktop app is required. The older `/sse` URL is not current — use `/mcp`.
Access still depends on your Figma plan, seat, and the file's permissions.

### Playwright — local stdio

Pinned to the copy installed in `node_modules`, so it starts instantly and works offline.
Configured with `--browser msedge --headless`, matching your `MCP-Skiils` folder.

Swap the flags in `[.mcp.json](.mcp.json)` if you want different behaviour:

| Flag | Effect |
|---|---|
| `--browser chromium \| firefox \| webkit \| msedge` | Pick the engine |
| `--headless` | Remove it to watch the browser work — useful when debugging |
| `--isolated` | Throwaway profile, discarded on close |
| `--device "iPhone 15"` | Device emulation |
| `--caps network,storage,testing,pdf` | Turn on extra tool groups |

If you change the browser, install its engine: `npx playwright install chromium`.
The `msedge` channel uses the Edge already on Windows, so no download was needed.

### Snyk — local stdio

Runs the Snyk CLI's built-in MCP server (`snyk mcp -t stdio`), which is Snyk's official
server — there is no separate `@snyk/mcp` package, and Snyk offers **no hosted endpoint**.

Authenticate with **either**:

```bash
npx snyk auth          # browser OAuth, one time
```

**or** put a token in `.env` as `SNYK_TOKEN`. The configured version is 1.1308.0, well
above Snyk's documented 1.1298.0 minimum.

14 tools are exposed, including `snyk_code_scan`, `snyk_sca_scan`, `snyk_container_scan`,
`snyk_iac_scan`, `snyk_secret_scan`, `snyk_sbom_scan`, and `snyk_aibom`.

### GitHub — remote, token required

`https://api.githubcopilot.com/mcp/` is GitHub's official remote server. The older
`@modelcontextprotocol/server-github` npm package is **deprecated** — do not use it.

Create a PAT at <https://github.com/settings/tokens> and set `GITHUB_PERSONAL_ACCESS_TOKEN`
in `.env`. Grant only what you need: `repo`, `read:org`, `read:user`, `read:packages`, `workflow`.

To cut context bloat, uncomment `GITHUB_TOOLSETS` in `.env` to expose only the toolsets you
use. Defaults are `context,repos,issues,pull_requests,users`. Read-only mode is available
through the remote `/readonly` path if you want write tools off entirely.

## Wiring it into a client

Point your client at `[.mcp.json](.mcp.json)`. It uses the flat `mcpServers` shape, same as
your `Medium MCP` and `MCP-Skiils` folders, so Claude Code, Cursor, Cline and similar pick it
up directly.

For **VS Code**, which uses a different schema, copy `[vscode-mcp.json](vscode-mcp.json)`
to `.vscode/mcp.json` in whichever project you are working in. It prompts for tokens
securely instead of reading them from a file.

### Important: `${VAR}` expansion

`.mcp.json` references `${GITHUB_PERSONAL_ACCESS_TOKEN}` and `${SNYK_TOKEN}`. Those are
expanded from the **client's process environment** — the `.env` file here is read by
`npm run check`, not by your MCP client. So either:

- export the variables in the shell/environment you launch the client from, or
- if your client does not support `${VAR}` expansion, copy `.mcp.json` to
  `.mcp.local.json`, paste the real tokens in, and point the client there instead.
  That file is gitignored.

## Security notes

- `.env` and `.mcp.local.json` are gitignored. Keep it that way — a GitHub PAT in git is
  the single most common way this kind of setup leaks.
- `--allowed-origins` on Playwright is a convenience guardrail, not a security boundary.
  Do not treat it as sandboxing.
- Both remote servers see whatever the token grants. Scope the PAT narrowly, and rely on
  `GITHUB_TOOLSETS` / read-only mode rather than a broadly scoped token.
- The GitHub token is sent to `api.githubcopilot.com`. If your policy forbids that, switch
  to the local Docker image (`ghcr.io/github/github-mcp-server`) — Docker is already
  installed on this machine.

## Scanning a folder with Snyk

```bash
npm run scan -- <path> [--tools=code,secrets,sca,iac,aibom]
```

This drives the *same* Snyk MCP server your client uses, so results match what an MCP
client sees. It trusts the folder first, then runs the requested scan types.

```bash
npm run scan -- ./some-project --tools=sca
npm run scan -- ./some-project --tools=code,secrets
npm run scan -- ./some-project                 # everything
```

**Pass the `--` separator.** Without it npm silently swallows `--tools=...`, and all five
scan types run instead of the one you asked for - which is slow and reports unrelated
blockers. This was verified, not assumed: with `--` you get 1 scan, without it you get 5.

`SNYK_SCAN_CALL_TIMEOUT_MS` (default 120000) bounds each scan call.

| `--tools=` | Checks | Needs |
|---|---|---|
| `sca` | Open-source dependency vulnerabilities | a manifest: `package.json`, `requirements.txt`, `pom.xml`, ... |
| `code` | Static analysis (SAST) | **Snyk Code enabled for the org** |
| `secrets` | Hardcoded credentials | **Snyk Secrets enabled for the org** |
| `iac` | IaC misconfiguration | Terraform / K8s / CloudFormation / ARM files |
| `aibom` | CycloneDX SBOM of AI components | nothing extra |

## Troubleshooting

| Symptom | Cause |
|---|---|
| `spawn failed` on playwright/snyk | Run `npm install` in this folder first |
| Snyk asks you to authenticate | Run `npx snyk auth`, or set `SNYK_TOKEN` |
| GitHub returns 401 | Token missing, expired, or lacks the scope for the tool you called |
| GitHub returns 400 "Authorization header is badly formatted" | The token expanded to empty — set the env var or use `.mcp.local.json` |
| Figma returns 401 on probe | Expected: the remote server wants interactive OAuth, which `npm run check` cannot do |
| Playwright never launches a browser | Only `msedge` channel is configured; Edge must be installed |
| `snyk_code_scan` returns `SNYK-CODE-0005` | Snyk Code is not enabled for your organization - enable it in the Snyk UI |
| `snyk_secret_scan` returns `SNYK-CLI-0016` | Snyk Secrets is not enabled for your organization |
| Snyk says the folder "is not trusted" | `npm run scan` trusts it for you; a plain MCP client has to call `snyk_trust` itself |
| `Could not detect supported target files` | The target has no dependency manifest or supported source - not a Snyk failure |
| `npm run scan` runs five scans instead of one | Missing the `--` separator, so npm ate `--tools=` |
