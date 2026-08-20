#!/usr/bin/env python3
"""Build reproducible, platform-specific Lovart Codex plugin archives."""

from __future__ import annotations

import argparse
import contextlib
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from pathlib import PurePosixPath
from typing import Optional

if os.name == "nt":
    import msvcrt
else:
    import fcntl


COMMON_RUNTIME = (
    ".codex-plugin/plugin.json", ".mcp.json", "README.md", "assets",
    "package.json", "package-lock.json", "scripts/start-mcp.mjs",
    "scripts/verify-macos-credential-helper.mjs",
    "skills", "src", "vendor/lovart-skill",
)
PLATFORM_RUNTIME = {
    "macos": ("bin/macos",),
    "windows": ("scripts/configure-lovart-credentials.ps1",),
}
SECRET_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9_-])(?:ak|sk)_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])", re.ASCII),
    re.compile(r"(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_-])", re.ASCII),
    re.compile(r"(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_-])", re.ASCII),
)
CREDENTIAL_ASSIGNMENTS = (
    re.compile(
        r"(?<![.\w])(?:export\s+)?(?:\$env:)?LOVART_(?:ACCESS|SECRET)_KEY\s*=\s*(?P<value>[^\r\n;]+)",
        re.IGNORECASE | re.ASCII,
    ),
    re.compile(
        r"process\.env\.LOVART_(?:ACCESS|SECRET)_KEY\s*=\s*(?P<value>[^\r\n;]+)",
        re.IGNORECASE | re.ASCII,
    ),
    re.compile(
        r"process\.env\[\s*['\"]LOVART_(?:ACCESS|SECRET)_KEY['\"]\s*\]\s*=\s*(?P<value>[^\r\n;]+)",
        re.IGNORECASE | re.ASCII,
    ),
    re.compile(
        r"(?<![\w$])['\"]?LOVART_(?:ACCESS|SECRET)_KEY['\"]?\s*:\s*(?P<value>[^,\r\n}]+)",
        re.IGNORECASE | re.ASCII,
    ),
)
DOCUMENTED_CREDENTIAL_PLACEHOLDERS = frozenset(("ak_xxx", "sk_xxx"))
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
PACKAGE_ROOT = "lovart-codex-plugin"
NPM_OVERRIDE_ENV = "LOVART_RELEASE_NPM"


class ReleaseError(RuntimeError):
    """Raised when a release candidate violates the archive contract."""


def _validate_platform_and_version(platform: str, version: str) -> None:
    if platform not in PLATFORM_RUNTIME:
        raise ReleaseError("platform must be one of: macos, windows")
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){2}(?:[-+][A-Za-z0-9.-]+)?", version):
        raise ReleaseError("version must be a safe semantic version")


def _assert_no_symlinks(path: Path) -> None:
    if path.is_symlink():
        raise ReleaseError("symlinked release input is not allowed: {}".format(path))
    if not path.exists():
        raise ReleaseError("required release input is missing: {}".format(path))
    if path.is_dir():
        for child in path.rglob("*"):
            if child.is_symlink():
                raise ReleaseError("symlinked release input is not allowed: {}".format(child))


def _copy_input(source: Path, destination: Path) -> None:
    _assert_no_symlinks(source)
    if source.is_dir():
        shutil.copytree(source, destination)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)


def _scan_contents(raw: bytes) -> tuple:
    candidates = [raw.decode("latin-1")]
    try:
        candidates.append(raw.decode("utf-8-sig"))
    except UnicodeDecodeError:
        pass
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            candidates.append(raw.decode("utf-16"))
        except UnicodeDecodeError:
            pass
    elif len(raw) % 2 == 0:
        for encoding in ("utf-16le", "utf-16be"):
            try:
                candidates.append(raw.decode(encoding))
            except UnicodeDecodeError:
                continue
    return tuple(candidates)


def _is_documented_placeholder(value: str) -> bool:
    normalized = value.strip()
    if len(normalized) >= 2 and normalized[0] in "'\"" and normalized[-1] == normalized[0]:
        normalized = normalized[1:-1]
    return normalized in DOCUMENTED_CREDENTIAL_PLACEHOLDERS


