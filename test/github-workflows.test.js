import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function workflow(name) {
  return readFileSync(`.github/workflows/${name}.yml`, "utf8")
    .replace(/^\s*#.*$/gm, "");
}

function requireContract(source, expressions) {
  for (const expression of expressions) {
    assert.match(source, expression);
  }
}

function forbidUnsafeWorkflowFeatures(source) {
  assert.doesNotMatch(source, /^\s*pull_request_target\s*:/m);
  assert.doesNotMatch(source, /secrets\.LOVART_/i);
  assert.doesNotMatch(source, /LOVART_(?:ACCESS|SECRET)_KEY\s*:/i);
}

function jobSection(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z][A-Za-z0-9_-]*:\\n|(?![\\s\\S]))`, "m"));
  assert.ok(match, `workflow must define the ${name} job`);
  return match[1];
}

function requirePreflightBeforeTests(source) {
  const install = source.indexOf("npm ci --ignore-scripts");
  const scan = source.indexOf("python scripts/release_package.py scan");
  const build = source.indexOf("npm run build:plugin");
  const diff = source.indexOf("git diff --exit-code -- plugin-build/lovart");
  const nodeTests = source.indexOf("run: npm test");
  const pythonTests = source.indexOf("python -m unittest discover");
  assert.ok(install < scan && scan < build && build < diff, "preflight must scan, build, and reject mirror drift after installation");
  assert.ok(diff < nodeTests && diff < pythonTests, "preflight must run before test and platform checks");
}

function publishScript() {
  const section = jobSection(workflow("release"), "publish");
  const marker = "        run: |\n";
  const start = section.indexOf(marker);
  assert.notEqual(start, -1, "publish job must contain a Bash run block");
  return section.slice(start + marker.length).replace(/^          /gm, "");
}

function releaseNames(version = "0.2.0") {
  const macos = `lovart-codex-plugin-v${version}-macos-universal.zip`;
  const windows = `lovart-codex-plugin-v${version}-windows.zip`;
  return [macos, `${macos}.sha256`, windows, `${windows}.sha256`];
}

function writeReleaseFiles(directory, files) {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), contents);
  }
}

function completeReleaseFiles({ macos = "macos archive", windows = "windows archive" } = {}) {
  const [macosArchive, macosSidecar, windowsArchive, windowsSidecar] = releaseNames();
  const macosHash = createHash("sha256").update(macos).digest("hex");
  const windowsHash = createHash("sha256").update(windows).digest("hex");
  return {
    [macosArchive]: macos,
    [macosSidecar]: `${macosHash}  ${macosArchive}\n`,
    [windowsArchive]: windows,
    [windowsSidecar]: `${windowsHash}  ${windowsArchive}\n`,
  };
}

function writeExecutable(file, contents) {
  writeFileSync(file, contents, "utf8");
  chmodSync(file, 0o755);
}

function prependPath(directory, existingPath, delimiter = path.delimiter) {
  return existingPath ? `${directory}${delimiter}${existingPath}` : directory;
}

test("publish simulation PATH uses its supplied platform delimiter", () => {
  assert.equal(prependPath("mock-bin", "system-bin"), `mock-bin${path.delimiter}system-bin`);
  assert.equal(prependPath("mock-bin", "system-bin", ";"), "mock-bin;system-bin");
});

function runPublishSimulation({
  state,
  remoteFiles = {},
  tagSha = "expected-sha",
  duplicate = "",
  publish = publishScript(),
}) {
  const root = mkdtempSync(path.join(tmpdir(), "lovart-release-workflow-"));
  const bin = path.join(root, "bin");
  const remote = path.join(root, "remote");
  const log = path.join(root, "gh.log");
  mkdirSync(bin);
  writeReleaseFiles(path.join(root, "dist", "release"), completeReleaseFiles());
  writeReleaseFiles(remote, remoteFiles);
  const script = path.join(root, "publish.sh");
  writeFileSync(script, publish, "utf8");
  const jqShim = path.join(root, "jq-shim.mjs");
  writeFileSync(jqShim, `import { readFileSync } from "node:fs";
