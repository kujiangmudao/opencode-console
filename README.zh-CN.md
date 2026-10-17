# OpenCode 控制台

给 [opencode](https://opencode.ai) 做的一套零依赖轻量工具：夜班值守插件 + 本地用量控制台。

| 组件 | 是什么 | 位置 |
| --- | --- | --- |
| **Night Shift 夜班** | opencode 插件——你睡觉时让武装的会话继续干活，到点自动下班。多会话、忙时不插队、证据式完成门、空转检测、零依赖、37 个测试。 | [`packages/night-shift/`](packages/night-shift/) · npm `opencode-night-shift`（即将发布） |
| **控制台** | 本地 Web 控制台——DeepSeek 官方人民币计价账本（区分缓存命中与峰谷）、按轮次花费归因、子代理花费并入主代理、会话分析、夜班启停控制，以及**会话清理台**（删除前自动归档进永久账本 + 一键紧凑化 VACUUM）。只读本地 opencode 数据，不联网。 | [`dashboard/`](dashboard/) |

## 快速开始

夜班插件：

```bash
# 在本仓库内
cp packages/night-shift/src/night-shift.js ~/.config/opencode/plugins/
# 重启 opencode；之后用控制台或配置文件武装会话
```

控制台：

```bash
node dashboard/server.js          # 打开 http://127.0.0.1:8787
# Windows 直接双击 dashboard\start.bat
```

## 状态

- **Night Shift**：`v0.1.0` 已打标，CI 全绿（Linux + Windows × Node 20/22）；npm 即将发布。
- **控制台**：开源化整理进行中（路径自适应、schema 检测、provider 边界）。

## License

MIT
