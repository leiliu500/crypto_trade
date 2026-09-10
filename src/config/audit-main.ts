import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { configurationAudit } from "./audit.js";

loadLocalEnv();
process.stdout.write(`${JSON.stringify(configurationAudit(loadConfig()), null, 2)}\n`);
