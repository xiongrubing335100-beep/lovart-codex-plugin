import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

export const macOSKeychainService = "com.lovart.codex";
export const macOSKeychainAccounts = Object.freeze({
  access: "LOVART_ACCESS_KEY",
  secret: "LOVART_SECRET_KEY",
});

export function readMacOSKeychainVariable(name, { run = execFileSync } = {}) {
  try {
    const output = run(
      "security",
      ["find-generic-password", "-s", macOSKeychainService, "-a", name, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return String(output).trim();
  } catch {
    return "";
  }
}

export function openCredentialSetup({
  platform = process.platform,
  projectRoot,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  let command;
  let args;
  let options = { detached: true, stdio: "ignore" };

  if (platform === "darwin") {
    command = "osascript";
    args = [path.join(projectRoot, "scripts", "configure-lovart-credentials.applescript")];
  } else if (platform === "win32") {
    command = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-File",
      path.join(projectRoot, "scripts", "configure-lovart-credentials.ps1"),
    ];
    options = { ...options, windowsHide: true };
  } else {
    return {
      opened: false,
      message: "Lovart key setup is supported on macOS and Windows only.",
    };
  }

  const child = spawnProcess(command, args, options);
  child.unref?.();
  return { opened: true, message: "Lovart key setup window opened." };
}
