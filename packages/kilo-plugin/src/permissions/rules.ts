import { Permission } from "@opencode/core/permission"
import { ShellParse } from "@opencode/core/shell/parse"
import { ShellScan } from "@opencode/core/shell/scan"
import { ShellSelect } from "@opencode/core/shell/select"
import { Effect } from "effect"
import os from "os"
import path from "path"

// Redirections that write no file: descriptor duplication (`2>&1`, `>&2`) and discarding output to /dev/null. The
// target must end there: `>&1abc` and `>&2/x` write a file.
const harmless = /(?:\d*>&\d+|(?:\d*|&)>>?\s*\/dev\/null)(?![^\s;|&])/g

// Any expansion could print a variable, run a command or name a path the set cannot check. The scanner keeps a brace
// list or a glob as one word, but the shell expands `{--prefix,/tmp/other}` into an option and its value, and `.?/x`
// can match `../x`.
const expansion = /[`${}*?[\]]/
// PowerShell also splats a variable into arguments (`@args`), passes each item of `a,b` as its own argument and
// evaluates `(...)`.
const powershellExpansion = /[`${}*?[\]@,()]/
// Stems a set no longer holds. A set stored while it held one still asks: `bun build` is Bun's bundler, not the
// project's build script, and `--outfile` writes any file.
const retired = new Set(["bun build *"])
// Install subcommands a set allows only without a package argument, so they install from the lockfile. `add` always
// names a package; it is listed so a set stored before `add` left the install set still asks.
const installPattern = /^(?:bun|npm|pnpm|yarn) (?:install|i|ci|add) \*$/
// Package-manager and runtime options that move the command to another directory, workspace or global prefix, load
// other config, or run another program (`npm run test --prefix /elsewhere`, `--script-shell`, `bun --preload`).
// npm and GNU-style parsers expand abbreviations, so any prefix of one of these names asks too.
const projectEscapeOptions = [
  "prefix",
  "cwd",
  "dir",
  "workspace",
  "workspaces",
  "ws",
  "include-workspace-root",
  "workspace-root",
  "filter",
  "filter-prod",
  "recursive",
  "global",
  "global-dir",
  "global-folder",
  "location",
  "userconfig",
  "globalconfig",
  "config",
  "script-shell",
  "shell",
  "node-options",
  "preload",
  "require",
  "import",
  "eval",
  "print",
  "registry",
  "git",
  "cache",
  "cache-folder",
  "modules-folder",
  "store-dir",
  "virtual-store-dir",
  // A debugger socket runs any code in the process.
  "inspect",
  "inspect-brk",
  "inspect-wait",
  "inspect-port",
]
// Their short forms: -C (prefix/dir), -w (workspace), -g (global), -F (filter), -r (recursive/preload), -c (config),
// -e and -p (eval/print).
const projectEscapeFlags = /[CwgFrcep]/

/**
 * True when a set allows one shell command resource. The shell resource keeps its redirections, so `bun run test *`
 * would match `bun run test > .git/hooks/pre-commit`; a set never allows a command that writes or reads a file through
 * redirection, runs a process substitution or reads a here-document, and that command asks as usual. A covered
 * command must also stay in the project (see `staysInProject`), and an install must name no package (see
 * `lockfileInstall`). `shell` is the shell that runs the command: the resource is read in that shell's dialect, and a
 * shell the scanner does not model (cmd, fish, nu) asks.
 */
export function covers(resource: string, resources: readonly string[], directory: string, shell: string) {
  const rest = resource.replace(harmless, "")
  if (rest.includes(">") || rest.includes("<")) return false
  const command = scanOne(resource, shell)
  if (command === undefined) return false
  return resources.some(
    (pattern) =>
      !retired.has(pattern) &&
      Permission.evaluate("shell", resource, [rule(pattern)]).effect === "allow" &&
      staysInProject(command, directory, ShellSelect.ps(shell)) &&
      (!installPattern.test(pattern) || lockfileInstall(command)),
  )
}

/** True when every resource of a request is already allowed by the evaluated rules or by the applied sets. */
export function allowsRequest(input: {
  readonly action: string
  readonly resources: readonly string[]
  readonly rules: Permission.Ruleset
  readonly applied: readonly string[]
  readonly directory: string
  readonly shell: string
}) {
  return input.resources.every(
    (resource) =>
      Permission.evaluate(input.action, resource, input.rules).effect === "allow" ||
      covers(resource, input.applied, input.directory, input.shell),
  )
}

