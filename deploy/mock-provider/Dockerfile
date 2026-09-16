FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production
USER node
EXPOSE 4010
CMD ["node", "server.mjs"]
