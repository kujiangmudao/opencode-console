# Night Shift 竞品对标与改进建议

## 一、结论摘要

- Night Shift 仍是合理答案的场景：多会话、无（或弱）目标契约、只需「别停 + 到点下班 + 少打扰」的轻值守；以及作为 goal / loop 类引擎的补位，负责没有目标状态的会话。
- 会被竞品替代的场景：有明确目标且要求「完成可验收」的夜间长任务，用户会自然迁移到 goal 类插件；要求「不依赖 TUI 生命周期持续跑」的场景，会迁移到 loopd 类后台调度。
- 「落后」依据之一：完成判定是模型自证——末行输出 `[夜间任务完成]` 即下班，无任何外部证据门槛；而取证型竞品已把「模型自宣不可信」当作设计前提（详见矩阵行 2、4，以及 Ralph 的「只信测试/构建反压」实践）。
- 「落后」依据之二：续跑是盲发——静态模板消息、无状态感知、无空转识别、无产出留痕；模型可以整晚循环「好的我继续 / 我已完成」，而值守方无法察觉（对照矩阵行 2 的 no-progress / no-tool-call 检测、行 3 的 progress-file 惯例）。
- 「落后」依据之三：没有任何刹车与晨检面——无轮次上限、无 token/成本预算、日志只有发送次数而非「每轮发生了什么」；而市场空位也在最后一条上：当前所有竞品都在做「执行保障」重工程，没有人把「轻量多会话值守 + 晨报」做深——这正是 Night Shift 应固守并补强的差异化位置。

## 二、竞品矩阵

| 项目名 | 核心理念 | 关键机制 | 热度（来源 + 日期） | 真实用户声音（出处） |
|---|---|---|---|---|
| **Night Shift**（本项目，基线） | 夜班值守：空闲续跑 + 到点下班 + 多会话 | endTime 硬截止；末行完成标记；busy 感知；错误回合跳过；多会话独立计数；模板占位符；零依赖 | star 1；npm `opencode-night-shift` 未检索到（404）；最近推送 2026-10-14（来源：gh api / npm view，2026-10-14） | 暂无第三方公开声音（GitHub Issues 0 条，来源：gh api，2026-10-14） |
| **opencode-goal-plugin**（william-ricchiuti） | 会话级持久目标 + 证据门控完成 | idle 自动续跑；turn/时长/token/成本四重预算；`[goal:evidence]` 相邻 `[goal:complete]` 才认完成；可选独立只读子会话审计（fail-closed）；no-progress / no-tool-call 暂停；持久化 + ledger + 重启恢复；压缩上下文注入；真机验证过 OpenCode 1.17.15 / 1.18.25 / 1.18.29（含 deepseek 模型） | star 276；周下载 2163（月 7875）；0.11.0 发布于 2026-09-30（来源：gh api / npm search API / npm registry，2026-10-14） | issue #75 @pablolanga-stratio（已修复）："Persistence lease fails with ERR_GOAL_PERSISTENCE_LEASE_PATH on filesystems that cap timestamps at 2038"，环境为 OpenCode 1.18.30（来源：<https://github.com/william-ricchiuti/OpenCode-goal-plugin/issues/75>，2026-10-14 查阅；另有 #81 未关闭：0.11.0 在 Desktop/V2 下服务进程静默退出） |
| **opencode-loop / opencode-loopd**（ByBrawe） | idle-safe 调度与后台循环基础设施 | `/loop` 排程（idle / every / after）；`--verify` / `--preflight` / `--postrun`；progress-file / batch / compact-every；checkpoint；`opencode-loopd` 常驻 daemon + Windows 计划任务；`pulse-check` 只读失速告警；检测到同会话活跃 Goal 时阻止新 prompt Loop（overlap guard） | star 198；周下载 819（窗口 2026-10-05…10-11）；0.6.8 发布于 2026-10-12（来源：GitHub API / npm downloads API，2026-10-14） | issue #160 @Ravenstine（已关闭）："Idle loop seems to instruct agent every time the agent uses a shell command…"（OpenCode v1.18.30；来源：<https://github.com/ByBrawe/opencode-loop/issues/160>） |
| **@bybrawe/opencode-goal**（ByBrawe，与 loop 配套） | 宿主验证的持久 Goal（Codex 风格） | 宿主直接执行 `--check` shell 命令；文件契约 `--contains`；独立语义验证子会话；证据缺失/过期/间接一律 fail-closed；多轮节奏与防批处理；Todo 联动（Todo 不作完成证据）；continuous 模式；目标队列；V2 per-unit 会话轮转 | star 11；周下载 639（同窗口）；1.3.49 发布于 2026-10-12（来源：gh api / npm downloads API，2026-10-14） | issue #261 @rubenxyz：V2 下 unit 关闭后未派发续跑，"active Goal idle 5h+"（OpenCode 2.0.19；来源：<https://github.com/ByBrawe/opencode-goal/issues/261>） |
| **@prevalentware/opencode-goal-plugin**（prevalentWare） | Codex 风格 Goal Mode + 任务级计划 | `/goal` + 工具面；计划（phases / tasks，任务完成需证据）；complete 需 verified evidence、unmet 需具体 blocker；no-progress 暂停；预算；zh-CN locale；sidebar 状态；状态文件原子写 | star 474；周下载 4123（月 16796）；0.1.60 发布于 2026-10-10（来源：gh api / npm search API，2026-10-14） | issue #54 @wilanahattingh（未关闭）："Nothing registers on opencode 1.18.25: /goal commands and goal tools silently absent"（来源：<https://github.com/prevalentWare/opencode-goal-plugin/issues/54>） |
| **Ralph Wiggum**（Claude Code 社区技法） | 最朴素的外循环：`while :; do cat PROMPT.md \| claude-code ; done` | 每轮全新上下文；一次只做一件事；specs 目录 + fix_plan.md 待办；测试/构建作反压；git commit/tag 作进度锚点；「醒来可能面对坏掉的构建」 | 技法型，无单仓指标；原文 2025-07-14 发布，经 VentureBeat 报道（来源：<https://ghuntley.com/ralph/>，2026-10-14 查阅） | "We Put a Coding Agent in a While Loop and It Shipped 6 Repos Overnight"——YC hackathon 现场报告（来源：<https://github.com/repomirrorhq/repomirror/blob/main/repomirror.md>，经上述原文引用） |

