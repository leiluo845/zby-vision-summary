const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { loadEnv } = require("./config/env");
const { SyncPlanRepo } = require("./config/sync-plan-repo");
const { RunRepo } = require("./storage/run-repo");
const { ConfirmationRepo } = require("./storage/confirmation-repo");
const { CallbackDedupRepo } = require("./storage/callback-dedup-repo");
const { LockService } = require("./jobs/lock-service");
const { TokenService } = require("./dingtalk/token-service");
const { DingTalkApiClient } = require("./dingtalk/api-client");
const { createSheetClient } = require("./dingtalk/sheet-client");
const { SyncService } = require("./sync/sync-service");
const { routeCommand } = require("./bot/command-router");
const { PermissionGuard } = require("./bot/permission-guard");
const { HomeCardService } = require("./bot/home-card-service");
const {
  formatBlankRiskMessage,
  formatHelpMessage,
  formatRecentRunsMessage,
  formatRunMessage,
} = require("./sync/report-formatter");
const { CronRunner } = require("./scheduler/cron-runner");
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

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawText = Buffer.concat(chunks).toString("utf8").trim();
      resolve(rawText ? parseJsonSafe(rawText) || {} : {});
    });
    req.on("error", reject);
  });
}

function buildServices(customEnv = null) {
  const env = customEnv || loadEnv();
  fs.mkdirSync(env.dataDir, { recursive: true });

  const planRepo = new SyncPlanRepo({ configPath: env.syncPlansPath });
  const runRepo = new RunRepo({ dataDir: env.dataDir, limit: env.runHistoryLimit });
  const confirmationRepo = new ConfirmationRepo({ dataDir: env.dataDir });
  const dedupRepo = new CallbackDedupRepo({ dataDir: env.dataDir });
  const lockService = new LockService();
  const tokenService = new TokenService({
    appKey: env.appKey,
    appSecret: env.appSecret,
    apiBaseUrl: env.apiBaseUrl,
  });
  const apiClient = new DingTalkApiClient({
    apiBaseUrl: env.apiBaseUrl,
    tokenService,
  });
  const sheetClient = createSheetClient({ env, apiClient });
  const syncService = new SyncService({
    planRepo,
    runRepo,
    confirmationRepo,
    lockService,
    sheetClient,
  });
  const permissionGuard = new PermissionGuard({ sheetClient });
  const homeCardService = new HomeCardService({ runRepo });
  const scheduler = new CronRunner({ planRepo, syncService });

  return {
    env,
    planRepo,
    runRepo,
    confirmationRepo,
    dedupRepo,
    syncService,
    permissionGuard,
    homeCardService,
    scheduler,
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

  return {
    field: plan.rules?.keyColumn || "货号",
    label: "货号匹配",
    sourceKind: "key",
    sourceColumn: sourceKey.column || "",
    sourceHeader: sourceKey.header || plan.rules?.keyColumn || "货号",
    sourceDisplay: buildColumnDisplay(sourceKey.column || "", sourceKey.header || plan.rules?.keyColumn || "货号"),
    targetColumn: targetKey.column || "",
    targetHeader: targetKey.header || plan.rules?.keyColumn || "货号",
    targetDisplay: buildColumnDisplay(targetKey.column || "", targetKey.header || plan.rules?.keyColumn || "货号"),
  };
}

function buildFieldMappings(plan, job) {
  const fields = plan.rules?.fields || [];

  return fields.map((field) => {
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
    auditWarnings: plan.auditWarnings || [],
    target: {
      node: plan.target.node,
      sheet: plan.target.sheet,
    },
    syncJobs: plan.jobs.map((job) => ({
      id: job.id,
      label: job.label,
      sourceSheet: job.source.sheet,
      targetSheet: plan.target.sheet,
      allowEmptyOverwrite: Boolean(plan.rules?.allowEmptyOverwrite),
      auditWarnings: job.auditWarnings || [],
      keyMapping: buildKeyMapping(plan, job),
      fieldMappings: buildFieldMappings(plan, job),
    })),
  };
}

function extractText(payload) {
  return (
    (typeof payload.text === "string" ? payload.text : null)
    || payload.text?.content
    || payload.content
    || payload.message?.text
    || payload.message?.content
    || ""
  );
}

function extractCallbackContext(payload, fallbackPlanId) {
  return {
    eventId: payload.eventId || payload.msgId || payload.messageId || "",
    planId: payload.planId || fallbackPlanId,
    text: extractText(payload),
    userId: payload.senderStaffId || payload.userId || payload.senderId || "",
    userName: payload.senderNick || payload.userName || "",
    chatId: payload.chatId || payload.conversationId || payload.openConversationId || "",
  };
}

async function handleHomeCard(req, res, services, url) {
  const defaultPlan = getDefaultPlan(services);
  const planId = url.searchParams.get("planId") || defaultPlan.planId;
  const plan = services.planRepo.getPlan(planId);

  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    card: services.homeCardService.build(plan),
  });
}

