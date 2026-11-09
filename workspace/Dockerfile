FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl wget git zip unzip tar gzip xz-utils jq \
       python3 python3-venv python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin workspace

WORKDIR /workspace
USER 10001:10001
CMD ["sh"]