/** The parts of a command a set does not allow, as the shell tool would ask for them. */
export function missing(command: string, directory: string, resources: readonly string[], shell: string) {
  return ShellParse.scan(command, shell, directory).pipe(
    Effect.map((parsed) =>
      parsed.commands.map((item) => item.resource).filter((resource) => !covers(resource, resources, directory, shell)),
    ),
    // A command the scanner cannot analyze asks as a whole.
    Effect.catch((error) => Effect.succeed([`${command} (${error.message})`])),
  )
}

/**
 * True when a project script or install runs in this project: no option before `--` that points it at another
 * directory, workspace, config or program, and no path that resolves outside the project
 * (`bun test /tmp/evil.test.ts`, `bun run test ../other-repo`). Options after `--` go to the script itself, but a path
 * there is still checked: `bun test -- /tmp/evil.test.ts` runs that file, and `npm run test -- --config /tmp/evil.js`
 * loads it. The request does not carry the command's working directory, so paths resolve against the project root.
 */
function staysInProject(command: Scanned, directory: string, powershell: boolean) {
  const end = command.words.indexOf("--")
  return command.words
    .slice(1)
    .every(
      (arg, index) =>
        ((end !== -1 && index + 1 >= end) || !escapesProject(arg)) && insideProject(arg, directory, powershell),
    )
}

// `bun install`, `npm ci --omit=dev`: options only, never a package, URL or tarball. An option whose value is the next
// word (`--omit dev`) asks too, since that word looks like a package.
function lockfileInstall(command: Scanned) {
  return command.words.slice(2).every((arg) => arg.startsWith("-"))
}

type Scanned = Extract<ShellScan.Result, { kind: "scanned" }>["commands"][number]

// Reads the resource as the shell tool read the command (see `ShellParse.scan`). cmd expands `%VAR%` and escapes with
// `^`, and fish and nu have their own syntax; the scanner models none of them, so their commands ask.
function scanOne(resource: string, shell: string) {
  const powershell = ShellSelect.ps(shell)
  const name = ShellSelect.name(shell)
  if (!powershell && !posixShells.has(name)) return
  const scanned = powershell
    ? ShellScan.scanPowerShell(resource)
    : ShellScan.scan(resource, name === "bash" || name === "zsh" ? name : "posix")
  if (scanned.kind === "opaque" || scanned.commands.length !== 1) return
  const command = scanned.commands[0]!
  if (command.rawWords.some((word) => (powershell ? powershellExpansion : expansion).test(word))) return
  return command
}

const posixShells = new Set(["bash", "zsh", "sh", "dash", "ksh"])

// A positional argument, or the value of `--option=value`, that looks like a path must resolve inside the project.
// TODO(permission-setup): a path that does not start the word or the option value is not checked, so
// `bun run build outDir=/tmp/x`, `--rootDirs=a,/tmp/x`, `--opt=x:~/y` and `-o/tmp/x` are covered. Whether such a
// value is a path depends on the script; follow up by asking for any word that holds an absolute path, `..` or `~`
// segment anywhere.
function insideProject(arg: string, directory: string, powershell: boolean) {
  if (arg.startsWith("-") && !arg.includes("=")) return true
  const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg
  if (!pathLike(value)) return true
  // PowerShell takes `\` as a separator on every platform. Off Windows a drive path names no project file.
  const local = powershell && path.sep === "/" ? value.replaceAll("\\", "/") : value
  if (powershell && path.sep === "/" && /^[A-Za-z]:/.test(local)) return false
  const resolved = path.resolve(directory, local.startsWith("~") ? path.join(os.homedir(), local.slice(1)) : local)
  const relative = path.relative(directory, resolved)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function pathLike(value: string) {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.startsWith("~") || value === "." || value === ".."
}

function escapesProject(arg: string) {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0]!
    return projectEscapeOptions.some(
      (option) => option.startsWith(name) || name.startsWith(`${option}.`) || name.startsWith(`${option}:`),
    )
  }
  return arg.startsWith("-") && projectEscapeFlags.test(arg.slice(1))
}

function rule(resource: string): Permission.Rule {
  return { action: "shell", resource, effect: "allow" }
}
