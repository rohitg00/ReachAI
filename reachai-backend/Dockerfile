FROM node:22-bookworm-slim

ARG III_RELEASE_TAG=iii/v0.23.0-rc.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://install.iii.dev/iii/main/install.sh \
     | BIN_DIR=/usr/local/bin III_USE_GLIBC=1 III_RELEASE_TAG=${III_RELEASE_TAG} sh \
  && iii --version

WORKDIR /app/reachai-backend

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p data config /home/node/.iii && chown -R node:node /app /home/node/.iii

USER node
ENV HOME=/home/node

EXPOSE 3111
STOPSIGNAL SIGINT

CMD ["iii", "compose", "--namespace", "reachai", "--up", "--file", "worker-compose.yaml"]
