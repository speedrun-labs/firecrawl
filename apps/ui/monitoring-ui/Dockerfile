# syntax=docker/dockerfile:1.6

# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app

# Build-time API config (baked into the bundle)
ARG VITE_FIRECRAWL_API_URL=http://localhost:3002
ARG VITE_FIRECRAWL_API_KEY=
ENV VITE_FIRECRAWL_API_URL=$VITE_FIRECRAWL_API_URL
ENV VITE_FIRECRAWL_API_KEY=$VITE_FIRECRAWL_API_KEY

RUN corepack enable

COPY package.json ./
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm build

# --- Serve stage ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
