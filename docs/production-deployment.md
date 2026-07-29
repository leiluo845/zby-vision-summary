# Web 手动同步部署说明

## 部署目标

部署一个仅供授权人员访问的 Node.js Web 服务。用户打开浏览器页面后，通过“同步”按钮手动执行同步。

不需要创建钉钉机器人，不需要配置消息回调地址，也不需要部署定时任务。

## 运行条件

- Node.js 18 或更高版本
- 已安装 `dws` 命令行工具
- `dws` 使用的账号可以读取全部分表并编辑固定总表
- 服务进程能够访问持久化的 `DWS_CONFIG_DIR`
- 部署主机已使用服务运行账号完成一次 `dws` 登录

## 环境变量

```text
HOST=127.0.0.1
PORT=3210
DATA_DIR=runtime/formal-data
SYNC_PLANS_PATH=src/config/sync-plans.json
DINGTALK_PROVIDER=dws
DWS_CONFIG_DIR=../dws-config
RUN_HISTORY_LIMIT=20
SHEET_READ_CHUNK_ROWS=80
SHEET_READ_MIN_CHUNK_ROWS=1
SHEET_READ_RETRY_COUNT=3
SHEET_READ_RETRY_DELAY_MS=500
```

读取参数默认会对临时 DWS 错误重试 3 次，并以 500 毫秒为基础间隔退避。连续区域多次失败后，程序还会自动缩小分块并降级为逐列读取。未登录、权限不足、工作表不存在或配置无效不会进入重试。

Linux 无界面服务器首次部署时，以实际运行服务的账号执行一次：

```bash
export HOME=/root
export DWS_CONFIG_DIR=/opt/sheet-sync-bot/shared/dws-config
mkdir -p "$DWS_CONFIG_DIR"
dws auth login --device --format json
dws auth status --format json
```

设备登录会输出授权网址和验证码。必须在浏览器中使用有权读取分表、编辑总表的钉钉账号完成确认。`DWS_CONFIG_DIR` 必须位于不会随新版本发布而删除的持久化目录，认证文件不得提交到 Git。

应用调用 `dws` 时会继承服务进程的 `HOME`；如果服务没有提供 `HOME`，会自动使用 `DWS_CONFIG_DIR` 的上级目录，避免无界面进程无法确定用户目录。

如果通过其他机器访问，应根据网络环境调整 `HOST`，并在反向代理层增加登录认证或 IP 白名单。

## 启动

```powershell
node .\server.js
```

或者：

```powershell
npm start
```

建议在服务器上使用 `systemd`、`pm2` 或容器平台托管进程。进程常驻只用于提供页面，不会按时间自动执行同步。

## 对外接口

- `GET /healthz`
- `GET /api/status`
- `GET /api/config`
- `GET /api/last-run`
- `POST /api/sync`

项目没有机器人回调接口和内部定时触发接口。

## 安全要求

1. 不要把未加认证的页面直接暴露到公网。
2. 保持 `src/config/sync-plans.json` 中的 `writeGuard.nodeId` 和 `writeGuard.sheetId` 与总表一致。
3. 定期备份 `runtime/formal-data/runs.json`，或在不需要历史时按运维策略清理。
4. 变更分表、总表、Sheet ID 或列位置后必须重新运行自动化测试，并使用可安全修改的测试货号做人工验收。

## 上线检查

1. `npm test` 全部通过。
2. `GET /healthz` 返回 `ok: true`。
3. “配置和规则”弹窗显示 10 张分表和正确的 B-E 列映射。
4. 首页没有预览或测试按钮，页面打开后不会自动同步。
5. 使用测试货号验证空白字段可以清空总表字段。
6. 同步期间能看到完成百分比，取消浏览器确认框后不产生运行记录和表格写入。
7. 原机器人和定时接口访问时返回 404。