def _json_contains_opaque_credential(value: object) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            if isinstance(key, str) and key.upper() in {"LOVART_ACCESS_KEY", "LOVART_SECRET_KEY"}:
                if not isinstance(nested, str) or (nested.strip() and not _is_documented_placeholder(nested)):
                    return True
            if _json_contains_opaque_credential(nested):
                return True
    elif isinstance(value, list):
        return any(_json_contains_opaque_credential(nested) for nested in value)
    return False


def _contains_secret_like_content(name: str, raw: bytes) -> bool:
    contents = _scan_contents(raw)
    if any(pattern.search(content) for content in contents for pattern in SECRET_PATTERNS):
        return True
    if any(
        not _is_documented_placeholder(match.group("value"))
        for content in contents
        for pattern in CREDENTIAL_ASSIGNMENTS
        for match in pattern.finditer(content)
    ):
        return True
    if name.lower().endswith(".json"):
        for content in contents:
            try:
                if _json_contains_opaque_credential(json.loads(content)):
                    return True
            except json.JSONDecodeError:
                continue
    return False


def _scan_text_tree(source: Path, prune_node_modules: bool = True) -> None:
    _assert_no_symlinks(source)
    if source.is_file():
        if _contains_secret_like_content(source.name, source.read_bytes()):
            raise ReleaseError("secret-like content found in {}".format(source.name))
        return
    for directory, subdirectories, files in os.walk(source):
        if prune_node_modules:
            subdirectories[:] = [name for name in subdirectories if name != "node_modules"]
        for name in sorted(files):
            candidate = Path(directory) / name
            if candidate.is_symlink():
                raise ReleaseError("symlinked release input is not allowed: {}".format(candidate))
            if _contains_secret_like_content(candidate.name, candidate.read_bytes()):
                raise ReleaseError("secret-like content found in {}".format(candidate.relative_to(source)))


def _release_runtime_paths() -> tuple[str, ...]:
    return tuple(dict.fromkeys(
        COMMON_RUNTIME + tuple(path for paths in PLATFORM_RUNTIME.values() for path in paths)
    ))


def _scan_project_owned_text(plugin_source: Path) -> None:
    """Scan exactly the project-owned runtime files before dependencies are introduced."""
    for relative in _release_runtime_paths():
        _scan_text_tree(plugin_source / relative, prune_node_modules=False)


def scan_release_inputs(repository_root: Path) -> None:
    """Reject secret-like content from tracked release inputs without packaging them."""
    repository_root = Path(repository_root).resolve()
    plugin_source = repository_root / "plugin-build" / "lovart"
    marketplace_source = repository_root / ".agents" / "plugins" / "marketplace.json"
    _scan_project_owned_text(plugin_source)
    _scan_text_tree(marketplace_source)


def _rewrite_marketplace(source: Path, destination: Path) -> None:
    _assert_no_symlinks(source)
    try:
        marketplace = json.loads(source.read_text(encoding="utf-8"))
        plugins = marketplace["plugins"]
        lovart = next(plugin for plugin in plugins if plugin.get("name") == "lovart")
        lovart["source"] = {"source": "local", "path": "./plugins/lovart"}
    except (KeyError, StopIteration, TypeError, json.JSONDecodeError) as error:
        raise ReleaseError("invalid Lovart marketplace manifest") from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(marketplace, indent=2) + "\n", encoding="utf-8")


def _path_is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _copy_dependency_tree(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise ReleaseError("invalid dependency source")
    root = source.resolve()
    written = {}
    _materialize_dependency_entry(root, destination, root, frozenset(), written)
    pnpm_linker = root / ".pnpm" / "node_modules"
    if pnpm_linker.is_dir() and not pnpm_linker.is_symlink():
        # pnpm resolves transitive packages through this in-root linker view.
        # Once direct package links become ordinary root directories, expose the
        # same targets at the ordinary Node resolution root as well.
        for candidate in sorted(pnpm_linker.iterdir(), key=lambda entry: entry.name):
            incumbent = root / candidate.name
            if incumbent.exists() and _dependency_tree_digest(incumbent, root) != _dependency_tree_digest(candidate, root):
                raise ReleaseError("dependency materialization collision: {}".format(candidate.name))
            _materialize_dependency_entry(candidate, destination / candidate.name, root, frozenset(), written)


def _dependency_tree_digest(source: Path, root: Path) -> str:
    """Hash the fully resolved tree so pnpm promotion cannot merge disjoint trees."""
    digest = hashlib.sha256()

    def visit(candidate: Path, relative: PurePosixPath, ancestors: frozenset[Path]) -> None:
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode):
            target = candidate.resolve(strict=True)
            if not _path_is_within(target, root) or target in ancestors:
                raise ReleaseError("dependency symlink is unsafe: {}".format(candidate))
            visit(target, relative, ancestors | frozenset((target,)))
        elif stat.S_ISDIR(info.st_mode):
            digest.update(b"D\0" + relative.as_posix().encode("utf-8") + b"\0")
            for child in sorted(candidate.iterdir(), key=lambda item: item.name):
                visit(child, relative / child.name, ancestors)
        elif stat.S_ISREG(info.st_mode):
            digest.update(b"F\0" + relative.as_posix().encode("utf-8") + b"\0" + candidate.read_bytes())
        else:
            raise ReleaseError("dependency entry is not regular: {}".format(candidate))

    visit(source, PurePosixPath("."), frozenset())
    return digest.hexdigest()


