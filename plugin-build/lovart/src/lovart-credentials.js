import { spawn } from "node:child_process";
import path from "node:path";
import {
  configureMacOSCredentials,
  installMacOSCredentialHelper,
} from "./macos-credential-helper.js";

function configureInstalledMacOSCredentials({ projectRoot }) {
  const helperPath = installMacOSCredentialHelper({ projectRoot });
  return configureMacOSCredentials({ helperPath });
}

export function configureCredentialsForPlatform({
  platform = process.platform,
  projectRoot,
  configureMacCredentials = configureInstalledMacOSCredentials,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  if (platform === "darwin") {
    return configureMacCredentials({ projectRoot });
  }

  return openCredentialSetup({ platform, projectRoot, spawnProcess, systemRoot });
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

  if (platform === "win32") {
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
