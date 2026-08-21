FROM python:3.12-slim AS dependencies

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
  PIP_NO_CACHE_DIR=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY agent/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir -r /tmp/requirements.lock

FROM python:3.12-slim AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="Primalthrum Agent" \
  org.opencontainers.image.version=$VERSION
ENV PATH=/opt/venv/bin:$PATH \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 primalthrum
WORKDIR /app/agent
COPY --from=dependencies /opt/venv /opt/venv
COPY --chown=primalthrum:primalthrum agent/main.py ./main.py
COPY --chown=primalthrum:primalthrum agent/runtime ./runtime
RUN mkdir -p .primalthrum && chown primalthrum:primalthrum .primalthrum
USER primalthrum
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