def _materialize_dependency_entry(source: Path, destination: Path, root: Path, ancestors: frozenset[Path], written: dict) -> None:
    """Copy a dependency entry while resolving only symlinks contained by node_modules.

    pnpm presents package links throughout its in-root layout.  The release archive
    must contain ordinary files, so links are expanded rather than preserved.
    """
    try:
        source_stat = source.lstat()
    except OSError as error:
        raise ReleaseError("dependency entry cannot be inspected: {}".format(source)) from error
    if stat.S_ISLNK(source_stat.st_mode):
        try:
            target = source.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ReleaseError("dependency symlink is broken: {}".format(source.relative_to(root))) from error
        if not _path_is_within(target, root):
            raise ReleaseError("dependency symlink escapes its source: {}".format(source.relative_to(root)))
        if target in ancestors:
            raise ReleaseError("dependency symlink is cyclic: {}".format(source.relative_to(root)))
        _materialize_dependency_entry(target, destination, root, ancestors | frozenset((target,)), written)
        return
    if stat.S_ISDIR(source_stat.st_mode):
        destination.mkdir(parents=True, exist_ok=True)
        for child in sorted(source.iterdir(), key=lambda candidate: candidate.name):
            _materialize_dependency_entry(child, destination / child.name, root, ancestors, written)
        return
    if stat.S_ISREG(source_stat.st_mode):
        contents = source.read_bytes()
        existing = written.get(destination)
        if existing is not None and existing != contents:
            raise ReleaseError("dependency materialization collision: {}".format(destination))
        if destination.exists():
            if not destination.is_file() or destination.read_bytes() != contents:
                raise ReleaseError("dependency materialization collision: {}".format(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            shutil.copy2(source, destination)
        written[destination] = contents
        return
    raise ReleaseError("dependency entry is not a regular file or directory: {}".format(source.relative_to(root)))


def resolve_npm_command(
    environment: Optional[dict] = None,
    platform: Optional[str] = None,
    which=shutil.which,
) -> Path:
    environment = os.environ if environment is None else environment
    override = environment.get(NPM_OVERRIDE_ENV)
    if override:
        candidate = Path(override)
        if (
            not candidate.is_absolute()
            or candidate.is_symlink()
            or not candidate.is_file()
            or not os.access(candidate, os.X_OK)
        ):
            raise ReleaseError("unsafe npm override")
        return candidate.resolve()
    platform = os.name if platform is None else platform
    commands = ("npm.cmd", "npm") if platform in ("nt", "win32") else ("npm", "npm.cmd")
    for command in commands:
        found = which(command)
        if found:
            return Path(found).resolve()
    raise ReleaseError("npm executable was not found on PATH")


def _normalize_installed_dependencies(destination: Path) -> None:
    normalized = destination.with_name(destination.name + ".normalized")
    _copy_dependency_tree(destination, normalized)
    shutil.rmtree(destination)
    os.replace(normalized, destination)


def _install_or_copy_dependencies(plugin_stage: Path, dependency_source: Optional[Path]) -> None:
    destination = plugin_stage / "node_modules"
    if dependency_source is not None:
        _copy_dependency_tree(dependency_source, destination)
        return
    try:
        subprocess.run(
            [str(resolve_npm_command()), "ci", "--omit=dev", "--ignore-scripts"],
            cwd=plugin_stage,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise ReleaseError("production dependency installation failed") from error
    _normalize_installed_dependencies(destination)


def _archive_filename(platform: str, version: str) -> str:
    suffix = "macos-universal" if platform == "macos" else "windows"
    return "lovart-codex-plugin-v{}-{}.zip".format(version, suffix)


def _archive_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_deterministic_zip(source: Path, archive: Path) -> None:
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for path in sorted(candidate for candidate in source.rglob("*") if candidate.is_file()):
            info = zipfile.ZipInfo(path.relative_to(source.parent).as_posix(), FIXED_ZIP_TIME)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if os.access(path, os.X_OK) else 0o644)) << 16
            output.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def _safe_archive_member_name(name: str) -> str:
    if not name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ReleaseError("unsafe archive path: {}".format(name))
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ReleaseError("unsafe archive path: {}".format(name))
    for part in path.parts:
        stem = part.rstrip(". ").split(".", 1)[0].upper()
        if ":" in part or part.endswith((".", " ")) or stem in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} or re.fullmatch(r"(?:COM|LPT)[1-9¹²³]", stem):
            raise ReleaseError("unsafe archive path: {}".format(name))
    if not path.parts or path.parts[0] != PACKAGE_ROOT:
        raise ReleaseError("unexpected archive top-level path: {}".format(name))
    return path.as_posix()