const query = process.argv.at(-1);
const value = JSON.parse(readFileSync(0, "utf8"));
if (query === ".isDraft") {
  process.stdout.write(String(value.isDraft) + "\\n");
} else if (query === ".assets[].name") {
  for (const asset of value.assets) process.stdout.write(asset.name + "\\n");
} else {
  process.stderr.write("unsupported jq query: " + query + "\\n");
  process.exit(4);
}
`, "utf8");

  writeExecutable(path.join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == api ]]; then
  printf '%s\\n' "$MOCK_TAG_SHA"
  exit 0
fi
[[ "$1" == release ]]
command="$2"
shift 2
case "$command" in
  view)
    if [[ "$MOCK_RELEASE_STATE" == absent ]]; then
      echo "release not found" >&2
      exit 1
    fi
    if [[ "$MOCK_RELEASE_STATE" == draft ]]; then draft=true; else draft=false; fi
    printf '{"isDraft":%s,"assets":[' "$draft"
    first=true
    shopt -s nullglob
    for file in "$MOCK_REMOTE_DIR"/*; do
      "$first" || printf ','
      first=false
      printf '{"name":"%s"}' "$(basename "$file")"
    done
    if [[ -n "$MOCK_DUPLICATE" ]]; then
      "$first" || printf ','
      printf '{"name":"%s"}' "$MOCK_DUPLICATE"
    fi
    printf ']}\\n'
    ;;
  download)
    shift
    directory=""
    pattern=""
    while (($#)); do
      case "$1" in
        --dir) directory="$2"; shift 2 ;;
        --pattern) pattern="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    mkdir -p "$directory"
    if [[ -n "$pattern" ]]; then
      cp "$MOCK_REMOTE_DIR/$pattern" "$directory/$pattern"
    else
      shopt -s nullglob
      files=("$MOCK_REMOTE_DIR"/*)
      ((\${#files[@]})) && cp "\${files[@]}" "$directory/"
    fi
    ;;
  create|upload)
    shift
    mkdir -p "$MOCK_REMOTE_DIR"
    while (($#)) && [[ "$1" != --* ]]; do
      destination="$MOCK_REMOTE_DIR/$(basename "$1")"
      [[ ! -e "$destination" ]] || {
        echo "refusing to overwrite existing release asset: $(basename "$1")" >&2
        exit 73
      }
      cp "$1" "$destination"
      shift
    done
    ;;
  edit) ;;
  *) echo "unexpected gh release command: $command" >&2; exit 64 ;;
esac
`);
  writeExecutable(path.join(bin, "jq"), `#!/usr/bin/env bash
exec "$MOCK_NODE" "$MOCK_JQ_SHIM" "$@"
`);
  writeExecutable(path.join(bin, "find"), `#!/usr/bin/env bash
set -euo pipefail
directory="$1"
shopt -s nullglob dotglob
for item in "$directory"/*; do basename "$item"; done | /usr/bin/sort
`);
  writeExecutable(path.join(bin, "sha256sum"), `#!/usr/bin/env bash
set -euo pipefail
sidecar="\${!#}"
expected="$(awk '{print $1}' "$sidecar")"
filename="$(awk '{print $2}' "$sidecar")"
actual="$(shasum -a 256 "$filename" | awk '{print $1}')"
[[ "$expected" == "$actual" ]]
printf '%s: OK\\n' "$filename"
`);

  const result = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: prependPath(bin, process.env.PATH),
      GITHUB_REF_NAME: "v0.2.0",
      GITHUB_SHA: "expected-sha",
      GH_REPO: "owner/repo",
      GH_TOKEN: "test-token",
      MOCK_LOG: log,
      MOCK_REMOTE_DIR: remote,
      MOCK_RELEASE_STATE: state,
      MOCK_TAG_SHA: tagSha,
      MOCK_DUPLICATE: duplicate,
      MOCK_NODE: process.execPath,
      MOCK_JQ_SHIM: jqShim,
    },
  });
  const commands = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  return {
    ...result,
    commands,
    remote,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function mutations(commands) {
  return commands.filter((command) => /^release (?:create|upload|edit)\b/.test(command));
}

test("CI exercises both desktop release contracts without credentials", () => {
  const source = workflow("ci");

  requireContract(source, [
    /^\s*pull_request\s*:/m,
    /^\s*push\s*:/m,
    /^permissions:\s*\n\s+contents:\s*read\s*$/m,
    /^\s*- os:\s*macos-14\s*\n\s+platform:\s*macos\s*$/m,
    /^\s*- os:\s*windows-2022\s*\n\s+platform:\s*windows\s*$/m,
    /actions\/checkout@v7/,
    /actions\/setup-node@v7[\s\S]*?node-version:\s*["']?24["']?/,
    /actions\/setup-python@v7[\s\S]*?python-version:\s*["']?3\.12["']?/,
    /npm ci --ignore-scripts/,
    /npm test/,
    /python -m unittest discover -s test -p ['"]\*_test\.py['"] -v/,
    /python test\/agent_skill\.test\.py -v/,
    /node scripts\/verify-macos-credential-helper\.mjs/,
    /\[scriptblock\]::Create\(\(Get-Content -LiteralPath ['"]scripts\/configure-lovart-credentials\.ps1['"] -Raw\)\)/,
    /npm run build:plugin/,
    /npm run build:plugin\s*\n\s*git diff --exit-code -- plugin-build\/lovart/,
    /python scripts\/release_package\.py scan/,
    /scripts\.release_package import verify_release/,
    /python -m zipfile -e/,
    /LOVART_RELEASE_EXTRACTED_ROOT=.*release-mcp-smoke\.test\.js/,
  ]);
  forbidUnsafeWorkflowFeatures(source);
  requirePreflightBeforeTests(source);
  assert.doesNotMatch(jobSection(source, "verify"), /contents:\s*write/);
});

test("tag release builds independently named platform artifacts and publishes exactly four assets", () => {
  const source = workflow("release");

  requireContract(source, [
    /^\s*push:\s*\n\s+tags:\s*\n\s+- ['"]v\*['"]\s*$/m,
    /^\s*permissions:\s*\{\}\s*$/m,
    /^\s*permissions:\s*\n\s+contents:\s*read\s*$/m,
    /^\s*permissions:\s*\n\s+contents:\s*write\s*$/m,
    /^\s*- os:\s*macos-14\s*\n\s+platform:\s*macos\s*$/m,
    /^\s*- os:\s*windows-2022\s*\n\s+platform:\s*windows\s*$/m,
    /actions\/checkout@v7/,
    /actions\/setup-node@v7[\s\S]*?node-version:\s*["']?24["']?/,
    /actions\/setup-python@v7/,
    /actions\/upload-artifact@v7/,
    /actions\/download-artifact@v8/,
    /npm ci --ignore-scripts/,
    /npm test/,
    /python -m unittest discover -s test -p ['"]\*_test\.py['"] -v/,
    /python test\/agent_skill\.test\.py -v/,
    /node scripts\/verify-macos-credential-helper\.mjs/,
    /\[scriptblock\]::Create\(\(Get-Content -LiteralPath ['"]scripts\/configure-lovart-credentials\.ps1['"] -Raw\)\)/,
    /name:\s*lovart-release-\$\{\{ matrix\.platform \}\}/,
    /pattern:\s*lovart-release-\*/,
    /merge-multiple:\s*true/,
    /tag_version="\$\{GITHUB_REF_NAME#v\}"/,
    /\[\[ "\$tag_version" == "\$package_version" \]\]/,
    /npm run build:plugin\s*\n\s*git diff --exit-code -- plugin-build\/lovart/,
    /python scripts\/release_package\.py scan/,
    /\[\[ "\$tag_version" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/,
    /expected_names=\("\$macos_archive" "\$macos_sidecar" "\$windows_archive" "\$windows_sidecar"\)/,
    /macos_archive="lovart-codex-plugin-v\$\{tag_version\}-macos-universal\.zip"/,
    /windows_archive="lovart-codex-plugin-v\$\{tag_version\}-windows\.zip"/,
    /sha256sum --strict --check "\$macos_sidecar"/,
    /sha256sum --strict --check "\$windows_sidecar"/,
    /gh api "repos\/\$GH_REPO\/commits\/\$GITHUB_REF_NAME" --jq ['"]\.sha['"]/,
    /\[\[ "\$remote_tag_sha" == "\$GITHUB_SHA" \]\]/,
    /gh release view "\$GITHUB_REF_NAME" --json isDraft,assets/,
    /gh release download "\$GITHUB_REF_NAME" --dir "\$existing_dir"/,
    /cmp -- "dist\/release\/\$asset" "\$existing_dir\/\$asset"/,
    /gh release upload "\$GITHUB_REF_NAME" "\$\{missing_paths\[@\]:1\}"/,
    /is_draft="\$\(printf '%s' "\$release_json" \| jq -r ['"]\.isDraft['"]\)"/,
    /gh release create "\$GITHUB_REF_NAME"[\s\S]*?--draft[\s\S]*?--verify-tag/,
    /gh release edit "\$GITHUB_REF_NAME" --draft=false --verify-tag/,
    /gh release create "\$GITHUB_REF_NAME" "\$\{expected_paths\[@\]\}"[\s\S]*?--verify-tag[\s\S]*?--generate-notes/,
  ]);
  forbidUnsafeWorkflowFeatures(source);
  requirePreflightBeforeTests(source);

  const build = jobSection(source, "build");
  const publish = jobSection(source, "publish");
  assert.doesNotMatch(build, /contents:\s*write/);
  assert.doesNotMatch(source, /actions\/download-artifact@v7/);
  assert.doesNotMatch(publish, /gh release delete(?:-asset)?/);
  assert.doesNotMatch(publish, /--clobber/);
  assert.doesNotMatch(publish, /dist\/release\/\*\.(?:zip|sha256)/);
  assert.match(publish, /env:\s*\n\s+GH_TOKEN:\s*\$\{\{ github\.token \}\}\s*\n\s+GH_REPO:\s*\$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(publish, /actions\/checkout@|actions\/setup-(?:node|python)@|npm\s+(?:ci|test)|python\s+(?:-m|scripts\/)/);
});

test("publish script creates, verifies, and publishes an absent release", () => {
  const simulation = runPublishSimulation({ state: "absent" });
  try {
    assert.equal(simulation.status, 0, simulation.stderr);
    assert.deepEqual(mutations(simulation.commands), [
      "release create v0.2.0 dist/release/lovart-codex-plugin-v0.2.0-macos-universal.zip dist/release/lovart-codex-plugin-v0.2.0-macos-universal.zip.sha256 dist/release/lovart-codex-plugin-v0.2.0-windows.zip dist/release/lovart-codex-plugin-v0.2.0-windows.zip.sha256 --draft --verify-tag --title Lovart Codex Plugin v0.2.0 --generate-notes",
      "release edit v0.2.0 --draft=false --verify-tag",
    ]);
  } finally {
    simulation.cleanup();
  }
});

test("published matching release verifies its tag after remote bytes and performs no mutation", () => {
  const simulation = runPublishSimulation({ state: "published", remoteFiles: completeReleaseFiles() });
  try {
    assert.equal(simulation.status, 0, simulation.stderr);
    assert.deepEqual(mutations(simulation.commands), []);
    assert.ok(simulation.commands.lastIndexOf("api repos/owner/repo/commits/v0.2.0 --jq .sha") > simulation.commands.lastIndexOf("release download v0.2.0 --dir"));
  } finally {
    simulation.cleanup();
  }
});

test("partial draft uploads only missing assets after matching existing bytes", () => {
  const allFiles = completeReleaseFiles();
  const [macosArchive, macosSidecar] = releaseNames();
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: { [macosArchive]: allFiles[macosArchive], [macosSidecar]: allFiles[macosSidecar] },
  });
  try {
    assert.equal(simulation.status, 0, simulation.stderr);
    const upload = simulation.commands.find((command) => command.startsWith("release upload"));
    assert.match(upload, /windows\.zip/);
    assert.doesNotMatch(upload, /macos-universal/);
    assert.deepEqual(mutations(simulation.commands).map((command) => command.split(" ")[1]), ["upload", "edit"]);
  } finally {
    simulation.cleanup();
  }
});

test("conflicting draft asset fails before every release mutation", () => {
  const conflicting = completeReleaseFiles({ macos: "different macos archive" });
  const simulation = runPublishSimulation({ state: "draft", remoteFiles: conflicting });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("draft with an extra asset fails before every release mutation", () => {
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: { ...completeReleaseFiles(), "unexpected.txt": "not a release asset" },
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("draft with a duplicate asset name fails before every release mutation", () => {
  const [duplicate] = releaseNames();
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: completeReleaseFiles(),
    duplicate,
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("moved tag fails before an absent release can be created", () => {
  const simulation = runPublishSimulation({ state: "absent", tagSha: "moved-sha" });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("moved tag fails before a published release can no-op", () => {
  const simulation = runPublishSimulation({
    state: "published",
    remoteFiles: completeReleaseFiles(),
    tagSha: "moved-sha",
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("moved tag fails before a partial draft upload", () => {
  const files = completeReleaseFiles();
  const [macosArchive, macosSidecar] = releaseNames();
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: { [macosArchive]: files[macosArchive], [macosSidecar]: files[macosSidecar] },
    tagSha: "moved-sha",
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("moved tag fails before a complete draft can publish", () => {
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: completeReleaseFiles(),
    tagSha: "moved-sha",
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("unsupported asset JSON path fails before the draft can mutate", () => {
  const files = completeReleaseFiles();
  const [macosArchive, macosSidecar] = releaseNames();
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: { [macosArchive]: files[macosArchive], [macosSidecar]: files[macosSidecar] },
    publish: publishScript().replace(".assets[].name", ".bogus[].name"),
  });
  try {
    assert.notEqual(simulation.status, 0);
  } finally {
    simulation.cleanup();
  }
});

test("unsupported asset JSON path in an empty draft fails before every release mutation", () => {
  const simulation = runPublishSimulation({
    state: "draft",
    publish: publishScript().replace(".assets[].name", ".bogus[].name"),
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.deepEqual(mutations(simulation.commands), []);
  } finally {
    simulation.cleanup();
  }
});

test("upload mock rejects a mutated attempt to overwrite an existing draft asset", () => {
  const files = completeReleaseFiles();
  const [macosArchive, macosSidecar] = releaseNames();
  const simulation = runPublishSimulation({
    state: "draft",
    remoteFiles: { [macosArchive]: files[macosArchive], [macosSidecar]: files[macosSidecar] },
    publish: publishScript().replace('"${missing_paths[@]:1}"', '"${expected_paths[@]}"'),
  });
  try {
    assert.notEqual(simulation.status, 0);
    assert.equal(readFileSync(path.join(simulation.remote, macosArchive), "utf8"), files[macosArchive]);
  } finally {
    simulation.cleanup();
  }
});
