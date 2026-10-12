# 合同提炼的本机模型适配

本次仅完成代码和模拟测试，运行中服务仍使用原配置。用户先审查 OpenHarvey 的合同记忆测试包 v2，再批准真实调用与部署。

contract 模式通过 `CONTRACT_MEMORY_MODEL_CONFIG` 指向只读私有 JSON。该配置只改变 `MemoryCore/src/contract-memory` 的 L1、L2、L3 与冲突分析；普通 chat/code 管线及 Proxy 业务模型继续独立配置。未设置环境变量时保持原 API 路径。

配置示例位于 `deploy/contract-memory/contract-model.example.json`，默认 `codex_subscription` / `gpt-6.1-sol`。Core 向本机 `/v1/structured-completions` 发送 role、model、stage、prompt、input、request_id；服务按固定阶段选择输出 Schema。返回 request_id、status、output 和模型元数据，Core 核验角色、阶段、请求和模型名称后才继续来源校验与候选保存。

本机适配器位于 OpenHarvey 的 `openharvey_contract_memory_pack/07_tools/structured_model.py`。它使用官方 Codex CLI 的订阅登录和结构化输出，独立临时会话，忽略用户配置与规则，关闭 shell、应用、浏览器、记忆和多 Agent 工具；遇到工具事件或无效输出失败。不会复制 OAuth token 到 API Key 配置，也不会给提炼模型通用执行权限。

抽取与 judge 使用不同角色配置、会话、输入及适配令牌。Core 只获得 extraction token。judge 不写入记忆，只有评分流程能读取独立 rubric。CLI 不回报实际模型名称时保存 actual_model=null / model_verified=false，不伪报已验证型号。

后续用户审查通过后，启动带审查包哈希的适配器，再使用部署脚本 `start --contract-model-config /path/private/contract-model.json` 显式重建。令牌从配置指定的环境变量写入原私有 core.env，文件权限0600；模型配置只读挂载。单纯 restart 不改变配置。Docker 到 host.docker.internal 的 loopback 连通性需届时验证，不能因为连接失败自动开放公共监听或切换模型。

失败、超时、限额及模型标识不符都会保留为失败；不自动切换 API 备选。来源范围、版本、候选确认、人工保护和审核规则保持原实现。

离线检查使用 `MemoryCore/tests/contract-completion.test.ts` 与已有 contract-memory 测试，HTTP fetch 均为模拟响应。官方调用依据：[认证](https://learn.chatgpt.com/docs/auth)、[非交互与结构化输出](https://learn.chatgpt.com/docs/non-interactive-mode)。
