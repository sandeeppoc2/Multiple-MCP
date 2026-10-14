#!/usr/bin/env node
// Verifies every server in .mcp.json is actually reachable and speaking MCP.
// stdio servers get a real JSON-RPC handshake + tools/list; remote servers get
// an HTTP initialize probe. Reports what genuinely answered, not what is configured.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skipTools = process.argv.includes("--skip-tools");
const TIMEOUT_MS = Number(process.env.MCP_CHECK_TIMEOUT_MS ?? 60000);
const PROTOCOL_VERSION = "2025-06-18";

function loadDotEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

const dotenv = loadDotEnv();
const expand = (input) =>
  String(input).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, key) => process.env[key] ?? dotenv[key] ?? "",
  );

function connectStdio(name, spec) {
  return new Promise((resolve) => {
    const extra = Object.fromEntries(
      Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v)]),
    );
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: root,
      env: { ...process.env, ...dotenv, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const pending = new Map();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `no response within ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    child.on("error", (err) => finish({ ok: false, error: `spawn failed: ${err.message}` }));
    child.on("exit", (code) => {
      if (!settled && pending.size > 0) {
        finish({ ok: false, error: `server exited (code ${code}) before replying` });
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      let index;
      while ((index = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // non-JSON log noise
        }
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          resolver(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const request = (id, method, params) =>
      new Promise((res) => {
        pending.set(id, res);
        send({ jsonrpc: "2.0", id, method, params });
      });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "overall-mcp-check", version: "1.0.0" },
      });
      if (init.error) {
        return finish({ ok: false, error: `initialize failed: ${init.error.message}` });
      }

      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

      const server = init.result?.serverInfo;
      if (skipTools) {
        return finish({ ok: true, server, toolCount: null, tools: [] });
      }

      const tools = await request(2, "tools/list", {});
      if (tools.error) {
        return finish({
          ok: true,
          server,
          toolCount: null,
          tools: [],
          warn: `tools/list failed: ${tools.error.message}`,
        });
      }
      const list = tools.result?.tools ?? [];
      finish({
        ok: true,
        server,
        toolCount: list.length,
        tools: list.map((t) => t.name),
      });
    })();
  });
}

async function connectHttp(name, spec) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    headers[key.toLowerCase()] = expand(value);
  }
  // An unexpanded ${TOKEN} collapses to a bare "Bearer ", which some servers
  // answer with 400 rather than 401. Track that so we report it as unauthenticated
  // instead of as a broken endpoint.
  const hasToken = !/^Bearer\s*$/i.test(headers.authorization ?? "Bearer");
  const hasAuthHeader = "authorization" in headers;

  try {
    const response = await fetch(spec.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "overall-mcp-check", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      hasToken,
      hasAuthHeader,
      body: text.slice(0, 200),
    };
  } catch (err) {
    return { ok: false, error: err.message, hasToken, hasAuthHeader };
  }
}

// JSON has no comment syntax, so the explanatory notes live in .mcp.jsonc.
// Strip them safely: // and /* */ inside strings must survive untouched.
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[++i] ?? "";
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

const config = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"));
const entries = Object.entries(config.mcpServers ?? {});

// The annotated copy must describe the same servers, or its comments are wrong.
const annotatedPath = path.join(root, ".mcp.jsonc");
let annotatedState = "absent";
if (existsSync(annotatedPath)) {
  try {
    const annotated = JSON.parse(
      stripJsonComments(readFileSync(annotatedPath, "utf8")),
    );
    const matches =
      JSON.stringify(annotated.mcpServers ?? {}) === JSON.stringify(config.mcpServers ?? {});
    annotatedState = matches ? "in sync" : "MISMATCH";
  } catch (err) {
    annotatedState = `unparseable (${err.message})`;
  }
}

console.log(`Checking ${entries.length} MCP servers from .mcp.json\n`);
console.log(`.env present: ${existsSync(path.join(root, ".env")) ? "yes" : "NO (tokens will be blank)"}`);
console.log(`annotated copy .mcp.jsonc: ${annotatedState}\n`);

const results = {};
for (const [name, spec] of entries) {
  const transport = spec.url ? "http" : "stdio";
  process.stdout.write(`  ${name.padEnd(11)} [${transport}] ... `);

  const result = spec.url
    ? await connectHttp(name, spec)
    : await connectStdio(name, spec);

  results[name] = result;

  if (transport === "http") {
    if (result.ok) {
      console.log(`OK  HTTP ${result.status}  ${result.body.replace(/\s+/g, " ").slice(0, 90)}`);
    } else if (!result.hasAuthHeader) {
      console.log(
        `UNVERIFIED  HTTP ${result.status} - endpoint reachable; auth is OAuth, no token field to fill in`,
      );
    } else if (!result.hasToken) {
      console.log(
        `UNVERIFIED  HTTP ${result.status} - endpoint reachable, no token in .env yet`,
      );
    } else if (result.status === 401 || result.status === 403) {
      console.log(`FAIL  HTTP ${result.status} - token supplied but rejected`);
    } else {
      console.log(`FAIL  ${result.error ?? `HTTP ${result.status} ${result.body ?? ""}`}`);
    }
  } else if (result.ok) {
    const version = result.server ? ` v${result.server.version}` : "";
    const count = result.toolCount === null ? "tools/list unavailable" : `${result.toolCount} tools`;
    console.log(`OK  ${result.server?.name ?? name}${version}, ${count}`);
    if (result.warn) console.log(`      note: ${result.warn}`);
  } else {
    console.log(`FAIL  ${result.error}`);
  }
}

console.log("\n--- tool inventory ---");
for (const [name, result] of Object.entries(results)) {
  if (!result.tools?.length) {
    console.log(`  ${name}: none discovered`);
    continue;
  }
  console.log(`  ${name} (${result.tools.length}): ${result.tools.join(", ")}`);
}

const stdioOk = entries.filter(([n, s]) => !s.url && results[n]?.ok).length;
const stdioTotal = entries.filter(([, s]) => !s.url).length;
console.log(`\nstdio servers answering MCP: ${stdioOk}/${stdioTotal}`);
console.log("Remote (http) servers report reachability only; drop a token in .env to fully check them.");

if (annotatedState === "MISMATCH") {
  console.log(
    "\nFAIL: .mcp.jsonc does not match .mcp.json - its comments are describing servers that no longer exist.\n" +
      "      Update the annotated copy so the explanation stays truthful.",
  );
  process.exitCode = 1;
} else if (annotatedState.startsWith("unparseable")) {
  console.log(`\nFAIL: could not parse .mcp.jsonc - ${annotatedState}`);
  process.exitCode = 1;
}
