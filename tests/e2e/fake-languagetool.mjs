// A stand-in for `java … HTTPServer --port N`: what Kladde starts as its local LanguageTool in the e2e tests
// (KLADDE_LT_COMMAND). It answers GET /v2/languages and POST /v2/check like LanguageTool does, binds the loopback
// interface only and is configured by environment variables:
//   FAKE_LT_PID_FILE      receives the process id
//   FAKE_LT_LOG           gets one JSON line per start and per check request
//   FAKE_LT_STARTUP_MS    time before it listens (a real server needs seconds)
//   FAKE_LT_FAIL_ONCE     path of a file: if it exists the process deletes it and exits with an error instead of starting
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { matchesIn, readable } from "./fake-lt.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const log = (entry) => process.env.FAKE_LT_LOG && appendFileSync(process.env.FAKE_LT_LOG, JSON.stringify(entry) + "\n");

const failOnce = process.env.FAKE_LT_FAIL_ONCE;
if (failOnce && existsSync(failOnce)) {
  unlinkSync(failOnce);
  console.error("Error: could not create the Java Virtual Machine (stand-in failure)");
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v2/languages") {
    return void res.writeHead(200, { "content-type": "application/json" }).end("[]");
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const form = new URLSearchParams(body);
    const annotation = JSON.parse(form.get("data")).annotation;
    log({ event: "check", language: form.get("language"), sent: annotation.filter((i) => i.text !== undefined).map((i) => i.text).join("") });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches: matchesIn(readable(annotation)) }));
  });
});

setTimeout(() => {
  server.listen(port, "127.0.0.1", () => {
    if (process.env.FAKE_LT_PID_FILE) writeFileSync(process.env.FAKE_LT_PID_FILE, String(process.pid));
    log({ event: "start", pid: process.pid, port, args: process.argv.slice(2) });
  });
}, Number(process.env.FAKE_LT_STARTUP_MS ?? 0));
