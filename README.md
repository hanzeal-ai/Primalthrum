# Primalthrum

Primalthrum 正在从研发 Agent 项目骨架演进为商业级多租户 Agent SaaS：用户通过语音或文字对话创建 Agent，并直接在托管 Web 页面中使用。Python Agent 负责 LangGraph 执行，Node 服务端负责平台、计费与统一流接口，React + TypeScript + Vite 负责官网和产品体验。

当前产品版本：`1.0.0`

## 架构

```text
web    React + TypeScript + Vite  http://127.0.0.1:5173
server Node + Koa                 http://127.0.0.1:3000
agent  Python + FastAPI + LangGraph http://127.0.0.1:8000
```

流式链路：

```text
Web POST /api/stream
  -> Node POST /api/stream
  -> Agent POST /stream
  <- text/event-stream (canonical database event IDs)
```

已保存 Agent 的流请求支持 `Idempotency-Key`，服务端通过响应头返回 Run、
Conversation 和幂等键。客户端断线后可使用同一幂等键及 `Last-Event-ID`
继续接收尚未消费的事件；终态 Run 会直接回放，不会重复调用模型。

工作区 Owner/Admin 可从 Builder 的设置入口维护 LLM 与 Embedding Provider。
API Key 只允许首次写入或轮换，读取与编辑接口不会返回密钥明文；已配置的
LLM 会立即出现在 Agent 创建对话的模型选项中。

同一设置抽屉提供运行能力管理。LLM、Embedding、Tool、Skill、Memory、
Cache、RAG、STT 和 TTS 使用统一版本化 manifest；可用能力支持工作区级
启停，planned 能力保持只读。每次 Run 固化能力快照，因此设置变更只影响
后续 Run。

知识文件通过受控上传协议写入，当前支持 UTF-8 TXT、Markdown、JSON 和
CSV。服务端在落库前校验扩展名与 MIME、Base64、内容格式和 2 MiB 上限，
并记录规范 MIME 与字节数；浏览器端同时限制单次最多 4 个文件和 2 MiB
总大小。索引请求进入可恢复的持久化 Job 队列；文档按确定性重叠窗口分块，
启用 RAG 时由所选 Embedding Provider 生成向量，并连同模型及向量库标识
持久化，供运行时按兼容配置检索。Builder 当前可明确选择不启用 RAG、
内置 SQLite 向量库或查看计划中的 Chroma，并为启用的向量库选择已配置的
Embedding Provider；检索命中会随消息返回来源。

## 快速启动

```bash
bash start.sh
```

默认使用 5173/3000/8000；若端口被占用，脚本会自动递增选择可用端口并打印实际地址。

可选环境变量：

```bash
PYTHON_BIN=python3.12 AGENT_PORT=8000 PORT=3000 WEB_PORT=5173 bash start.sh
```

## API

Agent 元数据与生成：

```bash
curl http://127.0.0.1:3000/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "name":"Research Agent",
    "description":"Research assistant",
    "memoryProvider":"sqlite",
    "cacheProvider":"sqlite",
    "ragProvider":"in-memory",
    "enabledTools":["file_reader"],
    "enabledSkills":["research"]
  }'

curl -X POST http://127.0.0.1:3000/api/agents/1/generate
```

Node 对外接口：

```bash
curl -N http://127.0.0.1:3000/api/stream \
  -H 'content-type: application/json' \
  -d '{"agent":"ResearchAgent","goal":"Create a research agent","tools":["planner","memory"]}'
```

Agent 内部接口：

```bash
curl -N http://127.0.0.1:8000/stream \
  -H 'content-type: application/json' \
  -d '{"agent":"ResearchAgent","goal":"Create a research agent","tools":["planner"]}'
```

`POST /internal/embeddings` 仅供 Node 服务端批量生成索引和查询向量，生产
部署应将 Agent 服务放在受信任的内部网络，不直接暴露该接口。

语音采用可控的链式管线。Web 录音由 Node 的认证接口受理，Node 解析工作区
加密 STT/TTS 配置后调用 Agent 的 `/internal/speech/transcriptions` 与
`/internal/speech/synthesis`；Agent 再访问 OpenAI-compatible Audio API。没有
配置 STT/TTS 时，Web 会在浏览器支持的情况下回退到原生语音识别与朗读；工作区
关闭对应能力后，服务端会拒绝语音请求。

