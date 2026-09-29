# The skills catalog in a container: nothing on your machine but Docker.
#   docker build -t skills-catalog .
#   docker run --rm skills-catalog                                   # the tests, then two developers in a script
#   docker run --rm -it skills-catalog npm --prefix qa run demo      # the one-window demo (tmux, inside the container)
#   docker run --rm -e ANTHROPIC_API_KEY skills-catalog qa/try-claude.sh selftest   # real Claude Code, end to end
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git lsof procps tmux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts @anthropic-ai/claude-code@2.1.285

USER node
WORKDIR /home/node/skills-catalog
# The packages first, so a code change doesn't reinstall them.
COPY --chown=node:node core/package.json core/package-lock.json core/
COPY --chown=node:node client/package.json client/package-lock.json client/
COPY --chown=node:node qa/package.json qa/package-lock.json qa/
RUN cd core && npm ci --ignore-scripts --no-audit --no-fund \
 && cd ../qa && npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=node:node . .
RUN cd client && npm ci --ignore-scripts --no-audit --no-fund

CMD ["sh", "-c", "cd core && npm run check && npm run try-it && cd ../client && npm run check"]