> 采集口径：star 经 GitHub API（gh CLI）；下载量经 npm search API 或 npm downloads API（周窗口注明）；发版时间经 npm registry；用户声音取自对应 GitHub issue 原文。除标注「推测」外均为实测数据，采集日期 2026-10-14。

## 三、差距清单

### [值得抄]（我们缺、且符合「零依赖 + 简单」性格）

1. **证据式完成门**：完成标记必须附验证摘要，缺失即拒绝下班——竞品共识是「模型自宣不可信」（矩阵行 2 的 evidence gate、行 4 的 fail-closed、行 6 的「只信反压」），且纯文本解析即可实现、零依赖。
2. **空转检测**：连续无工具调用且低输出的续跑轮计数、分级处置——矩阵行 2 已用开源实现证明「纯聊天轮」可检测（其文档称 anti self-chat loop），直接对治「理直气壮说全弄好了但什么都没干」。
3. **轮次留痕（晨报）**：每轮记录产出指纹（消息长度 / 文件 mtime / 可选 git status 摘要）——矩阵行 2/3/4 的 ledger、checkpoint、progress-file 都把「无人值守可审计」当一等公民，而本项目日志只有发送次数。
4. **让位守卫**：检测到同项目 `.opencode/goals/` 存在活跃 goal 状态时，该会话跳过值守——矩阵行 3 的 overlap guard 说明「单会话单续跑作者」已是行业共识；粗粒度「存在即让位」即可（对方状态 schema 无版本承诺，此为推测风险，需文档明示）。

### [不值得抄]（看着好但增加复杂度 / 偏离定位）

1. 目标契约与成功标准语法（`--success` / `--check` / `--non-goal`）——那是 goal 引擎的核心竞争面，抄了等于重新发明 goal-plugin。
2. 独立验证子代理 / 语义审计 / fail-closed 审计链——本项目明确「不生成子代理」，且维护与上下文成本高。
3. 宿主执行验证命令（`--verify` / `--preflight`）——涉及 shell 权限模型、超时治理与跨平台问题，属 loop 类基础设施。
4. daemon / 系统计划任务 / 失速告警服务——另一种部署形态与运维面，超出「进程内值守」定位。
5. 多轮节奏、防批处理、Todo 联动、per-unit 会话轮转——编码任务专属语义，与值守场景无关。
6. TUI 侧边栏与 ACP 计划投影——需要额外 TUI 出口与宿主特性；配套看板已承担可视化，保持单包 server 插件。

### [抄不了]（受 opencode 插件系统限制）

1. **压缩后目标注入**：新版宿主未提供可靠的 system.transform / 压缩钩子（william 插件的兼容文档明确声明 1.17.15 / 1.18.10 不调用该 hook）——当前版本不可依赖。
2. **ACP 计划投影 / 原生侧边栏**：依赖宿主侧接入（prevalentware 文档指向 opencode 侧 PR 才能投影）——插件单方面做不到。
3. **跨插件续跑所有权仲裁**：插件系统没有跨插件仲裁机制，无法阻止其他插件在同一会话续跑，只能自己让位；「单会话单所有者」只能靠约定与各自守卫（与 [值得抄] 第 4 条呼应）。

## 四、建议采纳的功能点（2–3 个，宁少勿多）

### 1. 证据式完成门（Completion Evidence Gate）