事件格式：

```text
event: agent.run.started
data: {"node":"run","agent":"ResearchAgent","message":"Agent run started","status":"running"}

event: agent.node.completed
data: {"node":"intake","agent":"ResearchAgent","message":"...","status":"running"}

event: agent.run.completed
data: {"node":"done","agent":"ResearchAgent","message":"Agent stream completed","status":"done"}
```

## 验证

一条命令执行基础 smoke 验证：

```bash
scripts/smoke.sh
```

完整商业关键路径 smoke：

```bash
scripts/commercial-smoke.sh
```

真实 S3-compatible 对象存储与版本控制 smoke（需要 Docker）：

```bash
scripts/object-storage-smoke.sh
```

真实 PostgreSQL 连接池、参数绑定与事务 smoke（需要 Docker）：

```bash
scripts/postgres-smoke.sh
```

商业授权基础接口：

- `GET /api/public/plans`：公开套餐与权益目录。
- `GET /api/billing/summary`：当前工作区套餐、权益和额度余额。
- `POST /api/billing/trial`：领取一次性 Pro 试用。
- `POST /api/billing/checkout`：创建托管订阅 Checkout。
- `POST /api/billing/portal`：打开托管账单门户。
- `POST /api/billing/subscription/change`：请求升级或降级，等待 Webhook 确认。
- `POST /api/billing/subscription/cancel`：计划在周期结束时取消。
- `GET /api/billing/invoices`：读取工作区发票历史。
- `GET /api/billing/usage`：读取周期用量、credits 与供应商成本。
- `GET/PUT /api/billing/cost-controls`：读取或维护工作区成本上限。
- `GET /api/billing/cost-alerts`：读取持久化阈值告警。
- `GET /api/workspaces/:id/members`：读取当前工作区成员。
- `PATCH/DELETE /api/workspaces/:id/members/:userId`：修改角色或移除成员。
- `PUT /api/workspaces/:id/ownership`：当前 Owner 重新认证并原子转移所有权。
- `GET/POST /api/workspaces/:id/invitations`：读取或创建受席位限制的邀请。
- `DELETE /api/workspaces/:id/invitations/:invitationId`：撤销待处理邀请。
- `POST /api/invitations/accept`：接受一次性邀请并建立工作区会话。
- `GET/POST /api/settings/api-keys`：读取或创建作用域受限的 Workspace API Key。
- `DELETE /api/settings/api-keys/:id`：立即撤销 API Key。
- `GET /api/settings/sessions`：读取当前账号的有效登录会话。
- `DELETE /api/settings/sessions/:id`：退出指定的其他会话。
- `POST /api/settings/sessions/revoke-others`：退出当前账号的全部其他会话。
- `GET/POST/DELETE /api/settings/mfa`：读取、启用或关闭当前账号的多因素认证。
- `POST /api/settings/mfa/confirm`：确认身份验证器并一次性返回恢复码。
- `POST /api/settings/mfa/recovery-codes`：密码和 TOTP 复验后重置恢复码。
- `POST /api/auth/mfa/verify`：完成登录或邀请接受的二次验证挑战。
- `GET/PUT /api/settings/retention`：读取或维护工作区数据留存策略。
- `POST /api/settings/retention/enforce`：密码复验后立即执行留存清理。
- `GET/POST /api/operator/legal-holds`：受限 Operator 读取或放置 Workspace 法务保全。
- `POST /api/operator/legal-holds/:id/release`：由第二名授权 Operator 复核释放保全。

账本生命周期与不变量见 [Billing Entitlements And Credit Ledger](docs/BILLING_LEDGER.md)。
Stripe 配置、Webhook 和沙箱发布门禁见 [Stripe Payments And Subscription Lifecycle](docs/STRIPE_PAYMENTS.md)。
版本化计量价格、供应商成本与预算控制见 [Usage Rating And Cost Controls](docs/USAGE_RATING.md)。
API Key 和登录会话安全契约见 [API Keys And Session Security](docs/API_KEYS_AND_SESSIONS.md)。
多因素认证、恢复码和登录挑战安全契约见 [Multi-Factor Authentication Security](docs/MFA_SECURITY.md)。
工作区留存范围、执行和审计边界见 [Workspace Data Retention](docs/DATA_RETENTION.md)。
法务保全、双人释放和应急处置见 [Workspace Legal Holds](docs/LEGAL_HOLDS.md)。
独立运营身份、角色权限、限时支持授权和审计契约见 [Operator Control Plane](docs/OPERATOR_CONTROL_PLANE.md)。

