const crypto = require("node:crypto");
const {
  buildAggregatedSyncResult,
  cloneRows,
} = require("./core");

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildRunStatus(summary) {
  if (summary.failedJobs === 0 && summary.failedKeys === 0) {
    return "succeeded";
  }

  if (summary.successfulJobs === 0 && summary.changedCells === 0) {
    return "failed";
  }

  return "completed_with_errors";
}

function buildConflictDetails(failures) {
  return (failures || []).flatMap((failure) => {
    const conflictReasons = (failure.reasons || []).filter((reason) => reason.type === "conflict");
    if (conflictReasons.length === 0) {
      return [];
    }

    const sourcesByJob = new Map();
    for (const reason of conflictReasons) {
      for (const source of reason.sources || []) {
        const sourceKey = source.jobId || source.jobLabel;
        if (sourceKey && !sourcesByJob.has(sourceKey)) {
          sourcesByJob.set(sourceKey, {
            jobId: source.jobId || null,
            jobLabel: source.jobLabel || source.jobId || "未知分表",
          });
        }
      }
    }

    return [{
      key: failure.key,
      sources: [...sourcesByJob.values()],
    }];
  });
}

class SyncService {
  constructor({
    planRepo,
    runRepo,
    lockService,
    sheetClient,
    now = () => new Date(),
    yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
  }) {
    this.planRepo = planRepo;
    this.runRepo = runRepo;
    this.lockService = lockService;
    this.sheetClient = sheetClient;
    this.now = now;
    this.yieldControl = yieldControl;
  }

  async runManual(planId, trigger = {}, options = {}) {
    return this.lockService.runExclusive(planId, () => this.runPlan(planId, {
      triggerUserId: trigger.userId || null,
      triggerUserName: trigger.userName || null,
      dryRun: Boolean(options.dryRun),
    }, options.onProgress));
  }

  async inspectPlan(plan, reportProgress) {
    const target = await this.sheetClient.readTarget(plan);
    await reportProgress("总表读取完成");
    const jobs = [];

    for (let index = 0; index < plan.jobs.length; index += 1) {
      const job = plan.jobs[index];
      try {
        const source = await this.sheetClient.readSource(plan, job);
        jobs.push({
          job,
          sourceRows: source.rows,
          sourceMeta: source.meta,
        });
      } catch (error) {
        jobs.push({
          job,
          sourceRows: null,
          sourceMeta: null,
          inspectionError: formatError(error),
        });
      }

      await reportProgress(`分表读取完成 ${index + 1}/${plan.jobs.length}`);
    }

    return {
      targetRows: target.rows,
      targetMeta: target.meta,
      jobs,
    };
  }

  async runPlan(planId, trigger, onProgress = () => {}) {
    const plan = this.planRepo.getPlan(planId);
    if (!plan || plan.enabled === false) {
      throw new Error(`Sync plan not found or disabled: ${planId}`);
    }

    const startedAt = this.now();
    const totalSteps = plan.jobs.length + 3;
    let completedSteps = 0;
    const reportProgress = async (phase, options = {}) => {
      if (options.advance !== false) {
        completedSteps += 1;
      }

      onProgress({
        progress: Math.round((completedSteps / totalSteps) * 100),
        phase,
        completedSteps,
        totalSteps,
      });
      await this.yieldControl();
    };

    const inspection = await this.inspectPlan(plan, reportProgress);
    const readableJobs = inspection.jobs
      .filter((item) => !item.inspectionError)
      .map((item) => ({
        job: item.job,
        rows: item.sourceRows,
        meta: item.sourceMeta,
      }));
    const aggregatedResult = buildAggregatedSyncResult(
      cloneRows(inspection.targetRows),
      readableJobs,
      plan,
      { dryRun: trigger.dryRun, maxPreview: 10 },
    );
    await reportProgress("数据汇总完成");
    let writeResult = null;

    if (!trigger.dryRun && aggregatedResult.changes.length > 0) {
      await reportProgress("正在写入总表", { advance: false });
      writeResult = await this.sheetClient.applyChanges(plan, aggregatedResult);
    }
    await reportProgress("同步完成");

    const jobResults = [
      ...aggregatedResult.jobs,
      ...inspection.jobs
        .filter((item) => item.inspectionError)
        .map((item) => ({
          jobId: item.job.id,
          jobLabel: item.job.label,
          status: "failed",
          errorMessage: item.inspectionError,
          sourceMeta: item.sourceMeta || null,
        })),
    ];
    const finishedAt = this.now();
    const summary = {
      ...aggregatedResult.report.stats,
      totalJobs: plan.jobs.length,
      successfulJobs: jobResults.filter((item) => item.status === "succeeded").length,
      failedJobs: jobResults.filter((item) => item.status === "failed").length,
    };
    const run = {
      runId: crypto.randomUUID(),
      planId: plan.planId,
      planName: plan.name,
      triggerType: "manual",
      triggerUserId: trigger.triggerUserId,
      triggerUserName: trigger.triggerUserName,
      dryRun: trigger.dryRun,
      status: buildRunStatus(summary),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary,
      jobs: jobResults,
      conflicts: buildConflictDetails(aggregatedResult.failures),
      previewChanges: aggregatedResult.report.previewChanges,
      failures: aggregatedResult.failures,
      previewFailures: aggregatedResult.report.previewFailures,
      writeResult,
      errorMessage: jobResults.every((item) => item.status === "failed")
        ? jobResults.map((item) => item.errorMessage).filter(Boolean).join(" | ")
        : null,
    };

    this.runRepo.append(run);
    return run;
  }
}

module.exports = {
  SyncService,
  buildConflictDetails,
};
