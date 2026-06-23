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
event: agent.update
data: {"node":"intake","agent":"ResearchAgent","message":"...","status":"running"}

event: agent.done
data: {"node":"done","agent":"ResearchAgent","message":"Agent stream completed","status":"done"}
```

## 验证

```bash
cd agent && ./.venv/bin/python -m unittest tests/test_stream_contract.py
cd server && pnpm test && pnpm typecheck
cd web && pnpm lint && pnpm build
```

## 目录

```text
agent/   FastAPI + LangGraph 示例图与 SSE /stream
server/  Koa + TypeScript SSE 代理
web/     React + TypeScript + Vite 研发控制台
```
