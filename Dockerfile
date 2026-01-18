FROM node:24-alpine
WORKDIR /app
# Install dependencies
RUN apk add --no-cache bash curl
RUN curl -fsS https://cursor.com/install | bash
COPY proxy-server.mjs ./
ARG CURSOR_API_TOKEN
ENV CURSOR_API_TOKEN=${CURSOR_API_TOKEN}
WORKDIR /app
EXPOSE 4141
CMD ["node", "proxy-server.mjs"]
