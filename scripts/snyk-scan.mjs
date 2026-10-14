#!/usr/bin/env node
// Runs Snyk scans against any path by driving the Snyk MCP server - the same
// server configured in .mcp.json - so results match what an MCP client would see.
//
//   node scripts/snyk-scan.mjs <path> [--tools=code,secrets,sca,iac,aibom]
//   node scripts/snyk-scan.mjs <path> --tools=          # trust only, no scans
//
// Reads SNYK_TOKEN from .env. Never prints the token.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const toolsArg = argv.find((a) => a.startsWith("--tools="));
const targetArg = argv.find((a) => !a.startsWith("--"));
const tools =
  toolsArg === undefined
    ? ["code", "secrets", "sca", "iac", "aibom"]
    : toolsArg
        .slice("--tools=".length)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

const CALL_TIMEOUT_MS = Number(process.env.SNYK_SCAN_CALL_TIMEOUT_MS ?? 120000);

if (!targetArg) {
  console.error("Usage: node scripts/snyk-scan.mjs <path> [--tools=code,secrets,sca,iac,aibom]");
  process.exit(1);
}
const target = path.resolve(targetArg);
if (!existsSync(target)) {
  console.error(`Target does not exist: ${target}`);
  process.exit(1);
}

const dotenv = {};
if (existsSync(path.join(root, ".env"))) {
  for (const line of readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) dotenv[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
}
if (!dotenv.SNYK_TOKEN && !process.env.SNYK_TOKEN) {
  console.error("SNYK_TOKEN is not set in .env - Snyk scans will fail unauthenticated.");
}

const TOOL_FOR = {
  code: "snyk_code_scan",
  secrets: "snyk_secret_scan",
  sca: "snyk_sca_scan",
  iac: "snyk_iac_scan",
  aibom: "snyk_aibom",
};

const child = spawn("node", ["node_modules/snyk/bin/snyk", "mcp", "-t", "stdio"], {
  cwd: root,
  env: { ...process.env, ...dotenv },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
const pending = new Map();

const settleAll = (reason) => {
  for (const [, { reject }] of pending) reject(new Error(reason));
  pending.clear();
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      entry.resolve(message);
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.on("error", (err) => {
  console.error(`Failed to start the Snyk MCP server: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  settleAll(`Snyk MCP server exited early (code ${code}). Last stderr: ${stderr.trim().slice(-400)}`);
});

const call = (id, method, params) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `${method} produced no reply within ${CALL_TIMEOUT_MS}ms.` +
            (stderr.trim() ? ` Last stderr: ${stderr.trim().slice(-400)}` : ""),
        ),
      );
    }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const contentText = (res) =>
  (res.result?.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `<${c.type}>`))
    .join("\n")
    .replace(/\r/g, "");

console.log(`target: ${target}\n`);

await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "snyk-scan", version: "1.0.0" },
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
);

// Snyk refuses to scan an untrusted folder. Trusting an already-trusted folder
// returns immediately; the message is printed so the state is never ambiguous.
try {
  const trust = await call(2, "tools/call", {
    name: "snyk_trust",
    arguments: { path: target },
  });
  const text = contentText(trust).replace(/\s+/g, " ").trim();
  console.log(`trust: ${text || "ok"}\n`);
} catch (err) {
  console.log(`trust: FAILED - ${err.message}\n`);
  child.kill();
  process.exit(1);
}

let id = 10;
let blocked = 0;
for (const key of tools) {
  const tool = TOOL_FOR[key];
  if (!tool) {
    console.log(`skipped "${key}": not a known scan type\n`);
    continue;
  }
  console.log(`══════ ${tool} ══════`);
  try {
    const res = await call(id++, "tools/call", { name: tool, arguments: { path: target } });
    const body = contentText(res) || JSON.stringify(res.error ?? res.result);
    if (res.result?.isError || /ERROR|not enabled|not supported|not trusted/i.test(body)) {
      blocked++;
    }
    console.log(body.slice(0, 1600));
  } catch (err) {
    blocked++;
    console.log(`ERROR: ${err.message}`);
  }
  console.log();
}

console.log(
  blocked > 0
    ? `${blocked} of ${tools.length} scan types could not run - see the messages above.`
    : `All ${tools.length} requested scan types ran without error.`,
);

child.kill();
process.exit(0);
