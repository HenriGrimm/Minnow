FROM node:22-bookworm
WORKDIR /opt/minnow
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3 node-pty
COPY server ./server
COPY src ./src
COPY evals/harness ./evals/harness
RUN mkdir -p /runtime && cp /usr/local/bin/node /runtime/node && \
    tar -czf /runtime/minnow-runtime.tar.gz -C /opt minnow -C /runtime node
CMD ["true"]
