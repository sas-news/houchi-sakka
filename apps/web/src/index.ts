import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app.js";

interface Env {
  DB: D1Database;
  APP_SECRET_KEY: string;
  EXECUTOR_TOKEN: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const app = createApp({
      db: drizzle(env.DB),
      secretKey: env.APP_SECRET_KEY,
      executorToken: env.EXECUTOR_TOKEN,
    });
    return app(request);
  },
} satisfies ExportedHandler<Env>;
