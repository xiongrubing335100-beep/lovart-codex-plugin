import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalExecFileSync = childProcess.execFileSync;

childProcess.execFileSync = function execFileSync(command, args, options) {
  if (
    typeof command === "string" &&
    command.endsWith("lovart-credential-helper") &&
    args?.length === 1 &&
    args[0] === "read"
  ) {
    return JSON.stringify({ status: "error", errorCode: "not_configured" });
  }
  return originalExecFileSync(command, args, options);
};

syncBuiltinESMExports();
