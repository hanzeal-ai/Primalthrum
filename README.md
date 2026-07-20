# Primalthrum

Primalthrum 是一个研发 Agent 项目骨架：Python Agent 负责 LangGraph 执行，Node 服务端负责统一 API 与 SSE 代理，React + TypeScript + Vite 前端负责交互式研发控制台。

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
  <- text/event-stream
```

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

- [Provider Extension Guide](docs/PROVIDER_EXTENSION_GUIDE.md): 添加 Memory、Cache、RAG、LLM provider 的接口、注册和测试规则。
- [Tool And Skill Authoring Guide](docs/TOOL_SKILL_AUTHORING_GUIDE.md): 添加工具、技能包和危险工具策略的规则。
- [Install Guide](docs/INSTALL_GUIDE.md): 本地或单节点商业试点安装步骤。
- [Upgrade Guide](docs/UPGRADE_GUIDE.md): 升级前备份、迁移、验证和重启步骤。
- [User Workflow Guide](docs/USER_WORKFLOW_GUIDE.md): Web 控制台核心用户流程。
- [Troubleshooting](docs/TROUBLESHOOTING.md): readiness、认证、provider、文档索引、stream 和 metrics 故障排查。
- [Database Migrations](docs/MIGRATIONS.md): 运行和维护 server SQLite 迁移。
- [Postgres Persistence Path](docs/POSTGRES_PERSISTENCE.md): SQLite 与 Postgres 部署选择和迁移准备。
- [File Storage](docs/FILE_STORAGE.md): 文档文件存储 provider、默认本地目录和部署环境变量。
- [Backup And Restore](docs/BACKUP_RESTORE.md): 本地 metadata DB 与文档文件的备份恢复命令。
- [Error Taxonomy](docs/ERROR_TAXONOMY.md): run、job、provider config、document API 的标准错误响应和结构化日志规则。
- [Health And Metrics](docs/HEALTH_METRICS.md): 生产健康检查、readiness 探针和 Prometheus 指标导出。
- [Operator Setup](docs/OPERATOR_SETUP.md): 首次运营者从创建管理员到完成首个 Agent 运行的检查清单。
- [Demo Research Agent](docs/DEMO_RESEARCH_AGENT.md): 可用于演示的 Research Agent 配置、知识文档和 smoke 命令。
