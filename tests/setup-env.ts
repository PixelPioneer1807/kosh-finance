import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
// Point the app's db client at this run's throwaway database (created in global-setup).
const runUrl = process.env.KOSH_TEST_RUN_DB_URL;
if (!runUrl) throw new Error("Test database was not initialised (global setup)");
process.env.DATABASE_URL = runUrl;
process.env.TZ = "UTC";
// AI tests mock the network; never spend real quota from the test-suite.
process.env.GROQ_API_KEY = "test-key";
