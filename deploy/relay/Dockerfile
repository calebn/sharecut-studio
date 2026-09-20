FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.32.0" \
    "websockets>=12.0"

ARG PODCAST_RELAY_VERSION=
ARG PODCAST_RELAY_GIT_SHA=
ENV PODCAST_RELAY_VERSION=${PODCAST_RELAY_VERSION}
ENV PODCAST_RELAY_GIT_SHA=${PODCAST_RELAY_GIT_SHA}

# Relay package + the FOSS util modules it imports (rate limits, body caps, proxy path checks,
# and shared guest WebSocket protocol limits).
# util/__init__.py pulls review/text, so copy those too.
COPY src/podcast_mcp/__init__.py podcast_mcp/__init__.py
COPY src/podcast_mcp/util/__init__.py podcast_mcp/util/__init__.py
COPY src/podcast_mcp/util/review.py podcast_mcp/util/review.py
COPY src/podcast_mcp/util/text.py podcast_mcp/util/text.py
COPY src/podcast_mcp/util/rate_limit.py podcast_mcp/util/rate_limit.py
COPY src/podcast_mcp/util/body_limits.py podcast_mcp/util/body_limits.py
COPY src/podcast_mcp/util/proxy_paths.py podcast_mcp/util/proxy_paths.py
COPY src/podcast_mcp/util/ws_limits.py podcast_mcp/util/ws_limits.py
COPY src/podcast_relay/ podcast_relay/
COPY deploy/relay/VERSION podcast_relay/VERSION

EXPOSE 8081

ENV PODCAST_RELAY_HOST=0.0.0.0
ENV PODCAST_RELAY_PORT=8081

CMD ["python", "-m", "podcast_relay.app"]
