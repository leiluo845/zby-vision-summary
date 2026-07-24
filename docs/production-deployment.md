# 钉钉机器人正式版部署说明

## 推荐部署位置

推荐把这套代码部署到公司控制的云上 Linux 环境，而不是任何个人电脑。

优先推荐：

1. 公司已有容器平台：部署为一个 Node 容器服务
2. 如果暂时没有容器平台：部署到一台公司云主机，例如阿里云 ECS

我更推荐你们第一期直接上：

- 一台公司云主机或一个公司容器服务
- 一个公网 HTTPS 域名
- 一个钉钉企业内部应用机器人

原因很简单：

- 钉钉回调需要稳定的公网 HTTPS 地址
- 企业内部应用 `AppKey/AppSecret` 应由公司持有
- 服务应能在你离职后继续由公司运维

## 第一阶段建议架构

第一期不必拆太复杂，直接 1 个服务先跑通：

- `api + scheduler` 同一个 Node 进程
- 配置文件使用 [src/config/sync-plans.json](/C:/Users/Administrator/Documents/Codex/2026-07-02/new-chat/work/sheet-sync-web/src/config/sync-plans.json)
- 运行记录和待确认先落本地磁盘目录 `runtime/formal-data`

等你们业务稳定后，再升级成：

- `api-service`
- `worker-service`
- `redis`
- `mysql/postgres`

## 你现在这份代码应该部署到哪里

如果你问的是最实际、最容易上线的选项，我建议：

1. 部署到公司云上的一台 Linux 服务器，例如阿里云 ECS Ubuntu
2. 用 `pm2` 或 `systemd` 托管 `node src/app.js`
3. 用 `nginx` 反向代理到 Node 服务
4. 给 `nginx` 配一个公网 HTTPS 域名
5. 在钉钉开发者后台把机器人回调地址指向这个 HTTPS 地址

这条路线最稳，也最适合你当前这个项目阶段。

## 生产环境建议目录

```text
/opt/sheet-sync-bot/
  current/
    src/
    package.json
    runtime/
  shared/
    logs/
```

## 生产环境变量

至少需要这些环境变量：

```bash
HOST=0.0.0.0
PORT=3320
APP_TIMEZONE=Asia/Shanghai
DATA_DIR=runtime/formal-data
SYNC_PLANS_PATH=src/config/sync-plans.json
SCHEDULER_ENABLED=true
DINGTALK_PROVIDER=openapi
DINGTALK_API_BASE_URL=https://api.dingtalk.com
DINGTALK_APP_KEY=你的企业内部应用AppKey
DINGTALK_APP_SECRET=你的企业内部应用AppSecret
```

本地联调用的：

- `MOCK_EDITABLE_USERS`
- `MOCK_SOURCE_CSV`
- `MOCK_TARGET_CSV`

这些不要带到生产。

## 钉钉后台你要配置什么

你需要在钉钉开放平台做这几件事：

1. 创建企业内部应用
2. 给应用开启机器人能力
3. 配置消息回调地址
4. 配置机器人欢迎页或首页卡片所需能力
5. 给应用申请表格/文档访问权限
6. 给应用申请发送机器人消息所需权限

回调地址建议映射为：

- `POST /api/dingtalk/callback`
- `GET /api/dingtalk/home-card`

## 服务对外接口

这次已经落好的正式版接口有：

- `GET /healthz`
- `GET /api/dingtalk/home-card`
- `POST /api/dingtalk/callback`
- `POST /api/internal/sync-plans/:planId/run`
- `GET /api/internal/sync-plans/:planId/last-run`

## 生产上线顺序

建议按这个顺序走：

1. 先用 `mock` 模式在测试机把接口跑起来
2. 确认机器人命令流转没问题
3. 把 `DINGTALK_PROVIDER` 切成 `openapi`
4. 在 [src/dingtalk/sheet-client.js](/C:/Users/Administrator/Documents/Codex/2026-07-02/new-chat/work/sheet-sync-web/src/dingtalk/sheet-client.js) 里补齐你们企业最终确认的钉钉表格读写接口
5. 补齐“用户是否可编辑总表”的权限查询接口
6. 在测试群灰度
7. 再切生产群

## 当前代码的完成度说明

这次代码已经把这些正式版骨架写好了：

- 固定计划配置
- 自动调度时间计算
- 手动同步入口
- 最近同步记录
- 空白风险二次确认
- 待确认状态存储
- 运行记录存储
- 健康检查和内部触发接口

还需要你们企业最终联调补齐的，是这 2 类真实钉钉能力：

1. 表格读取 / 写回 OpenAPI 适配
2. 目标总表编辑权限查询适配

这两处入口都已经预留在 [src/dingtalk/sheet-client.js](/C:/Users/Administrator/Documents/Codex/2026-07-02/new-chat/work/sheet-sync-web/src/dingtalk/sheet-client.js)。
