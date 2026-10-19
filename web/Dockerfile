#using alpine for a slimmer image - your app may have different requirements
FROM node:22-alpine

#creates standard working directory
WORKDIR /usr/src/app

#copies package.json and yarn.lock for earlier caching
#this will prevent yarn installs if they are unnecessary
COPY package.json ./
COPY yarn.lock ./

#yarn installs all packages
RUN yarn

#bundles the app source
COPY . .

#Builds project
RUN yarn build

#runs container as an unprivileged user if superuser permissions not required
USER node

#Exposes port 3000
EXPOSE 3000

#Runs next start command
CMD [ "yarn", "start" ]
