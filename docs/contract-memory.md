# 独立合同记忆组件

基线为 TencentDB Agent Memory `8b86874a2daea49e3ff0fb53d699203146c5c77d`，开发分支 `codex/contract-memory`。

`MemoryCore/src/contract-memory` 保存合同模式的 L0 原始记录、L1 原子记录、L2/L3 候选与正式条目、版本、共享申请、删除标记和审计。SQLite 是本轮的事实来源；scenario/core 接口提供从有效正式条目构造的召回视图。原有 chat/code 管线和数据不自动迁入。

合同 Agent 通过受管理元数据 `prompt_mode=contract` 启用。个人范围：实例＋Team＋Agent＋User；团队范围：实例＋Team＋Agent，只读取审核发布内容。正常 User Key、有效团队成员和 Agent 状态每次检查；Task 必须属于同团队和请求用户。

## 接口

`POST /v3/contract-memory/{action}`，通用身份字段为 `team_id`、`agent_id`；实际 User 从 `x-tdai-user-key` 解析。`x-tdai-service-id` 选择部署实例。

- 读取：list、detail、candidates、proposals、sources。
- 控制端写入：context、create、update、delete、confirm、ignore、propose、review、retry。
- 受控 Proxy 记录：capture-tools、capture-events；兼容 conversation/add。
- 身份管理：user-status，仅初始化 system_admin 凭据可调用。

写入同时要求组件控制凭据（Bearer，与 `CONTRACT_MEMORY_CONTROL_KEY` 匹配）；Agent 的普通 User Key 单独不能确认或修改正式内容，也不能提交假证据上下文。Proxy 与业务后端分别持有该控制凭据，模型的只读 curl 桥接不暴露它。旧 scenario/write、core/write、atomic/update 等不能绕过合同确认流程。

业务写入携带 `operation_id`；相同请求重试返回原结果。修改与团队申请携带 `version`，过期返回 409。正式条目与审计在同一事务提交。来源与权限字段不能由抽取模型设置。

候选不参与召回；人工决定受保护，同来源忽略或删除不会自动复活。真实新依据可以产生新草稿。后台最多三次自动尝试，失败可由业务面板显式 retry。长工具输出分块记录并在提炼前完整还原；文档证据必须对应原生 read 工具、受管理原文路径、版本、段落与内容哈希。

## 本机运行

```sh
python3 deploy/contract-memory/manage.py start
python3 deploy/contract-memory/manage.py stop
python3 deploy/contract-memory/manage.py restart
```

默认从原独立部署的配置复制模型设置到忽略的 `deploy/contract-memory/state`，使用单独数据卷和网络。Core 暴露在 127.0.0.1:8430，Proxy 在 127.0.0.1:8106。

`admin.key` 仅用于初始化和身份维护；`control.key` 用于受控写入；两者权限 0600，不能进入 Agent 目录。`core.env`、模型配置和部署记录均保存在忽略的 state 中。构建以固定上游镜像 digest 为基础，复制本分支源码；部署记录包含镜像 ID、Git 状态与源码内容哈希。

`deepseek-flash` 的合同提炼使用非思考模式、固定温度和 JSON 输出校验；正式内容仍需人工确认。接口参数依据 [DeepSeek 官方思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)。同一组合成输入的 code/contract 对照及业务验收记录保存在 OpenHarvey 分支的 `docs/evidence/contract-memory`。

测试：在 MemoryCore 目录使用已安装的 tsx 运行 `node --import tsx --test tests/contract-memory.test.ts`。对照实验脚本 `tests/contract-comparison.ts` 需要显式传入私有 gateway 配置和结果输出路径，执行时会调用真实模型。
