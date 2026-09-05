import { loadLocalEnv } from "../env.js";
import { loadConfig } from "../config.js";
import { KrakenAccountFees } from "./account-fees.js";
loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const service = new KrakenAccountFees(process.env.KRAKEN_SPOT_FEE_API_KEY ?? "", process.env.KRAKEN_SPOT_FEE_API_SECRET ?? "");
const fees = await service.load(Object.values(cfg.krakenFutures.productsBySymbol));
process.stdout.write(`${JSON.stringify({ fees, orderSubmissionChanged: false }, null, 2)}\n`);
