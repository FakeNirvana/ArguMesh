import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { loadBindings } from "../server/env";

const url = loadBindings().DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN;

const client = createClient({ url, authToken });
const db = drizzle(client);

await migrate(db, { migrationsFolder: "drizzle" });
console.log("Applied Drizzle migrations.");
client.close();