- **做什么**：完成标记需与「证据行」成对出现（具体语法由实现方定，例如标记的上一行以 `[夜间任务证据]` 开头且含非空摘要）；缺失、空串或仅空白 → 不移出值守、仅发送一次「补证据或继续」提示，并将无效声称与证据文本写入日志。
- **为什么（引用矩阵）**：矩阵行 2（evidence gate）、行 4（stale / invented evidence 一律 fail-closed）、行 6（Ralph 只信测试与构建反压）。
- **验收标准**：单测覆盖四类输入（有效证据 → 移出；无证据 → 留班并提示一次；空证据 → 同前；先无证据后补齐 → 正常移出）；日志出现 accepted / rejected 两类条目；严格与宽松两档模式可切换且有测试。
- **对「零依赖 + 简单」的影响**：一个正则 + 一组日志字段；协议变化需同步 README 与模板文档；零依赖不变。

### 2. 空转检测（Idle-Turn Detection）

- **做什么**：对每个值守会话计数「无工具调用且输出低于阈值」的连续续跑轮（默认 3 轮，可配）；达阈值 → 升级续跑文案（点明上一轮无实际进展、要求给出下一步）；达 2 倍阈值 → 该会话暂停值守（不触发全局停止），由人在早上决定恢复或放弃。
- **为什么（引用矩阵）**：矩阵行 2 的 no-tool-call 检测与 no-progress 暂停；行 3/5 也均实现 no-progress；同时行 3 的 #160 说明误判风险确实存在（工具等待期被误认为轮次结束）——判定必须保守。
- **验收标准**：mock 消息测试五类轮次（有工具调用 / 纯聊天 / 低输出 / 错误结尾 / 工具等待中）；错误回合与 busy 状态不计数；日志含 stalled / paused 条目；暂停后不再发送，恢复入口文档化。
- **对「零依赖 + 简单」的影响**：每会话多两个计数器 + 读取消息 parts 类型；发送路径不改动。

### 3. 轮次留痕（Turn Trace → 晨报）

- **做什么**：每轮发送前后记录该会话的产出指纹（如最新消息 id / 文本长度；可选 git status --porcelain 计数或指定任务文件 mtime，超时或失败时降级）；连续两轮指纹相同 → 显式标注「本轮无变化」。
- **为什么（引用矩阵）**：矩阵行 2/3/4 的 ledger、checkpoint、progress-file 共同指向「无人值守必须可审计」；本项目现状无法晨检。
- **验收标准**：结构化日志每会话每轮一行（时间 / 轮次 / 指纹 / 变化标记）；「无变化」判定有单测；git 探测失败不影响发送逻辑；日志格式写入文档。
- **对「零依赖 + 简单」的影响**：只读旁路 + 追加日志；不引入新持久化格式或依赖。

## 五、不建议做的事（防功能膨胀清单）

- 不要做 `--success` / `--check` / `--non-goal` 目标契约语法。
- 不要生成子代理、不要做语义审计或独立验证器。
- 不要执行宿主验证命令（`--verify` 类）。
- 不要做 daemon、系统计划任务、失速告警服务。
- 不要做 Todo / 计划协议联动。
- 不要做 TUI 侧边栏或 ACP 投影（看板已承担展示）。
- 不要深解析第三方插件状态（最多做粗粒度「存在即让位」，并注明其非承诺性质）。
- 不要引入任何运行时依赖或新的配置文件格式；坚持单包、单配置。

## 六、给实现方的冲突提醒

1. **证据门 vs 既有完成协议**：`[夜间任务完成]` 语义发生变化，旧模板提示词与旧习惯会失效——需版本化并在 CHANGELOG / README 明示，提供宽松降级开关与迁移说明。
2. **证据补发 vs 最小间隔 / 忙感知**：补发消息也是一次真实发送，必须复用同一节流与 busy 检查；明确优先级（完成校验消息 > 常规续跑），避免与既有「被最小间隔挡住时定时补发重试」的定时器竞争（建议统一进同一队列）。
3. **endTime 硬截止 vs 证据补发**：到点后不得再补发，硬截止优先；该边界需要专门测试。
4. **空转暂停 vs 全局「收工」**：低效暂停是会话级动作，禁止复用全局停止通道；日志与看板需区分三种离场原因（完成移出 / 低效暂停 / 到点停止）。
5. **错误回合 vs 空转计数**：错误结尾的回合本来就不续跑，也不得计入空转计数，避免双重处罚。
6. **轮次指纹 vs 大仓库 / 特殊文件系统**：git status 在巨型仓库或网络盘可能慢或异常（参考 loop 的 exFAT 案例），必须超时降级为消息级指纹，绝不阻塞发送路径。
7. **与 goal / loop 类插件并存**：同会话双续跑无法仲裁（见「抄不了」第 3 条）；让位守卫是尽力而为机制，README 应明示「请勿在同一会话同时启用 Night Shift 与 goal 类插件的自动续跑」。
