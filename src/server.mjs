import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ClaimsPlatform } from "./application/platform.mjs";
import { FileEventStore } from "./infrastructure/file-event-store.mjs";
import { ProjectionStore } from "./infrastructure/projection-store.mjs";
import { normalizeError } from "./lib/errors.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataFile = path.join(rootDir, "data", "events.jsonl");
const port = Number(process.env.PORT ?? 3000);

const platform = new ClaimsPlatform({
  eventStore: new FileEventStore(dataFile),
  projections: new ProjectionStore(),
});

await platform.init();

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body, null, 2));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function notFound(response) {
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Route not found." } });
}

async function serveStatic(response, pathname) {
  const filePath = path.join(publicDir, pathname === "/" ? "index.html" : pathname.slice(1));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(publicDir)) {
    notFound(response);
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
    }[ext] ?? "application/octet-stream";

  try {
    const file = await readFile(resolved);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    response.end(file);
  } catch {
    notFound(response);
  }
}

async function routeApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "claims-platform", timestamp: new Date().toISOString() });
    return;
  }

  if (request.method === "GET" && pathname === "/api/snapshot") {
    sendJson(response, 200, platform.getSnapshot());
    return;
  }

  if (request.method === "POST" && pathname === "/api/claims/intake") {
    const body = await readJsonBody(request);
    sendJson(response, 201, await platform.submitClaim(body));
    return;
  }

  const validateMatch = pathname.match(/^\/api\/claims\/([^/]+)\/validate$/);
  if (request.method === "POST" && validateMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.validateClaim(decodeURIComponent(validateMatch[1]), body));
    return;
  }

  const adjudicateMatch = pathname.match(/^\/api\/claims\/([^/]+)\/adjudicate$/);
  if (request.method === "POST" && adjudicateMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.adjudicateClaim(decodeURIComponent(adjudicateMatch[1]), body));
    return;
  }

  const proposeMatch = pathname.match(/^\/api\/claims\/([^/]+)\/propose-settlement$/);
  if (request.method === "POST" && proposeMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.proposeSettlement(decodeURIComponent(proposeMatch[1]), body));
    return;
  }

  const approveMatch = pathname.match(/^\/api\/claims\/([^/]+)\/approve-settlement$/);
  if (request.method === "POST" && approveMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.approveSettlement(decodeURIComponent(approveMatch[1]), body));
    return;
  }

  const recordMatch = pathname.match(/^\/api\/claims\/([^/]+)\/record-settlement$/);
  if (request.method === "POST" && recordMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.recordSettlement(decodeURIComponent(recordMatch[1]), body));
    return;
  }

  if (request.method === "POST" && pathname === "/api/reconciliation/import") {
    const body = await readJsonBody(request);
    sendJson(response, 201, await platform.importReconciliationBatch(body));
    return;
  }

  if (request.method === "POST" && pathname === "/api/self-heal/run") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.runSelfHealing(body));
    return;
  }

  const resolveMatch = pathname.match(/^\/api\/exceptions\/([^/]+)\/resolve$/);
  if (request.method === "POST" && resolveMatch) {
    const body = await readJsonBody(request);
    sendJson(response, 200, await platform.resolveException(decodeURIComponent(resolveMatch[1]), body));
    return;
  }

  if (request.method === "POST" && pathname === "/api/demo/seed") {
    sendJson(response, 200, await platform.seedDemo());
    return;
  }

  notFound(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(request, response, url.pathname);
      return;
    }

    if (request.method !== "GET") {
      notFound(response);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    const normalized = normalizeError(error);
    sendJson(response, normalized.status ?? 500, {
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      },
    });
  }
});

server.listen(port, () => {
  console.log(`Self-healing claims platform running at http://localhost:${port}`);
});
