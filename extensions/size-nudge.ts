import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSizeNudge } from "../src/runtime.ts";

export default function sizeNudgeExtension(pi: ExtensionAPI): void {
  registerSizeNudge(pi, CONFIG_DIR_NAME);
}