分段执行：

```bash
cd agent && ./.venv/bin/python -m unittest tests/test_runtime_registry.py tests/test_stream_contract.py
cd server && pnpm test && pnpm typecheck
cd web && pnpm lint && pnpm build
```

## 目录

```text
agent/   FastAPI + LangGraph 示例图与 SSE /stream
server/  Koa + TypeScript SSE 代理
web/     React + TypeScript + Vite 研发控制台
```

## 扩展

- [Commercial Product Specification](docs/COMMERCIAL_PRODUCT_SPEC.md): 商业官网、试用订阅、托管 Agent、计费、多租户、安全和发布门禁的目标合同。
- [AI Iteration Plan](docs/AI_ITERATION_PLAN.md): P1-P14 原型历史与 P15-P24 商业 SaaS 执行队列。

- [Provider Extension Guide](docs/PROVIDER_EXTENSION_GUIDE.md): 添加 Memory、Cache、RAG、LLM provider 的接口、注册和测试规则。
- [Tool And Skill Authoring Guide](docs/TOOL_SKILL_AUTHORING_GUIDE.md): 添加工具、技能包和危险工具策略的规则。
- [Install Guide](docs/INSTALL_GUIDE.md): 本地或单节点商业试点安装步骤。
- [Upgrade Guide](docs/UPGRADE_GUIDE.md): 升级前备份、迁移、验证和重启步骤。
- [User Workflow Guide](docs/USER_WORKFLOW_GUIDE.md): Web 控制台核心用户流程。
- [Troubleshooting](docs/TROUBLESHOOTING.md): readiness、认证、provider、文档索引、stream 和 metrics 故障排查。
- [Database Migrations](docs/MIGRATIONS.md): 运行和维护 server SQLite 迁移。
- [Postgres Persistence Path](docs/POSTGRES_PERSISTENCE.md): SQLite 与 Postgres 部署选择和迁移准备。
- [SQLite To PostgreSQL Transfer](docs/SQLITE_TO_POSTGRES_TRANSFER.md): 维护窗口、全表事务迁移、逐表摘要核对与切换回退流程。
- [File Storage](docs/FILE_STORAGE.md): 本地开发与生产 S3-compatible provider、生命周期和真实 smoke。
- [Backup And Restore](docs/BACKUP_RESTORE.md): 本地及对象存储的备份边界、恢复顺序和验证要求。
- [Error Taxonomy](docs/ERROR_TAXONOMY.md): run、job、provider config、document API 的标准错误响应和结构化日志规则。
- [Health And Metrics](docs/HEALTH_METRICS.md): 生产健康检查、readiness 探针和 Prometheus 指标导出。
- [Operator Setup](docs/OPERATOR_SETUP.md): 首次运营者从创建管理员到完成首个 Agent 运行的检查清单。
- [Operator Control Plane](docs/OPERATOR_CONTROL_PLANE.md): 独立运营账号、RBAC、支持授权与不可变审计。
- [Demo Research Agent](docs/DEMO_RESEARCH_AGENT.md): 可用于演示的 Research Agent 配置、知识文档和 smoke 命令。
- [Security And Release Checklist](docs/SECURITY_RELEASE_CHECKLIST.md): 商业发布前的安全、secrets、危险工具、备份和文档 gate。
- [Multi-Factor Authentication Security](docs/MFA_SECURITY.md): TOTP、恢复码、邀请挑战、角色矩阵与生产运维要求。
- [Workspace Data Retention](docs/DATA_RETENTION.md): 客户留存策略、自动执行、文件清理和审计保留边界。
- [Workspace Legal Holds](docs/LEGAL_HOLDS.md): 强制保全范围、Operator 权限、双人释放和运维程序。
- [Release Gate](docs/RELEASE_GATE.md): 版本规则、发布 gate 和商业就绪证据。
