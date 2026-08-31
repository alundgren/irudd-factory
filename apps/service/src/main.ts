import { configPathFromArgs, loadConfig } from "./config.ts";
import { startFactoryService } from "./service.ts";

const configPath = configPathFromArgs(process.argv.slice(2));
const config = await loadConfig(configPath);
const service = await startFactoryService(config);
console.log(`Factory service listening at ${service.url}`);

await new Promise<void>((resolve) => {
  const stop = () => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
await service.stop();
