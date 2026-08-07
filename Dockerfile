# ---- 依赖阶段 ----
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app
# builder 是独立镜像，需重新启用 corepack（pnpm 版本由 packageManager 字段决定）
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 站点对外 URL（SSG 构建期内联到 sitemap/robots/metadata；HTTP 部署时由 compose 传入 http:// 值）
ARG SITE_URL=https://shaoyuanyu.cn
ENV SITE_URL=$SITE_URL
# 预下载导航页外部站点图标（构建环境可访问 Google/iconify；运行时不再依赖境外服务）
RUN pnpm fetch:favicons
# 从 Semantic Scholar 同步论文（失败不阻塞构建，yaml 保持原样）
RUN pnpm fetch:publications
# 构建 Next.js standalone 产物（构建时会同步生成 Velite 内容层）
RUN pnpm build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
