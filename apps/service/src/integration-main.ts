import { FactoryError } from "@irudd-factory/application";
import { runLiveIntegration } from "./integration.ts";

try {
  process.exitCode = await runLiveIntegration(process.argv.slice(2));
} catch (error) {
  if (error instanceof FactoryError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.detail?.trim()) console.error(error.detail);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
}
