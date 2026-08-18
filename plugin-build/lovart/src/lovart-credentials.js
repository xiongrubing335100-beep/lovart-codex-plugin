import { spawn } from "node:child_process";
import path from "node:path";
import {
  MacOSCredentialError,
  installMacOSCredentialHelper,
} from "./macos-credential-helper.js";

function openInstalledMacOSCredentialSetup({ projectRoot, installMacHelper, spawnProcess }) {
  const helperPath = installMacHelper({ projectRoot });
  try {
    const child = spawnProcess(helperPath, ["configure"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    throw new MacOSCredentialError("helper_missing_or_invalid");
  }
  return { opened: true, message: "Lovart credential setup window opened." };
}

export function configureCredentialsForPlatform({
  platform = process.platform,
  projectRoot,
  configureMacCredentials = openInstalledMacOSCredentialSetup,
  installMacHelper = installMacOSCredentialHelper,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  if (platform === "darwin") {
    return configureMacCredentials({ projectRoot, installMacHelper, spawnProcess });
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
