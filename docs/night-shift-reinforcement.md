# Night Shift 补强任务书（v0.2.0）

> 目标：把"模型自证完成 + 盲发续跑"升级为**机械约束**——证据式完成门、空转检测、轮次留痕、goal 让位守卫。
> 依据：`docs/night-shift-competitive-notes.md` 第四节。
> 交付：修改后的完整 `packages/night-shift/src/night-shift.js`（单文件）；测试由主 Agent 编写与复核。

## 0. 硬性约束

- 保持零依赖、Node >= 20、ESM；与现有代码风格一致（不加注释、中文日志、`session=` 等格式不变）
- 规格未提及的代码**逐字保持不变**；不要重排、重命名或"顺手优化"既有函数
- `completedBy` 函数本身不动；宽松行为由新配置 `evidence: "loose"` 保留

## 1. 配置（normalize 与默认值）

新增三个顶层字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `evidence` | `"strict"` | 完成判定模式；仅 `"loose"` 关闭证据门，其余值一律视为 strict |
| `idleTurns` | `3` | 连续空转轮阈值；整数，最小 0（0 = 关闭空转检测）；非数字按默认 |
| `yieldToGoals` | `true` | 仅显式 `false` 时关闭让位守卫 |

sessions 条目新增可选 `paused` 字段，normalize 保留：

```js
.map((s) => ({ id: s.id, sent: Number(s.sent) || 0, lastSentAt: Number(s.lastSentAt) || 0, paused: !!s.paused }))
```

`writeConfig` 现有逻辑（raw 展开 + cfg 覆盖）保持不变。

## 2. 证据式完成门

### 2.1 协议

- 完成标记行仍是最后一行（`completedBy` 已覆盖）
- 证据行 = 完成标记的**上一行**，形态 `[夜间任务证据] <非空摘要>`；同样兼容 `[任务证据]`、`[task evidence]`、`【】` 归一化、粗体符号去除；摘要 trim 后必须非空
- 新增模块级纯函数：

```js
function evidenceOf(text) { ... }  // 返回摘要字符串，或 null
```

### 2.2 行为（session.idle 完成分支）

- `cfg.evidence === "loose"` → 现有行为（直接 `removeSession(sessionID, "检测到完成标记")`）
- strict 且证据非空 → `removeSession(sessionID, "检测到完成标记（证据：" + 摘要.slice(0, 60) + "）")`
- strict 且证据缺失/空：
  - 若 `st.evidenceNudged` 为 true → 仅写一行日志（`跳过：完成标记仍无证据（已提醒过一次）session=...`）后返回
  - 否则设 `st.evidenceNudged = true`，并**通过 schedule 队列**补发提示（复用 MIN_INTERVAL / busy / endAt / paused 检查）：

```js
schedule(sessionID, { text: "你输出了完成标记，但没有附上证据行。请二选一：1) 继续完成剩余工作；2) 若确实全部完成，请新输出两行：倒数第二行「[夜间任务证据] 做了什么、如何验证」，最后一行「[夜间任务完成]」。" })
```

- `st.evidenceNudged` 在**走常规续跑路径**（下一回合不带完成标记）时重置为 false

### 2.3 schedule 改造

`schedule(sessionID, opts)` 增加可选参数：`const text = opts && opts.text ? opts.text : render(fresh.message, fresh)`。其余逻辑（计数、lastSentText、节流、重试）不变。补发提示同样计入 `sent`。

## 3. 空转检测

### 3.1 判定（已用真实数据验证）

真实 assistant 消息的 parts **每轮都含 `step-start`/`step-finish`**（不可当活动信号）；工具调用只有 `type === "tool"`。

- `lastAssistant` 返回值扩展为 `{ text, hasError, hasTool, textLen }`
  - `hasTool = parts.some((p) => p && p.type === "tool")`
  - `textLen = text.length`
- 空转回合 = `!hasTool && textLen < 200`

### 3.2 计数与升级

- `st.idleStreak`：空转 → +1；非空转 → 归零；**错误回合不计数也不归零**；busy 跳过不动
- `idleTurns > 0 && st.idleStreak >= idleTurns` → 本次发送改用升级文案（经 `opts.text`）：

