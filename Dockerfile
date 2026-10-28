FROM node:20-alpine
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
ARG APP
ENV APP=${APP}
RUN pnpm --filter ${APP} run --if-present build
CMD pnpm --filter ${APP} run start
