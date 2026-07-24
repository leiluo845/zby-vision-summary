class PermissionGuard {
  constructor({ sheetClient }) {
    this.sheetClient = sheetClient;
  }

  async ensureManualSyncAllowed(plan, userContext) {
    if (!userContext.userId) {
      return {
        ok: false,
        message: "缺少用户身份，暂时无法校验编辑权限。",
      };
    }

    const canEdit = await this.sheetClient.userCanEditTarget(plan, userContext);
    if (!canEdit) {
      return {
        ok: false,
        message: "你当前没有该总表的编辑权限，无法手动触发同步。",
      };
    }

    return { ok: true };
  }
}

module.exports = {
  PermissionGuard,
};
