FROM node:24-slim

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ dist/

# Config mounted at runtime via volume
EXPOSE 3456

CMD ["node", "dist/index.js"]