```
你已连续 N 轮没有实际推进（没有调用任何工具、也没有产出）。请立刻执行下一步具体操作（编辑文件、运行命令），而不是继续陈述。若确实已完成，请按证据格式结束。
```

（N 替换为 `st.idleStreak` 的实际数值）

- `st.idleStreak >= idleTurns * 2` → **会话级暂停**：`bumpSession(sessionID, { paused: true })` + 日志 `已暂停值守（连续空转 N 轮）session=...`，本次不发送

### 3.3 paused 语义

- `paused === true` 的会话：session.idle 在"已武装"检查后**直接返回**（静默，不发送、不处理完成、不提醒）；schedule 内查 entry 后也跳过
- 恢复方式：人工把配置中该会话的 `paused` 去掉或置 false（README 说明）

## 4. 轮次留痕

- 指纹取粗粒度（防噪声）：`fp = (hasTool ? "t" : "-") + (textLen < 200 ? "s" : textLen < 1000 ? "m" : "l")`
- 每次评估（错误检查之后、任何分支之前）写一行日志：

```
轮次留痕 session=<id> sent=<entry.sent> fp=<fp> changed=<yes|no>
```

（changed = 与 `st.lastFp` 是否相同，相同为 "no"）；随后更新 `st.lastFp = fp`

## 5. goal 让位守卫

- 新 async 函数 `shouldYield(sessionID)`：
  - 会话目录缓存于 `st.dir`（undefined=未查过，null=查不到）：仅当 `client.session.get` 存在时尝试一次 `infoOf(await client.session.get({ path: { id: sessionID } })).directory`；失败或不存在 → 缓存 null，本进程内不再重试
  - 目录存在且 `existsSync(join(dir, ".opencode", "goals"))` → true
- session.idle 在"已武装"检查后：`cfg.yieldToGoals && await shouldYield(sessionID)` 为真 → 状态变化时记日志（`让位：检测到活跃 goal 状态，跳过值守 session=...` / 恢复时 `恢复值守（goal 状态消失）session=...`）→ return

## 6. session.idle 处理顺序（冻结）

```
1) 基础检查：event / sessionID / cfg.enabled / 会话在武装列表
2) paused → return（静默）
3) now >= endAt → stopAll("结束时间已到") → return
4) yieldToGoals 且 shouldYield → 状态日志 + return
5) last = await lastAssistant(sessionID)
6) last.hasError → 日志"交给网络续跑插件" → return（不动 idleStreak）
7) 留痕日志（fp / changed），更新 st.lastFp
8) completedBy(last.text)：
   a) strict 且无证据 → 提醒逻辑（2.2）→ return
   b) 有证据（strict）或 loose → removeSession(...) → return
9) st.evidenceNudged = false
10) idleStreak 计算（+1 / 归零）
11) idleStreak >= idleTurns * 2 → paused + 日志 → return
12) schedule(sessionID, idleStreak >= idleTurns ? { text: 升级文案 } : undefined)
```

`stOf` 初始化新增字段：`idleStreak: 0, evidenceNudged: false, lastFp: "", dir: undefined, yielding: false`

## 7. 其他

- `DEFAULT_MESSAGE` 末段改为两行协议：

```
如果你认为已经完成：请自行 review 或运行测试验证一遍，确认无误再结束。
确认全部完成后，最后输出两行：倒数第二行以 [夜间任务证据] 开头并附一句话（做了什么、如何验证）；最后一行单独输出 [夜间任务完成]
```

## 8. 验收（主 Agent 负责）

- 新增测试：证据 strict 有效/缺失/空/事后补齐/loose 兼容；空转 3 轮升级文案、6 轮暂停、错误回合不计、工具回合清零、busy 不计；留痕 changed=no 检测；让位（目录存在/不存在/`session.get` 缺失降级）；paused 静默；配置默认值与显式覆盖
- 既有测试更新：完成类用例补证据行；mock 默认 assistant parts 增加 `{ type: "tool" }`（保证既有用例不受空转影响），空转用例单独构造纯 text parts
