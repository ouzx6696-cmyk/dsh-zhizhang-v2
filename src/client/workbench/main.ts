import { fanqieUiModule } from "./plugins/fanqie.ts";
import { toutiaoUiModule } from "./plugins/toutiao.ts";
import { bootWorkbench } from "./shell.ts";

function start(): void {
  bootWorkbench([fanqieUiModule, toutiaoUiModule]);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
