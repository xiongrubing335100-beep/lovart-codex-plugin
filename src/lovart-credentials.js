import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

export const macOSKeychainService = "com.lovart.codex";
export const macOSKeychainAccounts = Object.freeze({
  access: "LOVART_ACCESS_KEY",
  secret: "LOVART_SECRET_KEY",
});

const macOSSessionPromptSource = String.raw`
const app = Application.currentApplication();
app.includeStandardAdditions = true;

function readSecret(message) {
  const response = app.displayDialog(message, {
    defaultAnswer: "",
    hiddenAnswer: true,
    buttons: ["Cancel", "Continue"],
    defaultButton: "Continue",
    cancelButton: "Cancel",
  });
  return response.textReturned.trim();
}

const accessKey = readSecret("Enter your Lovart Access Key (AK).");
const secretKey = readSecret("Enter your Lovart Secret Key (SK).");
if (!accessKey || !secretKey) throw new Error("Both Lovart keys are required.");
JSON.stringify({ accessKey, secretKey });
`;

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

export function configureMacOSSessionCredentials({
  env = process.env,
  run = execFileSync,
} = {}) {
  try {
    const output = run(
      "osascript",
      ["-l", "JavaScript", "-e", macOSSessionPromptSource],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const credentials = JSON.parse(String(output).trim());
    if (!credentials.accessKey || !credentials.secretKey) throw new Error("Missing credentials.");

    env.LOVART_ACCESS_KEY = credentials.accessKey;
    env.LOVART_SECRET_KEY = credentials.secretKey;
    return {
      configured: true,
      message: "Lovart credentials loaded for this MCP session.",
    };
  } catch {
    return {
      configured: false,
      message: "Lovart key setup cancelled.",
    };
  }
}

export function configureCredentialsForPlatform({
  platform = process.platform,
  projectRoot,
  env = process.env,
  run = execFileSync,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  if (platform === "darwin") {
    return configureMacOSSessionCredentials({ env, run });
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