def _validated_archive_members(package: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    seen = set()
    aliases = set()
    members = package.infolist()
    for member in members:
        name = _safe_archive_member_name(member.filename)
        if name in seen:
            raise ReleaseError("duplicate archive member: {}".format(name))
        seen.add(name)
        alias = name.casefold()
        if alias in aliases:
            raise ReleaseError("casefold archive member collision: {}".format(name))
        aliases.add(alias)
        mode = member.external_attr >> 16
        if stat.S_IFMT(mode) != stat.S_IFREG:
            raise ReleaseError("archive member has non-regular mode: {}".format(name))
        if stat.S_IMODE(mode) not in (0o644, 0o755):
            raise ReleaseError("archive member has unsafe mode: {}".format(name))
    return members


def _verify_checksum_sidecar(archive: Path, contents: bytes) -> None:
    expected = ("{}  {}\n".format(_archive_sha256(archive), archive.name)).encode("ascii")
    if contents != expected:
        raise ReleaseError("checksum mismatch")


def _copy_no_follow(source: Path, destination: Path) -> None:
    try:
        named = source.lstat()
    except OSError as error:
        raise ReleaseError("release input cannot be inspected safely") from error
    if not stat.S_ISREG(named.st_mode) or stat.S_ISLNK(named.st_mode):
        raise ReleaseError("release input must be a non-symlink regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(source, flags)
    except OSError as error:
        raise ReleaseError("release input cannot be opened safely") from error
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise ReleaseError("release input must be a regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as input_file, destination.open("xb") as output_file:
            shutil.copyfileobj(input_file, output_file)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def _snapshot_release_inputs(archive: Path):
    with tempfile.TemporaryDirectory(prefix=".lovart-release-input-") as temporary:
        snapshot_root = Path(temporary)
        snapshot_archive = snapshot_root / archive.name
        snapshot_sidecar = snapshot_root / (archive.name + ".sha256")
        _copy_no_follow(archive, snapshot_archive)
        _copy_no_follow(Path(str(archive) + ".sha256"), snapshot_sidecar)
        yield snapshot_archive, snapshot_sidecar.read_bytes()


def _trusted_runtime_files(repository_root: Path, platform: str) -> dict[str, tuple[bytes, int]]:
    repository_root = repository_root.resolve()
    plugin_source = repository_root / "plugin-build" / "lovart"
    marketplace_source = repository_root / ".agents" / "plugins" / "marketplace.json"
    _assert_no_symlinks(plugin_source)
    _assert_no_symlinks(marketplace_source)
    try:
        marketplace = json.loads(marketplace_source.read_text(encoding="utf-8"))
        lovart = next(plugin for plugin in marketplace["plugins"] if plugin.get("name") == "lovart")
        lovart["source"] = {"source": "local", "path": "./plugins/lovart"}
    except (KeyError, StopIteration, TypeError, json.JSONDecodeError) as error:
        raise ReleaseError("invalid trusted Lovart marketplace manifest") from error
    prefix = PACKAGE_ROOT + "/"
    files = {prefix + ".agents/plugins/marketplace.json": (json.dumps(marketplace, indent=2).encode("utf-8") + b"\n", 0o644)}
    for relative in COMMON_RUNTIME + PLATFORM_RUNTIME[platform]:
        source = plugin_source / relative
        _assert_no_symlinks(source)
        candidates = [source] if source.is_file() else sorted(path for path in source.rglob("*") if path.is_file())
        for candidate in candidates:
            name = prefix + "plugins/lovart/" + candidate.relative_to(plugin_source).as_posix()
            files[name] = (candidate.read_bytes(), 0o755 if os.access(candidate, os.X_OK) else 0o644)
    return files


def _scan_candidate_project_bytes(name: str, raw: bytes) -> None:
    if _contains_secret_like_content(name, raw):
        raise ReleaseError("secret-like content found in archive member: {}".format(name))


def _safe_extract_release(package: zipfile.ZipFile, members: list[zipfile.ZipInfo], destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    for member in members:
        name = _safe_archive_member_name(member.filename)
        target = root.joinpath(*PurePosixPath(name).parts)
        if not _path_is_within(target.resolve().parent, root):
            raise ReleaseError("unsafe archive path: {}".format(name))
        if member.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with package.open(member) as source, target.open("xb") as output:
            shutil.copyfileobj(source, output)
    return root / PACKAGE_ROOT


def _validate_windows_setup_script(script: Path) -> None:
    try:
        contents = script.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as error:
        raise ReleaseError("release archive PowerShell setup script is not valid UTF-8") from error
    required = (
        "Add-Type -AssemblyName System.Windows.Forms",
        "UseSystemPasswordChar = $true",
        '[Environment]::SetEnvironmentVariable("LOVART_ACCESS_KEY", $accessKey, "User")',
        '[Environment]::SetEnvironmentVariable("LOVART_SECRET_KEY", $secretKey, "User")',
        "[void]$form.ShowDialog()",
    )
    if "\x00" in contents or any(token not in contents for token in required):
        raise ReleaseError("release archive PowerShell setup script fails the static local UI contract")


def _verify_macos_extracted_helper(trusted_plugin_root: Path, extracted_plugin_root: Path) -> None:
    verifier = trusted_plugin_root / "scripts" / "verify-macos-credential-helper.mjs"
    helper = extracted_plugin_root / "bin" / "macos" / "lovart-credential-helper"
    bundled_node = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "node" / "bin" / "node"
    node = str(bundled_node) if bundled_node.is_file() and os.access(bundled_node, os.X_OK) else shutil.which("node")
    if not node:
        raise ReleaseError("node executable was not found for macOS helper verification")
    program = (
        "import { pathToFileURL } from 'node:url'; "
        "const { verifyMacOSCredentialHelper } = await import(pathToFileURL(process.argv[1]).href); "
        "verifyMacOSCredentialHelper({ binary: process.argv[2] });"
    )
    try:
        subprocess.run(
            [node, "--input-type=module", "--eval", program, str(verifier), str(helper)],
            cwd=trusted_plugin_root,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        raise ReleaseError("macOS credential helper verification failed") from error


def verify_release(
    archive: Path,
    platform: str,
    version: str,
    trusted_repository_root: Optional[Path] = None,
) -> dict:
    _validate_platform_and_version(platform, version)
    if archive.name != _archive_filename(platform, version):
        raise ReleaseError("unexpected archive name: {}".format(archive.name))
    trusted_repository_root = Path(__file__).resolve().parents[1] if trusted_repository_root is None else Path(trusted_repository_root)
    trusted_files = _trusted_runtime_files(trusted_repository_root, platform)
    prefix = PACKAGE_ROOT + "/"
    node_modules = prefix + "plugins/lovart/node_modules/"
    with _snapshot_release_inputs(archive) as (snapshot_archive, sidecar):
        try:
            with zipfile.ZipFile(snapshot_archive) as package:
                members = _validated_archive_members(package)
                names = {member.filename for member in members}
                unexpected = [name for name in names if name not in trusted_files and not name.startswith(node_modules)]
                missing = set(trusted_files).difference(names)
                if unexpected or missing:
                    raise ReleaseError("release archive contains unexpected archive member or misses trusted runtime files")
                for member in members:
                    if member.filename.startswith(node_modules):
                        dependency_parts = PurePosixPath(member.filename).parts
                        if any(part.casefold().startswith(".env") or part.casefold() == ".lovart" for part in dependency_parts):
                            raise ReleaseError("release archive dependency contains forbidden local state")
                        _scan_candidate_project_bytes(member.filename, package.read(member))
                    if member.filename in trusted_files:
                        contents = package.read(member)
                        _scan_candidate_project_bytes(member.filename, contents)
                        expected_contents, expected_mode = trusted_files[member.filename]
                        if contents != expected_contents or stat.S_IMODE(member.external_attr >> 16) != expected_mode:
                            raise ReleaseError("release archive member does not match trusted source: {}".format(member.filename))
                if not any(name.startswith(node_modules) for name in names):
                    raise ReleaseError("release archive is missing production dependencies")
                marketplace = json.loads(package.read(prefix + ".agents/plugins/marketplace.json"))
                plugin_manifest = json.loads(package.read(prefix + "plugins/lovart/.codex-plugin/plugin.json"))
                package_manifest = json.loads(package.read(prefix + "plugins/lovart/package.json"))
        except (OSError, zipfile.BadZipFile) as error:
            raise ReleaseError("invalid release archive") from error
        except (KeyError, TypeError, json.JSONDecodeError) as error:
            raise ReleaseError("release archive has invalid manifest metadata") from error
        dependencies = package_manifest.get("dependencies", {})
        if not isinstance(dependencies, dict) or not all(isinstance(name, str) for name in dependencies):
            raise ReleaseError("release archive has invalid production dependency metadata")
        if any(node_modules + dependency + "/package.json" not in names for dependency in dependencies):
            raise ReleaseError("release archive is missing production dependencies")
        try:
            lovart = next(plugin for plugin in marketplace["plugins"] if plugin.get("name") == "lovart")
            marketplace_source = lovart["source"]
        except (KeyError, StopIteration, TypeError) as error:
            raise ReleaseError("release archive has invalid marketplace metadata") from error
        if (
            marketplace.get("name") != "lovart-codex"
            or marketplace_source != {"source": "local", "path": "./plugins/lovart"}
            or plugin_manifest.get("version") != version
            or package_manifest.get("version") != version
        ):
            raise ReleaseError("release archive version or marketplace metadata does not match")
        _verify_checksum_sidecar(snapshot_archive, sidecar)
        with zipfile.ZipFile(snapshot_archive) as package, tempfile.TemporaryDirectory(prefix=".lovart-release-verify-") as temporary:
            extracted_root = _safe_extract_release(package, _validated_archive_members(package), Path(temporary))
            if platform == "macos" and sys.platform == "darwin":
                _verify_macos_extracted_helper(
                    trusted_repository_root.resolve() / "plugin-build" / "lovart",
                    extracted_root / "plugins" / "lovart",
                )
            if platform == "windows":
                _validate_windows_setup_script(extracted_root / "plugins" / "lovart" / "scripts" / "configure-lovart-credentials.ps1")
        return {
            "platform": platform,
            "version": version,
            "archiveSha256": _archive_sha256(snapshot_archive),
            "fileCount": len(names),
        }


def _quarantine_path(archive: Path, public_path: Path) -> Path:
    quarantine = archive.parent / ".rollback-quarantine"
    quarantine.mkdir(exist_ok=True)
    return quarantine / public_path.name


def _restore_foreign_replacement(quarantine: Path, destination: Path) -> None:
    try:
        os.link(quarantine, destination)
    except FileExistsError:
        return
    except OSError:
        try:
            with quarantine.open("rb") as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
        except FileExistsError:
            return
    quarantine.unlink()


def _quarantine_rollback_path(public_path: Path, quarantine: Path, digest: str) -> None:
    try:
        os.replace(public_path, quarantine)
    except FileNotFoundError:
        return
    if _archive_sha256(quarantine) == digest:
        quarantine.unlink()
    else:
        _restore_foreign_replacement(quarantine, public_path)


def _restore_if_absent(backup: Path, destination: Path) -> None:
    try:
        os.link(backup, destination)
    except FileExistsError:
        return


def _is_windows_lock_contention(error: OSError) -> bool:
    return error.errno in (errno.EACCES, errno.EAGAIN) or getattr(error, "winerror", None) in (32, 33)


def _lock_windows_file(handle) -> None:
    while True:
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError as error:
            if not _is_windows_lock_contention(error):
                raise
            time.sleep(0.1)


@contextlib.contextmanager
def _publication_lock(destination: Path):
    lock = destination.with_name("." + destination.name + ".lock")
    with lock.open("a+b") as handle:
        if os.name == "nt":
            handle.seek(0)
            if not handle.read(1):
                handle.seek(0)
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            _lock_windows_file(handle)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _publish_pair(archive: Path, sidecar: Path, destination: Path, sidecar_destination: Path) -> None:
    with _publication_lock(destination):
        destination_exists = destination.exists()
        sidecar_exists = sidecar_destination.exists()
        if destination_exists != sidecar_exists:
            raise ReleaseError("release output contains an orphaned archive or checksum")
        backup_archive = archive.with_name("previous-" + archive.name)
        backup_sidecar = sidecar.with_name("previous-" + sidecar.name)
        if destination_exists:
            shutil.copy2(destination, backup_archive)
            shutil.copy2(sidecar_destination, backup_sidecar)
        archive_digest = _archive_sha256(archive)
        sidecar_digest = _archive_sha256(sidecar)
        archive_published = False
        sidecar_published = False
        try:
            os.replace(archive, destination)
            archive_published = True
            os.replace(sidecar, sidecar_destination)
            sidecar_published = True
        except OSError:
            if sidecar_published:
                _quarantine_rollback_path(
                    sidecar_destination,
                    _quarantine_path(archive, sidecar_destination),
                    sidecar_digest,
                )
            if archive_published:
                _quarantine_rollback_path(
                    destination,
                    _quarantine_path(archive, destination),
                    archive_digest,
                )
            if destination_exists:
                _restore_if_absent(backup_archive, destination)
                _restore_if_absent(backup_sidecar, sidecar_destination)
            raise


def build_release(
    repository_root: Path,
    platform: str,
    version: str,
    output_dir: Path,
    dependency_source: Optional[Path] = None,
) -> Path:
    _validate_platform_and_version(platform, version)
    repository_root = Path(repository_root).resolve()
    output_dir = Path(output_dir)
    plugin_source = repository_root / "plugin-build" / "lovart"
    marketplace_source = repository_root / ".agents" / "plugins" / "marketplace.json"
    scan_release_inputs(repository_root)
    if dependency_source is not None:
        dependency_source = Path(dependency_source).absolute()

    if output_dir.is_symlink():
        raise ReleaseError("release output directory must not be a symlink")
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    archive_name = _archive_filename(platform, version)
    destination = output_dir / archive_name
    sidecar_destination = Path(str(destination) + ".sha256")
    with tempfile.TemporaryDirectory(prefix=".lovart-release-", dir=output_dir.parent) as temporary:
        temporary_root = Path(temporary)
        package_stage = temporary_root / PACKAGE_ROOT
        plugin_stage = package_stage / "plugins" / "lovart"
        _rewrite_marketplace(marketplace_source, package_stage / ".agents" / "plugins" / "marketplace.json")
        for relative in COMMON_RUNTIME + PLATFORM_RUNTIME[platform]:
            _copy_input(plugin_source / relative, plugin_stage / relative)
        _scan_text_tree(package_stage, prune_node_modules=False)
        _install_or_copy_dependencies(plugin_stage, dependency_source)
        archive = temporary_root / archive_name
        write_deterministic_zip(package_stage, archive)
        digest = _archive_sha256(archive)
        sidecar = temporary_root / (archive_name + ".sha256")
        sidecar.write_bytes("{}  {}\n".format(digest, archive_name).encode("ascii"))
        verify_release(archive, platform, version, repository_root)
        output_dir.mkdir(parents=True, exist_ok=True)
        _publish_pair(archive, sidecar, destination, sidecar_destination)
    return destination


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build", help="build one platform release archive")
    build.add_argument("--platform", required=True, choices=sorted(PLATFORM_RUNTIME))
    build.add_argument("--version", required=True)
    build.add_argument("--output-dir", required=True, type=Path)
    build.add_argument("--dependency-source", type=Path)
    scan = commands.add_parser("scan", help="scan tracked release inputs for credentials")
    scan.add_argument("--repository-root", default=Path.cwd(), type=Path)
    arguments = parser.parse_args()
    if arguments.command == "build":
        archive = build_release(Path.cwd(), arguments.platform, arguments.version, arguments.output_dir, arguments.dependency_source)
        print(archive)
        return 0
    if arguments.command == "scan":
        scan_release_inputs(arguments.repository_root)
        return 0
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except ReleaseError as error:
        raise SystemExit("release packaging failed: {}".format(error))
