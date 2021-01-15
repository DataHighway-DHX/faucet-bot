FROM node as build
RUN mkdir -p /opt/build;
WORKDIR /opt/build
COPY ./src ./src
COPY [ "package.json", "yarn.lock", "tsconfig.json", "./" ]
RUN mkdir build;
RUN yarn

FROM node as dependencies
ENV NODE_ENV='production'
RUN mkdir -p /opt/build;
WORKDIR /opt/build
COPY --from=build [ "/opt/build/package.json", "/opt/build/yarn.lock", "./" ]
RUN yarn install --production=true --no-progress


FROM node:slim as release
ENV NODE_ENV='production'
RUN mkdir -p /opt/app/src;
WORKDIR /opt/app
COPY --from=dependencies /opt/build/node_modules /opt/app/node_modules
COPY --from=dependencies /opt/build/package.json /opt/app/
COPY --from=build /opt/build/build /opt/app/build
COPY --from=build /opt/build/src/index.ts ./src
COPY ecosystem.config.js .
ENTRYPOINT [ "yarn", "run", "serve"]
