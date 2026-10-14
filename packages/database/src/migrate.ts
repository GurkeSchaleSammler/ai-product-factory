import { createDatabase, migrateDatabase } from "./index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const database = createDatabase(connectionString, "factory-migrator");
try {
  await migrateDatabase(database);
  process.stdout.write("Database migration completed\n");
} finally {
  await database.end();
}
