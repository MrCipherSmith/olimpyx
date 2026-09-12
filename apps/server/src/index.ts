import { createApp, migrate } from "./app.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://olimpyx:olimpyx-local-only@127.0.0.1:55432/olimpyx";
await migrate(databaseUrl);
const app = await createApp({ databaseUrl });
await app.listen({ port: Number(process.env.PORT ?? 4300), host: process.env.HOST ?? "127.0.0.1" });
