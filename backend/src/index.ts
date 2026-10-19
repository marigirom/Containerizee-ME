import express from "express";
import "dotenv/config";
import { dataSource } from "./data-source";
import cors from "cors";
import session from "express-session";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import { COOKIE_NAME } from "./constants";

const main = async () => {
  //Initializes the typeorm dataSource asynchronously
  dataSource
    .initialize()
    .then(() => {
      console.log("initialized successfully");
    })
    .catch((err) => {
      console.log("data source initialization error occurred: ", err);
    });

  //Creates the express application
  const app = express();

  //basic get request
  app.get("/", (_, res) => {
    res.send("This is a test!");
  });

  //app will be using cors.
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN, //origin can be set to your app specifications.
      credentials: true,
    })
  );

  /**********redis middleware starts here. if adding apollo middleware, this must precede that middleware**/

  // connect-redis v10+ uses the 'redis' npm client directly (createClient).
  // The old ioredis-based connectRedis(session) factory was removed in v7.
  const redis = createClient({ url: process.env.REDIS_URL as string });

  redis.on("error", (err) => console.log("Redis client error:", err));

  await redis.connect();

  app.use(
    session({
      name: COOKIE_NAME,
      store: new RedisStore({
        client: redis,
        disableTouch: true, //optional arg, touching increases the time session will be active
      }),
      cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 365, //1 year cookie time
        httpOnly: true, //javascript code in front end cannot access cookie
        secure: false, //cookie only works in https if true. can set to __prod__ if in prod
        sameSite: "lax", //must be changed to lax for prod
        // domain: __prod__ ? ".yourdomainhere.com" : undefined,
      },
      saveUninitialized: false, //usually false if using express-session
      secret: process.env.SESSION_SECRET as string, //this app does not set cookies, but if it did, this would be needed
      resave: false, //set to false because disable touch is true
    })
  );

  /*****redis middleware ends here*********/

  //App listens on port set in environment variables - here, it is 4000
  app.listen(parseInt(process.env.PORT as string), () => {
    console.log(`🚀 Listening on port ${process.env.PORT}`);
  });
};

main().catch((err) => {
  console.log(err);
});
