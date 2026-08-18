import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const originalExecFileSync = childProcess.execFileSync;
const originalSpawn = childProcess.spawn;

childProcess.execFileSync = function execFileSync(command, args, options) {
  if (
    typeof command === "string" &&
    command.endsWith("lovart-credential-helper") &&
    args?.length === 1 &&
    args[0] === "read"
  ) {
    return JSON.stringify({ status: "error", errorCode: "not_configured" });
  }
  if (
    typeof command === "string" &&
    command.endsWith("lovart-credential-helper") &&
    args?.length === 1 &&
    args[0] === "configure"
  ) {
    return JSON.stringify({ status: "ok", configured: true });
  }
  return originalExecFileSync(command, args, options);
};

childProcess.spawn = function spawn(command, args, options) {
  if (
    typeof command === "string" &&
    command.endsWith("lovart-credential-helper") &&
    args?.length === 1 &&
    args[0] === "configure"
  ) {
    return { unref() {} };
  }
  return originalSpawn(command, args, options);
};

syncBuiltinESMExports();
