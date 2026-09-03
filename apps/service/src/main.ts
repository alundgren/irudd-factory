import { configPathFromArgs, loadConfig } from "./config.ts";
import { productionDependencies, startFactoryService } from "./service.ts";

const configPath = configPathFromArgs(process.argv.slice(2));
const config = await loadConfig(configPath);
const service = await startFactoryService(
  config,
  productionDependencies(config),
);
console.log(`Factory service listening at ${service.url}`);
if (service.localCliUrl) {
  console.log(`Local CLI RPC listening at ${service.localCliUrl}/rpc`);
  console.log("Do not proxy the local CLI listener.");
}

await new Promise<void>((resolve) => {
  const stop = () => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
await service.stop();
