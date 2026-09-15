// Local Postgres without Docker: `npm run devdb`. Uses the same port and credentials as docker-compose.yml,
// so DATABASE_URL in .env.example works with either.
import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const dataDir = ".devdb";
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "gateway",
  password: "gateway",
  port: 5433,
  persistent: true,
});

if (!existsSync(dataDir)) {
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("gateway");
} catch {
  // already exists
}
console.log("postgres ready on localhost:5433 (Ctrl+C to stop)");

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
