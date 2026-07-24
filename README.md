# Sheet Sync Web Demo

This is a local no-dependency web wrapper around the existing DingTalk sheet sync script.

It now supports running multiple branch-sheet sync jobs into one master sheet from a single preview or write action.

## What it does

- Serves a local page with preview and sync buttons
- Calls `work/dingtalk-sheet-sync-demo.js` for each configured job
- Uses your local `dws` login under `work/dws-config`
- Shows DWS auth status, configured jobs, aggregate sync summary, and per-job results

## Files

- `server.js`: local HTTP server and multi-job orchestrator
- `sync-config.json`: sync configuration
- `public/`: local control panel
- `start-server.ps1`: local startup script

## Start

From the workspace root:

```powershell
powershell -ExecutionPolicy Bypass -File .\work\sheet-sync-web\start-server.ps1
```

Or:

```cmd
.\work\sheet-sync-web\start-server.cmd
```

Open:

```text
http://127.0.0.1:3210/
```

## Formal backend

The repo now also contains a formal backend scaffold for the DingTalk bot production route:

- `src/app.js`: formal Node backend entry
- `src/config/sync-plans.json`: fixed 5-branch + 1-master sync plan
- `src/sync/core.js`: extracted pure sync logic
- `docs/production-deployment.md`: deployment and go-live notes

Start it with:

```powershell
node .\src\app.js
```

Or:

```powershell
npm run start:formal
```

## Config shape

The recommended config format is:

```json
{
  "appName": "钉钉多表同步 Demo",
  "port": 3210,
  "targetNode": "https://alidocs.dingtalk.com/i/nodes/<总表链接>",
  "targetSheet": "总表",
  "allowEmptyOverwrite": true,
  "dwsConfigDir": "..\\dws-config",
  "syncScriptPath": "..\\dingtalk-sheet-sync-demo.js",
  "syncJobs": [
    {
      "id": "branch-1",
      "label": "分表1 -> 总表",
      "sourceNode": "https://alidocs.dingtalk.com/i/nodes/<分表1链接>",
      "sourceSheet": "分表1"
    },
    {
      "id": "branch-2",
      "label": "分表2 -> 总表",
      "sourceNode": "https://alidocs.dingtalk.com/i/nodes/<分表2链接>",
      "sourceSheet": "分表2"
    }
  ]
}
```

Notes:

- `targetNode` and `targetSheet` can stay at the top level when every branch sheet syncs into the same master sheet.
- Each item in `syncJobs` can override `targetNode`, `targetSheet`, or `allowEmptyOverwrite` when needed.
- The older single-job keys (`sourceNode`, `sourceSheet`, `targetNode`, `targetSheet`) are still supported for backward compatibility.

## Current field mapping

The underlying sync script still matches rows by `货号` and applies this mapping:

- `齐色主附图完成时间` -> `齐色主附图完成时间`
- `A+完成时间` -> `A+完成日期`
- `视频完成时间` -> `视频完成日期`

## Notes

- If `dws auth status` shows not logged in, re-login into the account that can access every branch sheet and the master sheet.
- Update `sync-config.json` when any DingTalk sheet link or sheet name changes.
- `Preview All Jobs` runs every configured sync job in dry-run mode.
- `Run All Jobs` writes back into the DingTalk online master sheet for each configured job in sequence.
