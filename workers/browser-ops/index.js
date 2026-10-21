import { launch } from "@cloudflare/playwright";
import { createBrowserWorker } from "./handler.js";

export default createBrowserWorker(launch);
