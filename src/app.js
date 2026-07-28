const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { loadEnv } = require("./config/env");
const { SyncPlanRepo } = require("./config/sync-plan-repo");
const { RunRepo } = require("./storage/run-repo");
const { LockService } = require("./jobs/lock-service");
const { createSheetClient } = require("./dingtalk/sheet-client");
const { SyncService } = require("./sync/sync-service");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawText = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawText) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawText));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function buildServices(customEnv = null) {
  const env = customEnv || loadEnv();
  fs.mkdirSync(env.dataDir, { recursive: true });

  const planRepo = new SyncPlanRepo({ configPath: env.syncPlansPath });
  const runRepo = new RunRepo({ dataDir: env.dataDir, limit: env.runHistoryLimit });
  const lockService = new LockService();
  const sheetClient = createSheetClient({ env });
  const syncService = new SyncService({
    planRepo,
    runRepo,
    lockService,
    sheetClient,
  });

  return {
    env,
    planRepo,
    runRepo,
    syncService,
  };
}

function getDefaultPlan(services) {
  const plan = services.planRepo.getDefaultPlan();
  if (!plan) {
    throw new Error("No sync plan configured.");
  }
  return plan;
}

function buildColumnDisplay(column, header) {
  const columnText = column ? `${column} 列` : "未配置列";
  return header ? `${columnText}（${header}）` : columnText;
}

function buildKeyMapping(plan, job) {
  const sourceKey = job.keyColumn || {};
  const targetKey = plan.target?.keyColumn || {};
  const field = plan.rules?.keyColumn || "货号";

  return {
    field,
    label: "货号匹配",
    sourceKind: "key",
    sourceColumn: sourceKey.column || "",
    sourceHeader: sourceKey.header || field,
    sourceDisplay: buildColumnDisplay(sourceKey.column || "", sourceKey.header || field),
    targetColumn: targetKey.column || "",
    targetHeader: targetKey.header || field,
    targetDisplay: buildColumnDisplay(targetKey.column || "", targetKey.header || field),
  };
}

function buildFieldMappings(plan, job) {
  return (plan.rules?.fields || []).map((field) => {
    const sourceSpec = job.fields?.[field] ?? job.fieldMappings?.[field] ?? null;
    const targetSpec = plan.target?.columns?.[field] || {};

    if (sourceSpec && typeof sourceSpec === "object" && sourceSpec.constant != null) {
      return {
        field,
        label: field,
        sourceKind: "constant",
        sourceColumn: "",
        sourceHeader: "",
        sourceConstant: String(sourceSpec.constant),
        sourceDisplay: `固定值（${String(sourceSpec.constant)}）`,
        targetColumn: targetSpec.column || "",
        targetHeader: targetSpec.header || field,
        targetDisplay: buildColumnDisplay(targetSpec.column || "", targetSpec.header || field),
      };
    }

    const sourceHeader = typeof sourceSpec === "string"
      ? sourceSpec
      : sourceSpec?.sourceHeader || sourceSpec?.header || field;
    const sourceColumn = typeof sourceSpec === "object" ? sourceSpec?.column || "" : "";

    return {
      field,
      label: field,
      sourceKind: "column",
      sourceColumn,
      sourceHeader,
      sourceConstant: null,
      sourceDisplay: buildColumnDisplay(sourceColumn, sourceHeader),
      targetColumn: targetSpec.column || "",
      targetHeader: targetSpec.header || field,
      targetDisplay: buildColumnDisplay(targetSpec.column || "", targetSpec.header || field),
    };
  });
}

function buildWebConfig(plan, env) {
  return {
    appName: plan.name,
    planId: plan.planId,
    provider: env.provider,
    jobCount: plan.jobs.length,
    targetCount: 1,
    target: {
      node: plan.target.node,
      sheet: plan.target.sheet,
    },
    syncJobs: plan.jobs.map((job) => ({
      id: job.id,
      label: job.label,
      sourceSheet: job.source.sheet,
      targetSheet: plan.target.sheet,
      keyMapping: buildKeyMapping(plan, job),
      fieldMappings: buildFieldMappings(plan, job),
    })),
  };
}

function handleLastRun(res, services, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, { ok: false, error: `Unknown plan: ${planId}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    lastRun: services.runRepo.getLastByPlan(planId),
  });
}

function handleWebStatus(res, services, runtimeState, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, { ok: false, error: `Unknown plan: ${planId}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    currentRun: runtimeState.currentRun,
    lastRun: services.runRepo.getLastByPlan(planId),
    plan: buildWebConfig(plan, services.env),
  });
}

function handleWebConfig(res, services, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, { ok: false, error: `Unknown plan: ${planId}` });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    config: buildWebConfig(plan, services.env),
  });
}

async function handleWebSync(req, res, services, runtimeState, planId) {
  if (!services.planRepo.getPlan(planId)) {
    sendJson(res, 404, { ok: false, error: `Unknown plan: ${planId}` });
    return;
  }

  if (runtimeState.currentRun) {
    sendJson(res, 409, {
      ok: false,
      error: "A sync run is already in progress.",
      currentRun: runtimeState.currentRun,
    });
    return;
  }

  const body = await readRequestBody(req);
  runtimeState.currentRun = {
    planId,
    dryRun: Boolean(body.dryRun),
    startedAt: new Date().toISOString(),
    status: "running",
    progress: 0,
    phase: "准备同步",
  };

  try {
    const result = await services.syncService.runManual(planId, {
      userId: "web-console",
      userName: "web-console",
    }, {
      dryRun: Boolean(body.dryRun),
      onProgress(progressState) {
        if (runtimeState.currentRun) {
          Object.assign(runtimeState.currentRun, progressState);
        }
      },
    });
    runtimeState.currentRun = null;
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    runtimeState.currentRun = null;
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath.replace(/^\/+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const typeByExt = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  sendText(res, 200, fs.readFileSync(filePath, "utf8"), typeByExt[ext] || "text/plain; charset=utf-8");
}

function createServer(services = buildServices()) {
  const runtimeState = { currentRun: null };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const defaultPlan = getDefaultPlan(services);

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "sheet-sync-web",
          provider: services.env.provider,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        handleWebStatus(res, services, runtimeState, defaultPlan.planId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        handleWebConfig(res, services, defaultPlan.planId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sync") {
        await handleWebSync(req, res, services, runtimeState, defaultPlan.planId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/last-run") {
        handleLastRun(res, services, defaultPlan.planId);
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        serveStatic(res, url.pathname);
        return;
      }

      sendText(res, 404, "Not found");
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function startServer() {
  const services = buildServices();
  const server = createServer(services);

  server.listen(services.env.port, services.env.host, () => {
    console.log(JSON.stringify({
      ok: true,
      message: "Manual sheet sync web server is running.",
      provider: services.env.provider,
      url: `http://${services.env.host}:${services.env.port}/`,
      syncPlansPath: path.relative(process.cwd(), services.env.syncPlansPath),
    }, null, 2));
  });

  return { server, services };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildServices,
  createServer,
  startServer,
};
