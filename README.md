# @local/branch-discussion

给 DSH 加一条"软分支"路径：主对话继续跑，把一个**自包含的子问题**开成子会话去讨论，只把一页以内的结构化摘要带回主上下文。子会话里的工具调用、试错、长输出都不进主会话日志。

内置的 **Branch** 按钮是硬分支：fork 出一个 Session 然后切过去。这里不动主对话，也不切界面，结论回到主线程。

## 它解决什么

主会话里问"这个缓存为什么失效"往往要读十几个文件、跑几条命令，最后只需要一句"key 里带了 turn 号"。这些中间过程会永久占住主上下文，压缩时还可能被切碎。分支讨论把这段过程放到子会话，主上下文只增加一条约 300–400 token 的摘要。

## 工作原理

1. `branch_discuss` 工具调用 `ctx.subagents.startActivation({ provider: "branch", delivery, request })`。
2. 本插件注册的 `branch` provider 在 `prepareContinuable` 里把父会话日志**截到当前 step 的第一个 assistant 输出之前**——保留父请求与已完成的工具结果，丢掉在飞的这一步（包括正在调用的这个工具和并行的兄弟调用）。
3. 用 `buildForkSeed` 的逻辑补 `session/end-seed {inherited:true}` 与 `forked` 收尾事件（未回填的工具调用会得到一条可执行的恢复提示），再交给 `agents.create`。
4. 子会话被要求以 `structured_output` 交回结构化摘要；插件把它压到固定字数，渲染成文本作为工具结果（`wait`）或完成通知（`async`）。

为什么不用内置 `fork` provider：它只截到上一个 `turn/end`，在一轮中途调用时子会话根本看不到本轮的请求和已有的工具结果。

## 和上下文插件的关系

本插件只管**别让新污染进来**，不管压缩。压缩交给专门的插件（本机是 billion-context / ACP 的 `compress`、`decompress`、`search_context`）。两者互补，不要互相代劳：

- 不要在本插件之上再自己压会话：ACP 的 bundle patch 已经把 DSH 原生 `compaction-basic` 的 auto 关掉，且会把落地的原生 checkpoint 判成 compression conflict（覆盖它依赖的压缩基底）。
- 结论回来先复述、长结论落文件——这是从旧的 `context-offload` 插件继承下来的纪律：没复述的摘要，压缩时最先丢。
- 切点安全：任何切分都不许把 `tool-call` 和它的 `tool/result` 拆开。这条由测试 `the cut never splits a tool call from its result` 守着。

## 安装

插件目录放到 `E:\VScode\插件\branch-discussion`（本仓库），然后在 DSH profile 里挂载。

1. `C:\Users\biao\.dsh\profiles\desktop\package.json` 的 `dependencies` 增加：

   ```json
   "@local/branch-discussion": "link:E:/VScode/插件/branch-discussion"
   ```

2. 同一文件 `dsh.profile.bundles` 数组追加 `"@local/branch-discussion"`（顺序即加载顺序，放在 `@deepseek-ai/dsh-base` 之后即可）。

3. 在 profile 目录执行 `pnpm install`（会重建 node_modules 链接）。

4. 重启 DSH。插件列表里应出现"分支讨论"。

要在 profile 的 `cordis.patch.yml` 里改配置时，按 id 匹配：

```yaml
- id: branch-discussion
  config:
    timeoutMs: 900000
```

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `branch` | 注册的 provider 名。改成别的名字时需同步 profile 里的指向，一般不用动。 |
| `timeoutMs` | `600000` | `wait` 模式最多等多久；超时不取消子会话，只是把"仍在进行"返回给模型。 |
| `digestChars` | `1600` | 摘要总字数上限，超出按字段预算截断。想更省上下文就调到 800。 |
| `command` | `true` | 是否注册 `/branch` 命令。 |

## 使用

- **模型侧**：`branch_discuss({ question, focus?, mode?, label? })`。`question` 必须自包含——子会话看不到你当前 step 的推理。
- **用户侧**：`/branch <子问题>` 在命令面板里讨论，结论留在面板（完全不进模型上下文）；`/branch <子问题> --async` 后台跑，完成通知会作为新的一轮回到主线程。

何时值得分支：预计 5 次以上工具调用、对比几种方案、验证一个假设、结论能压到一页。不值得：一次读文件就能定、需要用户拍板、要逐字引用主对话、本身就是要改代码。

## 限制（都是设计取舍，不是 bug）

- **子会话只读**：委派策略里 `approvalPolicy` 固定为 `"never"`，子会话无法向你要审批，所以只能读、搜索、跑只读命令。要写代码请用 worktree 并行，而不是分支讨论。
- **看不到在飞步骤**：切点在本 step 的 assistant 输出之前，所以子会话不知道你此刻为什么开分支——问题必须写清楚。
- **同一模型才有缓存收益**：子会话与父会话同 provider/model/preset 时前缀 KV cache 可复用；换模型或换 preset 会断。
- **摘要仍有成本**：1600 字符上限约 400 token，分支越多越明显。不要为小问题开分支。
- **子会话在父会话页头可见**：它经 subagent 服务创建，会登记进父会话谱系；关掉父会话后子会话只能冷恢复。
- **并发上限**：`maxActiveSubagents` 默认 8、`maxDepth` 默认 1。分支子会话默认不能再开子代理。
- **超时不等于取消**：`wait` 超时后子会话继续跑，但不会自动回报；去父会话页头展开查看。

## 测试

```bash
node test/branch.test.mjs        # 17 个单元测试：切点、seed、摘要截断、注册与执行路径
node test/validate-schema.mjs    # 用真实 DSH 校验器编译 parameters / output / DIGEST_SCHEMA
```

（`node --test` 在受限沙箱里会因 spawn EPERM 失败，直接用 node 运行测试文件即可。）

## 后续可做

- 客户端按钮：在 `conversation.chat.assistant-actions` 加"在分支中讨论"，走 Host Remote 调用同一个 provider。
- 多个分支并行后自动汇总（`workflow` 的 fan-out 语义）。
- 子会话完成后把手头的文件清单/结论指纹写进父会话的 `subagent/catalog` 卡片。