async function handleCallback(req, res, services) {
  const defaultPlan = getDefaultPlan(services);
  const body = await readRequestBody(req);
  const context = extractCallbackContext(body, defaultPlan.planId);

  if (!services.dedupRepo.remember(context.eventId)) {
    sendJson(res, 200, {
      ok: true,
      deduped: true,
      reply: {
        type: "text",
        text: "该消息已经处理过了。",
      },
    });
    return;
  }

  const plan = services.planRepo.getPlan(context.planId);
  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${context.planId}`,
    });
    return;
  }

  const command = routeCommand(context.text);
  const userContext = {
    userId: context.userId,
    userName: context.userName,
    chatId: context.chatId,
  };

  if (command.intent === "home") {
    sendJson(res, 200, {
      ok: true,
      command: command.intent,
      reply: {
        type: "card",
        card: services.homeCardService.build(plan),
      },
    });
    return;
  }

  if (command.intent === "help" || command.intent === "unknown") {
    sendJson(res, 200, {
      ok: true,
      command: command.intent,
      reply: {
        type: "text",
        text: formatHelpMessage(),
      },
    });
    return;
  }

  if (["manual_sync", "recent_runs"].includes(command.intent)) {
    const permission = await services.permissionGuard.ensureManualSyncAllowed(plan, userContext);
    if (!permission.ok) {
      sendJson(res, 403, {
        ok: false,
        command: command.intent,
        reply: {
          type: "text",
          text: permission.message,
        },
      });
      return;
    }
  }

  if (command.intent === "recent_runs") {
    const runs = services.runRepo.listRecentByPlan(plan.planId, 5);
    sendJson(res, 200, {
      ok: true,
      command: command.intent,
      reply: {
        type: "text",
        text: formatRecentRunsMessage(plan, runs, plan.timezone || services.env.defaultTimezone),
      },
    });
    return;
  }

  if (command.intent === "confirm_yes" || command.intent === "confirm_no") {
    const result = await services.syncService.resolveConfirmation(plan.planId, userContext, command.intent === "confirm_yes");

    if (result.status === "no_pending_confirmation") {
      sendJson(res, 200, {
        ok: true,
        command: command.intent,
        reply: {
          type: "text",
          text: "当前没有待确认的同步任务。请先使用“手动同步”。",
        },
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      command: command.intent,
      result,
      reply: {
        type: "text",
        text: formatRunMessage(result, plan.timezone || services.env.defaultTimezone),
      },
    });
    return;
  }

  if (command.intent === "manual_sync") {
    try {
      const result = await services.syncService.runManual(plan.planId, userContext, { dryRun: command.dryRun });
      const replyText = result.status === "pending_confirmation"
        ? formatBlankRiskMessage(result.blankRiskSummary)
        : formatRunMessage(result, plan.timezone || services.env.defaultTimezone);

      sendJson(res, 200, {
        ok: true,
        command: command.intent,
        result,
        reply: {
          type: "text",
          text: replyText,
        },
      });
      return;
    } catch (error) {
      sendJson(res, 409, {
        ok: false,
        command: command.intent,
        error: error instanceof Error ? error.message : String(error),
        reply: {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
  }

  sendJson(res, 400, {
    ok: false,
    error: "Unsupported command.",
  });
}

async function handleInternalRun(req, res, services, planId) {
  const body = await readRequestBody(req);
  const plan = services.planRepo.getPlan(planId);

  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
    return;
  }

  try {
    const triggerType = body.triggerType === "manual" ? "manual" : "scheduled";
    const result = triggerType === "manual"
      ? await services.syncService.runManual(planId, {
        userId: body.userId || "internal",
        userName: body.userName || "internal",
        chatId: body.chatId || "internal",
      }, { dryRun: Boolean(body.dryRun) })
      : await services.syncService.runScheduled(planId, { dryRun: Boolean(body.dryRun) });

    sendJson(res, 200, {
      ok: true,
      result,
    });
  } catch (error) {
    sendJson(res, 409, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleLastRun(req, res, services, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    lastRun: services.runRepo.getLastByPlan(planId),
  });
}

async function handleWebStatus(req, res, services, runtimeState, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    currentRun: runtimeState.currentRun,
    lastRun: services.runRepo.getLastByPlan(planId),
    plan: buildWebConfig(plan, services.env),
  });
}

async function handleWebConfig(req, res, services, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    config: buildWebConfig(plan, services.env),
  });
}

async function handleWebSync(req, res, services, runtimeState, planId) {
  const plan = services.planRepo.getPlan(planId);
  if (!plan) {
    sendJson(res, 404, {
      ok: false,
      error: `Unknown plan: ${planId}`,
    });
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
  };

  try {
    const result = await services.syncService.runManual(planId, {
      userId: "web-console",
      userName: "web-console",
      chatId: "web-console",
    }, {
      dryRun: Boolean(body.dryRun),
    });
    runtimeState.currentRun = null;
    sendJson(res, 200, {
      ok: true,
      result,
    });
  } catch (error) {
    runtimeState.currentRun = null;
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function serveStatic(req, res, pathname) {
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
  const runtimeState = {
    currentRun: null,
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const defaultPlan = getDefaultPlan(services);

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "sheet-sync-formal-backend",
          provider: services.env.provider,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        await handleWebStatus(req, res, services, runtimeState, defaultPlan.planId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        await handleWebConfig(req, res, services, defaultPlan.planId);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/sync") {
        await handleWebSync(req, res, services, runtimeState, defaultPlan.planId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/last-run") {
        await handleLastRun(req, res, services, defaultPlan.planId);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/dingtalk/home-card") {
        await handleHomeCard(req, res, services, url);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/dingtalk/callback") {
        // Production still needs DingTalk callback signature verification here.
        await handleCallback(req, res, services);
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/internal\/sync-plans\/([^/]+)\/run$/);
      if (req.method === "POST" && runMatch) {
        await handleInternalRun(req, res, services, decodeURIComponent(runMatch[1]));
        return;
      }

      const lastRunMatch = url.pathname.match(/^\/api\/internal\/sync-plans\/([^/]+)\/last-run$/);
      if (req.method === "GET" && lastRunMatch) {
        await handleLastRun(req, res, services, decodeURIComponent(lastRunMatch[1]));
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        serveStatic(req, res, url.pathname);
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

  if (services.env.schedulerEnabled) {
    services.scheduler.start();
  }

  server.listen(services.env.port, services.env.host, () => {
    console.log(JSON.stringify({
      ok: true,
      message: "Formal DingTalk sync backend is running.",
      provider: services.env.provider,
      url: `http://${services.env.host}:${services.env.port}/healthz`,
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
