import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { loadBindings } from "./server/env";

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dialect: "turso", // libSQL 方言:同时兼容本地 file: 与远程 libsql://
  dbCredentials: {
    url: loadBindings().DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
