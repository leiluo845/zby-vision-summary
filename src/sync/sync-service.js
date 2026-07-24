const crypto = require("node:crypto");
const {
  buildAggregatedSyncResult,
  cloneRows,
  detectBlankRisk,
} = require("./core");

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeBlankRisks(riskItems) {
  const columns = [];
  const samples = [];
  let blankCellCount = 0;

  for (const riskItem of riskItems) {
    blankCellCount += riskItem.blankCellCount;
    for (const column of riskItem.columns) {
      columns.push({
        jobId: riskItem.jobId,
        jobLabel: riskItem.jobLabel,
        column: column.column,
        count: column.count,
      });
    }
    for (const sample of riskItem.samples) {
      if (samples.length >= 10) {
        break;
      }
      samples.push({
        jobId: riskItem.jobId,
        jobLabel: riskItem.jobLabel,
        key: sample.key,
        column: sample.column,
        row: sample.row,
      });
    }
  }

  return {
    hasRisk: riskItems.length > 0,
    jobCount: riskItems.length,
    blankCellCount,
    columns,
    samples,
  };
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

class SyncService {
  constructor({
    planRepo,
    runRepo,
    confirmationRepo,
    lockService,
    sheetClient,
    now = () => new Date(),
  }) {
    this.planRepo = planRepo;
    this.runRepo = runRepo;
    this.confirmationRepo = confirmationRepo;
    this.lockService = lockService;
    this.sheetClient = sheetClient;
    this.now = now;
  }

  async runManual(planId, trigger, options = {}) {
    return this.lockService.runExclusive(planId, () => this.runPlan(planId, {
      triggerType: "manual",
      triggerUserId: trigger.userId || null,
      triggerUserName: trigger.userName || null,
      triggerChatId: trigger.chatId || null,
      dryRun: Boolean(options.dryRun),
      confirmed: false,
    }));
  }

  async runScheduled(planId, options = {}) {
    return this.lockService.runExclusive(planId, () => this.runPlan(planId, {
      triggerType: "scheduled",
      triggerUserId: null,
      triggerUserName: null,
      triggerChatId: null,
      dryRun: Boolean(options.dryRun),
      confirmed: true,
    }));
  }

  async resolveConfirmation(planId, trigger, decision) {
    const pending = this.confirmationRepo.getPendingByPlanAndUser(planId, trigger.userId, this.now());
    if (!pending) {
      return {
        status: "no_pending_confirmation",
        planId,
      };
    }

    if (!decision) {
      this.confirmationRepo.markCancelled(pending.confirmationId);
      const cancelledRun = {
        runId: crypto.randomUUID(),
        planId,
        planName: pending.planName,
        triggerType: "manual",
        triggerUserId: trigger.userId || null,
        triggerUserName: trigger.userName || null,
        triggerChatId: trigger.chatId || null,
        dryRun: Boolean(pending.dryRun),
        status: "cancelled",
        startedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        durationMs: 0,
        summary: {
          totalJobs: 0,
          successfulJobs: 0,
          failedJobs: 0,
          sourceRecords: 0,
          targetRecords: 0,
          matchedKeys: 0,
          affectedKeys: 0,
          changedCells: 0,
          changedRows: 0,
          missingInTarget: 0,
          missingInSource: 0,
        },
        blankRiskSummary: pending.blankRiskSummary,
        jobs: [],
      };
      this.runRepo.append(cancelledRun);
      return cancelledRun;
    }

    this.confirmationRepo.markConfirmed(pending.confirmationId);
    return this.lockService.runExclusive(planId, () => this.runPlan(planId, {
      triggerType: "manual",
      triggerUserId: trigger.userId || null,
      triggerUserName: trigger.userName || null,
      triggerChatId: trigger.chatId || null,
      dryRun: Boolean(pending.dryRun),
      confirmed: true,
      confirmationId: pending.confirmationId,
    }));
  }

  async inspectPlan(plan) {
    let target = null;
    let targetError = null;
    try {
      target = await this.sheetClient.readTarget(plan);
    } catch (error) {
      targetError = formatError(error);
    }

    if (targetError) {
      return {
        targetRows: [],
        targetMeta: null,
        jobs: plan.jobs.map((job) => {
          const effectiveRules = {
            ...plan.rules,
            allowEmptyOverwrite: job.allowEmptyOverwrite == null
              ? plan.rules.allowEmptyOverwrite
              : Boolean(job.allowEmptyOverwrite),
          };
          return {
            job,
            effectiveRules,
            sourceRows: null,
            sourceMeta: null,
            blankRisk: null,
            inspectionError: `总表读取失败：${targetError}`,
          };
        }),
        blankRiskSummary: { hasRisk: false, jobCount: 0, blankCellCount: 0, columns: [], samples: [] },
      };
    }

    const riskItems = [];
    const inspectionJobs = [];

    for (const job of plan.jobs) {
      const effectiveRules = {
        ...plan.rules,
        allowEmptyOverwrite: job.allowEmptyOverwrite == null
          ? plan.rules.allowEmptyOverwrite
          : Boolean(job.allowEmptyOverwrite),
      };

      try {
        const source = await this.sheetClient.readSource(plan, job);
        const hasConstantFields = Object.values(job.fields || {}).some(
          (fieldSpec) => fieldSpec && typeof fieldSpec === "object" && fieldSpec.constant != null,
        );
        const blankRisk = !hasConstantFields && effectiveRules.allowEmptyOverwrite
          ? detectBlankRisk(source.rows, effectiveRules, { sampleLimit: 5 })
          : null;

        inspectionJobs.push({
          job,
          effectiveRules,
          sourceRows: source.rows,
          sourceMeta: source.meta,
          blankRisk,
        });

        if (blankRisk?.requiresConfirmation) {
          riskItems.push({
            jobId: job.id,
            jobLabel: job.label,
            ...blankRisk,
          });
        }
      } catch (error) {
        inspectionJobs.push({
          job,
          effectiveRules,
          sourceRows: null,
          sourceMeta: null,
          blankRisk: null,
          inspectionError: formatError(error),
        });
      }
    }

    return {
      targetRows: target.rows,
      targetMeta: target.meta,
      jobs: inspectionJobs,
      blankRiskSummary: summarizeBlankRisks(riskItems),
    };
  }

  async runPlan(planId, trigger) {
    const plan = this.planRepo.getPlan(planId);
    if (!plan || plan.enabled === false) {
      throw new Error(`Sync plan not found or disabled: ${planId}`);
    }

    const startedAt = this.now();
    const inspection = await this.inspectPlan(plan);

    if (inspection.blankRiskSummary.hasRisk && trigger.triggerType === "manual" && !trigger.confirmed) {
      const expiresAt = new Date(
        startedAt.getTime() + (plan.manualTrigger.blankCellPolicy.confirmationTimeoutMinutes || 10) * 60 * 1000,
      );
      const pending = this.confirmationRepo.createPending({
        planId: plan.planId,
        planName: plan.name,
        triggerUserId: trigger.triggerUserId,
        triggerUserName: trigger.triggerUserName,
        triggerChatId: trigger.triggerChatId,
        dryRun: trigger.dryRun,
        blankRiskSummary: inspection.blankRiskSummary,
        expiresAt: expiresAt.toISOString(),
      });

      return {
        status: "pending_confirmation",
        planId: plan.planId,
        planName: plan.name,
        confirmationId: pending.confirmationId,
        blankRiskSummary: inspection.blankRiskSummary,
      };
    }

    if (inspection.blankRiskSummary.hasRisk && trigger.triggerType === "scheduled") {
      const finishedAt = this.now();
      const abortedRun = {
        runId: crypto.randomUUID(),
        planId: plan.planId,
        planName: plan.name,
        triggerType: "scheduled",
        triggerUserId: null,
        triggerUserName: null,
        triggerChatId: null,
        dryRun: trigger.dryRun,
        status: "aborted_blank_risk",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        summary: {
          totalJobs: plan.jobs.length,
          successfulJobs: 0,
          failedJobs: 0,
          sourceRecords: 0,
          targetRecords: 0,
          matchedKeys: 0,
          affectedKeys: 0,
          changedCells: 0,
          changedRows: 0,
          missingInTarget: 0,
          missingInSource: 0,
        },
        blankRiskSummary: inspection.blankRiskSummary,
        jobs: [],
      };
      this.runRepo.append(abortedRun);
      return abortedRun;
    }

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
    let writeResult = null;

    if (!trigger.dryRun && aggregatedResult.changes.length > 0) {
      writeResult = await this.sheetClient.applyChanges(plan, aggregatedResult);
    }

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
      triggerType: trigger.triggerType,
      triggerUserId: trigger.triggerUserId,
      triggerUserName: trigger.triggerUserName,
      triggerChatId: trigger.triggerChatId,
      dryRun: trigger.dryRun,
      confirmationId: trigger.confirmationId || null,
      status: buildRunStatus(summary),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary,
      blankRiskSummary: inspection.blankRiskSummary.hasRisk ? inspection.blankRiskSummary : null,
      jobs: jobResults,
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
};
