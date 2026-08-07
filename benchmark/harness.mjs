import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCHMARK_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = join(BENCHMARK_ROOT, "corpus.json");
const RUBRIC = [
  "Prefer cohesion above all other criteria.",
  "Then prefer scope safety: preserve behavior and avoid unrelated changes.",
  "Then prefer useful size reduction when it follows a clear local boundary.",
  "Penalize numeric file chopping and unrelated refactoring.",
];
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKSPACE_FILES = 5000;
const MAX_WORKSPACE_DIRECTORIES = 1000;
const MAX_WORKSPACE_ENTRIES = 6000;
const MAX_WORKSPACE_DEPTH = 32;
const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_TOTAL_BYTES = 32 * 1024 * 1024;
const SAFE_CHECK_ENV = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "PATHEXT",
  "GOROOT", "VIRTUAL_ENV",
];

export class BenchmarkRunError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "BenchmarkRunError";
    this.report = report;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function command(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0"))) {
    throw new Error(`${label} must be a non-empty array of non-empty strings`);
  }
  return [...value];
}

function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${label} must be a non-empty string array`);
  return [...value];
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceBundleSha256(sourceFiles) {
  const hash = createHash("sha256");
  for (const source of [...sourceFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const bytes = await readFile(source.path);
    const pathBytes = Buffer.from(source.relativePath);
    hash.update(Buffer.from(`${pathBytes.length}:`));
    hash.update(pathBytes);
    hash.update(Buffer.from(`:${bytes.length}:`));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadCorpus(path) {
  const corpus = await jsonFile(path);
  if (!object(corpus) || corpus.schemaVersion !== 1 || !Array.isArray(corpus.tasks)) throw new Error("invalid corpus manifest");
  const ids = new Set();
  for (const task of corpus.tasks) {
    if (!object(task)) throw new Error("corpus tasks must be objects");
    text(task.id, "task id");
    if (ids.has(task.id)) throw new Error(`duplicate corpus task ${task.id}`);
    ids.add(task.id);
    if (task.kind !== "synthetic" && task.kind !== "oss") throw new Error(`invalid kind for ${task.id}`);
    text(task.revision, `${task.id} revision`);
    text(task.language, `${task.id} language`);
    text(task.target, `${task.id} target`);
    text(task.prompt, `${task.id} prompt`);
    stringArray(task.acceptanceCriteria, `${task.id} acceptanceCriteria`);
    if (!Array.isArray(task.scenarioTags) || task.scenarioTags.some((tag) => typeof tag !== "string" || tag === "")) throw new Error(`invalid scenario tags for ${task.id}`);
    command(task.checkCommand, `${task.id} checkCommand`);
    if (task.kind === "synthetic") {
      text(task.fixture, `${task.id} fixture`);
      const setupCommand = command(task.setupCommand, `${task.id} setupCommand`);
      const check = command(task.checkCommand, `${task.id} checkCommand`);
      if (setupCommand.length !== 2 || setupCommand[0] !== "node" || check.length !== 2 || check[0] !== "node") throw new Error(`${task.id} controlled commands must be [\"node\", <script>]`);
      const fixture = await realpath(resolve(dirname(path), task.fixture));
      const allowedRoot = await realpath(join(BENCHMARK_ROOT, "corpus", "synthetic"));
      const outside = relative(allowedRoot, fixture) === ".." || relative(allowedRoot, fixture).startsWith(`..${sep}`);
      if (outside) throw new Error(`synthetic fixture is outside the fixture root: ${task.id}`);
      task.resolvedSetupCommand = [process.execPath, await realpath(resolve(fixture, setupCommand[1]))];
      task.resolvedCheckCommand = [process.execPath, await realpath(resolve(fixture, check[1]))];
      if (task.acceptanceCheckCommand) {
        const acceptanceCommand = command(task.acceptanceCheckCommand, `${task.id} acceptanceCheckCommand`);
        if (acceptanceCommand.length !== 2 || acceptanceCommand[0] !== "node") throw new Error(`${task.id} acceptanceCheckCommand must be [\"node\", <checked-in-script>]`);
        const script = await realpath(resolve(dirname(path), acceptanceCommand[1]));
        const acceptanceRoot = await realpath(join(BENCHMARK_ROOT, "acceptance"));
        const outsideAcceptanceRoot = relative(acceptanceRoot, script) === ".." || relative(acceptanceRoot, script).startsWith(`..${sep}`);
        if (outsideAcceptanceRoot || !(await stat(script)).isFile()) throw new Error(`${task.id} acceptance check is outside benchmark/acceptance`);
        task.resolvedAcceptanceCheckCommand = [process.execPath, script];
      }
    }
    if (task.kind === "oss") {
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(task.repository ?? "")) throw new Error(`invalid repository for ${task.id}`);
      if (!/^[0-9a-f]{40}$/.test(task.revision)) throw new Error(`OSS task ${task.id} is not pinned to a full commit`);
      text(task.license, `${task.id} license`);
      const acceptanceCommand = command(task.acceptanceCheckCommand, `${task.id} acceptanceCheckCommand`);
      if (acceptanceCommand.length !== 2 || acceptanceCommand[0] !== "node") throw new Error(`${task.id} acceptanceCheckCommand must be [\"node\", <checked-in-script>]`);
      const script = await realpath(resolve(dirname(path), acceptanceCommand[1]));
      const acceptanceRoot = await realpath(join(BENCHMARK_ROOT, "acceptance"));
      const outsideAcceptanceRoot = relative(acceptanceRoot, script) === ".." || relative(acceptanceRoot, script).startsWith(`..${sep}`);
      if (outsideAcceptanceRoot || !(await stat(script)).isFile()) throw new Error(`${task.id} acceptance check is outside benchmark/acceptance`);
      task.resolvedAcceptanceCheckCommand = [process.execPath, script];
    }
    const derivedCommands = {
      setup: task.resolvedSetupCommand,
      check: task.resolvedCheckCommand,
      acceptance: task.resolvedAcceptanceCheckCommand,
    };
    delete task.resolvedSetupCommand;
    delete task.resolvedCheckCommand;
    delete task.resolvedAcceptanceCheckCommand;
    task.taskDescriptorSha256 = sha256(stableJson(task));
    if (derivedCommands.setup) task.resolvedSetupCommand = derivedCommands.setup;
    if (derivedCommands.check) task.resolvedCheckCommand = derivedCommands.check;
    if (derivedCommands.acceptance) task.resolvedAcceptanceCheckCommand = derivedCommands.acceptance;
  }
  return corpus;
}

async function loadConfiguration(configPath, outputOverride) {
  const absoluteConfig = resolve(configPath);
  const base = dirname(absoluteConfig);
  const config = await jsonFile(absoluteConfig);
  if (!object(config)) throw new Error("benchmark config must be an object");
  if (!Array.isArray(config.families) || config.families.length !== 2) throw new Error("config must define exactly two executor families");
  const familyIds = new Set();
  const families = config.families.map((family, index) => {
    if (!object(family)) throw new Error(`family ${index} must be an object`);
    const id = text(family.id, `family ${index} id`);
    if (familyIds.has(id)) throw new Error("executor family IDs must be distinct");
    familyIds.add(id);
    return { id, executorCommand: command(family.executorCommand, `${id} executorCommand`), judgeCommand: command(family.judgeCommand, `${id} judgeCommand`) };
  });
  if (!object(config.variants) || !object(config.variants.candidate) || !object(config.variants.baseline)) throw new Error("candidate and baseline variants are required");
  const candidate = config.variants.candidate;
  const baseline = config.variants.baseline;
  const normalizedCandidate = { id: text(candidate.id, "candidate id"), revision: text(candidate.revision, "candidate revision"), extension: candidate.extension };
  const normalizedBaseline = { id: text(baseline.id, "baseline id"), revision: text(baseline.revision, "baseline revision"), extension: baseline.extension };
  if (normalizedCandidate.id === normalizedBaseline.id) throw new Error("candidate and baseline IDs must be distinct");
  if (!object(candidate.extension) || typeof candidate.extension.path !== "string" || !object(candidate.extension.config)) throw new Error("candidate extension must define path and config");
  const extensionPath = resolve(base, candidate.extension.path);
  if (!(await stat(extensionPath).catch(() => null))?.isFile()) throw new Error(`candidate extension does not exist: ${extensionPath}`);
  const configuredSourcePaths = stringArray(candidate.extension.sourcePaths, "candidate extension sourcePaths");
  const sourceFiles = configuredSourcePaths.map((sourcePath) => {
    const path = resolve(base, sourcePath);
    return { path, relativePath: relative(base, path).replaceAll("\\", "/") };
  });
  if (new Set(sourceFiles.map(({ relativePath }) => relativePath)).size !== sourceFiles.length) throw new Error("candidate extension sourcePaths must be unique");
  for (const source of sourceFiles) {
    if (!(await stat(source.path).catch(() => null))?.isFile()) throw new Error(`candidate extension source does not exist: ${source.relativePath}`);
  }
  if (!sourceFiles.some((source) => source.path === extensionPath)) throw new Error("candidate extension sourcePaths must include the extension entrypoint");
  sourceFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const sourceSha256 = await sourceBundleSha256(sourceFiles);
  if (candidate.extension.sourceSha256 !== undefined && candidate.extension.sourceSha256 !== sourceSha256) throw new Error("candidate extension sourceSha256 mismatch");
  const configJson = stableJson(candidate.extension.config);
  const configSha256 = sha256(configJson);
  normalizedCandidate.extension = {
    path: extensionPath,
    sourceFiles,
    sourcePaths: sourceFiles.map(({ relativePath }) => relativePath),
    config: candidate.extension.config,
    sourceSha256,
    configSha256,
    effectiveSha256: sha256(`${sourceSha256}\0${configSha256}`),
  };
  if (normalizedBaseline.extension !== null) throw new Error("baseline extension must be null");
  if (!Array.isArray(config.tasks) || config.tasks.length === 0 || config.tasks.some((id) => typeof id !== "string" || id === "")) throw new Error("tasks must be a non-empty array of IDs");
  if (new Set(config.tasks).size !== config.tasks.length) throw new Error("task IDs must not be repeated");
  const outputValue = outputOverride ?? config.output;
  text(outputValue, "output");
  if (typeof config.seed !== "string" && !Number.isSafeInteger(config.seed)) throw new Error("seed must be a string or safe integer");
  return {
    base,
    seed: String(config.seed),
    repetitions: integer(config.repetitions, "repetitions", 1, 100),
    timeoutMs: integer(config.timeoutMs ?? 120000, "timeoutMs", 1, 3600000),
    checkTimeoutMs: integer(config.checkTimeoutMs ?? config.timeoutMs ?? 120000, "checkTimeoutMs", 1, 3600000),
    families,
    variants: { candidate: normalizedCandidate, baseline: normalizedBaseline },
    taskIds: [...config.tasks],
    output: isAbsolute(outputValue) ? outputValue : resolve(base, outputValue),
    corpus: config.corpus ? resolve(base, text(config.corpus, "corpus")) : DEFAULT_CORPUS,
  };
}

function seededRandom(seed) {
  let hash = 2166136261;
  for (const character of seed) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return () => {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function abortError() {
  const error = new Error("benchmark run aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function runProcess(argv, { cwd, input, timeoutMs, env = process.env, signal, activeChildren }) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(abortError());
    const started = process.hrtime.bigint();
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedError = null;
    let spawnError = null;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    activeChildren?.add(child);
    const force = (error) => {
      if (forcedError) return;
      forcedError = error;
      try { killProcessGroup(child); } catch (killError) { forcedError = new Error(`${error.message}; process-group kill failed: ${killError.message}`); }
    };
    const onAbort = () => force(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => force(new Error(`command timed out after ${timeoutMs}ms: ${argv[0]}`)), timeoutMs);
    const append = (chunks, chunk, stream) => {
      if (forcedError) return;
      const bytes = stream === "stdout" ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (stream === "stdout") stdoutBytes = bytes;
      else stderrBytes = bytes;
      if (bytes > MAX_OUTPUT_BYTES) {
        force(new Error(`command ${stream} exceeded ${MAX_OUTPUT_BYTES} bytes: ${argv[0]}`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk) => append(stdoutChunks, chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(stderrChunks, chunk, "stderr"));
    child.on("error", (error) => { spawnError = error; });
    child.stdin?.on("error", (error) => { if (!forcedError) force(error); });
    child.on("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      activeChildren?.delete(child);
      const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
      const error = forcedError ?? spawnError;
      if (error) {
        error.runtimeMs = runtimeMs;
        reject(error);
      } else {
        resolvePromise({
          code,
          signal: childSignal,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
          runtimeMs,
        });
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function runJsonAdapter(argv, request, options) {
  const result = await runProcess(argv, { ...options, input: `${JSON.stringify(request)}\n` });
  if (result.code !== 0) throw Object.assign(new Error(`adapter exited ${result.code ?? result.signal}: ${result.stderr.trim()}`), { runtimeMs: result.runtimeMs });
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw Object.assign(new Error("adapter stdout was not one JSON object"), { runtimeMs: result.runtimeMs }); }
  if (!object(response)) throw Object.assign(new Error("adapter response must be a JSON object"), { runtimeMs: result.runtimeMs });
  return { response, runtimeMs: result.runtimeMs };
}

function validatedTokenUsage(value, label) {
  if (value === undefined || value === null) return null;
  if (!object(value) || !Number.isSafeInteger(value.input) || value.input < 0 || !Number.isSafeInteger(value.output) || value.output < 0) {
    throw new Error(`${label} tokenUsage must contain non-negative safe integer input and output`);
  }
  const keys = Object.keys(value).sort();
  const allowed = value.cached === undefined ? ["input", "output"] : ["cached", "input", "output"];
  if (keys.join(",") !== allowed.join(",") || (value.cached !== undefined && (!Number.isSafeInteger(value.cached) || value.cached < 0))) {
    throw new Error(`${label} tokenUsage has invalid fields`);
  }
  return { input: value.input, output: value.output, ...(value.cached === undefined ? {} : { cached: value.cached }) };
}

function validatedJsonData(value, label) {
  let nodes = 0;
  function visit(item, depth) {
    nodes++;
    if (nodes > 1000 || depth > 12) throw new Error(`${label} is too complex`);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > 4096) throw new Error(`${label} contains an oversized string`);
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${label} contains a non-finite number`);
      return item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
      if (key.length > 256) throw new Error(`${label} contains an oversized key`);
      return [key, visit(entry, depth + 1)];
    }));
    throw new Error(`${label} is not JSON-safe`);
  }
  return visit(value, 0);
}

async function successfulCommand(argv, options) {
  const result = await runProcess(argv, options);
  if (result.code !== 0) throw Object.assign(new Error(`command exited ${result.code ?? result.signal}: ${result.stderr.trim()}`), { runtimeMs: result.runtimeMs });
  return result;
}

async function isolatedEnvironment(root) {
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const goPath = join(root, "gopath");
  const goCache = join(root, "gocache");
  await Promise.all([home, temporary, goPath, goCache].map((path) => mkdir(path, { recursive: true })));
  const env = {};
  for (const name of SAFE_CHECK_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, GOPATH: goPath, GOCACHE: goCache };
}

async function prepareWorkspace(task, workspace, timeoutMs, environmentRoot, runControl) {
  if (task.kind === "synthetic") {
    await mkdir(workspace);
    const env = await isolatedEnvironment(environmentRoot);
    await successfulCommand(task.resolvedSetupCommand, { cwd: workspace, timeoutMs, env, ...runControl });
    return;
  }
  await mkdir(workspace);
  await successfulCommand(["git", "init", "--quiet"], { cwd: workspace, timeoutMs, ...runControl });
  await successfulCommand(["git", "remote", "add", "origin", task.repository], { cwd: workspace, timeoutMs, ...runControl });
  await successfulCommand(["git", "fetch", "--quiet", "--depth=1", "origin", task.revision], { cwd: workspace, timeoutMs, ...runControl });
  await successfulCommand(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: workspace, timeoutMs, ...runControl });
  const head = await successfulCommand(["git", "rev-parse", "HEAD"], { cwd: workspace, timeoutMs, ...runControl });
  if (head.stdout.trim() !== task.revision) throw new Error(`checkout revision mismatch for ${task.id}`);
}

async function snapshotWorkspace(root, runControl) {
  const entries = new Map();
  const inventory = [];
  let totalBytes = 0;
  let directoryCount = 1;
  let entryCount = 1;
  async function walk(directory, prefix = "", depth = 0) {
    throwIfAborted(runControl?.signal);
    if (depth > MAX_WORKSPACE_DEPTH) throw new Error(`workspace depth exceeded ${MAX_WORKSPACE_DEPTH}: ${prefix}`);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      throwIfAborted(runControl?.signal);
      if (prefix === "" && entry.name === ".git") continue;
      entryCount++;
      if (entryCount > MAX_WORKSPACE_ENTRIES) throw new Error(`workspace entry count exceeded ${MAX_WORKSPACE_ENTRIES}`);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        directoryCount++;
        if (directoryCount > MAX_WORKSPACE_DIRECTORIES) throw new Error(`workspace directory count exceeded ${MAX_WORKSPACE_DIRECTORIES}`);
        await walk(absolute, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
      inventory.push({ relativePath, absolute, metadata });
      if (inventory.length > MAX_WORKSPACE_FILES) throw new Error(`workspace file count exceeded ${MAX_WORKSPACE_FILES}`);
      if (metadata.size > MAX_WORKSPACE_FILE_BYTES) throw new Error(`workspace file exceeded ${MAX_WORKSPACE_FILE_BYTES} bytes: ${relativePath}`);
      totalBytes += metadata.size;
      if (totalBytes > MAX_WORKSPACE_TOTAL_BYTES) throw new Error(`workspace content exceeded ${MAX_WORKSPACE_TOTAL_BYTES} bytes`);
    }
  }
  await walk(root);

  let actualTotalBytes = 0;
  for (const item of inventory) {
    throwIfAborted(runControl?.signal);
    let bytes;
    if (item.metadata.isSymbolicLink()) bytes = Buffer.from(await readlink(item.absolute));
    else {
      const handle = await open(item.absolute, "r");
      const chunks = [];
      let fileBytes = 0;
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (true) {
          throwIfAborted(runControl?.signal);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          fileBytes += bytesRead;
          if (fileBytes > MAX_WORKSPACE_FILE_BYTES) throw new Error(`workspace file exceeded ${MAX_WORKSPACE_FILE_BYTES} bytes while reading: ${item.relativePath}`);
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
      } finally {
        await handle.close();
      }
      bytes = Buffer.concat(chunks, fileBytes);
    }
    if (bytes.length > MAX_WORKSPACE_FILE_BYTES) throw new Error(`workspace file exceeded ${MAX_WORKSPACE_FILE_BYTES} bytes while reading: ${item.relativePath}`);
    actualTotalBytes += bytes.length;
    if (actualTotalBytes > MAX_WORKSPACE_TOTAL_BYTES) throw new Error(`workspace content exceeded ${MAX_WORKSPACE_TOTAL_BYTES} bytes while reading`);
    entries.set(item.relativePath, { type: item.metadata.isSymbolicLink() ? "symlink" : "file", mode: item.metadata.mode & 0o777, bytes });
  }
  return entries;
}

function artifactValue(entry) {
  if (!entry) return null;
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes); } catch { decoded = null; }
  if (decoded === null || decoded.includes("\0")) {
    return { type: entry.type, mode: entry.mode, sha256: sha256(entry.bytes), content: { encoding: "base64", value: entry.bytes.toString("base64") } };
  }
  const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { type: entry.type, mode: entry.mode, sha256: sha256(normalized), content: { encoding: "utf8", value: normalized } };
}

function normalizedArtifact(before, after) {
  const changes = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.type === newEntry.type && oldEntry.mode === newEntry.mode && oldEntry.bytes.equals(newEntry.bytes)) continue;
    changes.push({ path, status: !oldEntry ? "added" : !newEntry ? "deleted" : "modified", before: artifactValue(oldEntry), after: artifactValue(newEntry) });
  }
  const artifact = stableJson(changes);
  if (Buffer.byteLength(artifact) > MAX_OUTPUT_BYTES) throw new Error(`normalized artifact exceeded ${MAX_OUTPUT_BYTES} bytes`);
  return artifact;
}

function executorTask(task) {
  return { id: task.id, language: task.language, target: task.target, scenarioTags: task.scenarioTags, prompt: task.prompt, acceptanceCriteria: task.acceptanceCriteria };
}

async function executeTrajectory({ family, variant, task, workspace, config, environmentRoot }) {
  const started = process.hrtime.bigint();
  try {
    await prepareWorkspace(task, workspace, config.timeoutMs, join(environmentRoot, "setup"), config.runControl);
    const before = await snapshotWorkspace(workspace, config.runControl);
    if (variant.extension && await sourceBundleSha256(variant.extension.sourceFiles) !== variant.extension.sourceSha256) throw new Error("candidate extension sources changed after configuration was loaded");
    const { response } = await runJsonAdapter(family.executorCommand, {
      protocolVersion: 1,
      extension: variant.extension ? {
        path: variant.extension.path,
        sourcePaths: variant.extension.sourcePaths,
        config: variant.extension.config,
        sourceSha256: variant.extension.sourceSha256,
        configSha256: variant.extension.configSha256,
        effectiveSha256: variant.extension.effectiveSha256,
      } : null,
      workspace,
      taskRevision: task.revision,
      task: executorTask(task),
    }, { cwd: config.base, timeoutMs: config.timeoutMs, ...config.runControl });
    if (typeof response.answer !== "string" || response.answer.trim() === "") throw new Error("executor response.answer must be a non-empty string");
    const tokenUsage = validatedTokenUsage(response.tokenUsage, "executor");
    const observedSignal = response.observedSignal === undefined ? null : validatedJsonData(response.observedSignal, "executor observedSignal");
    const artifact = normalizedArtifact(before, await snapshotWorkspace(workspace, config.runControl));
    return {
      ok: true,
      answer: response.answer,
      observedSignal,
      tokenUsage,
      runtimeMs: Number(process.hrtime.bigint() - started) / 1e6,
      artifact,
      artifactSha256: sha256(artifact),
      error: null,
    };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { ok: false, answer: null, observedSignal: null, tokenUsage: null, runtimeMs: error.runtimeMs ?? Number(process.hrtime.bigint() - started) / 1e6, artifact: null, artifactSha256: null, error: error.message };
  }
}

async function checkDetail(commandToRun, label, options) {
  try {
    const result = await runProcess(commandToRun, options);
    return {
      status: result.code === 0 ? "passed" : "failed",
      runtimeMs: result.runtimeMs,
      exitCode: result.code,
      error: result.code === 0 ? null : (result.stderr.trim() || `${label} exited ${result.code ?? result.signal}`),
    };
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return { status: "failed", runtimeMs: error.runtimeMs ?? null, exitCode: null, error: error.message };
  }
}

async function deterministicCheck(task, workspace, execution, timeoutMs, environmentRoot, runControl) {
  if (!execution.ok) return { status: "not-run", upstream: { status: "not-run", runtimeMs: null, exitCode: null, error: "executor failed" }, acceptance: { status: "not-run", runtimeMs: null, exitCode: null, error: "executor failed" } };
  const env = await isolatedEnvironment(environmentRoot);
  const options = { cwd: workspace, timeoutMs, env, ...runControl };
  const upstream = await checkDetail(task.resolvedCheckCommand ?? task.checkCommand, "upstream check", options);
  const acceptance = task.resolvedAcceptanceCheckCommand
    ? await checkDetail(task.resolvedAcceptanceCheckCommand, "acceptance check", options)
    : { status: "not-applicable", runtimeMs: null, exitCode: null, error: null };
  const passed = upstream.status === "passed" && (acceptance.status === "passed" || acceptance.status === "not-applicable");
  return { status: passed ? "passed" : "failed", upstream, acceptance };
}

function blindTask(task) {
  return {
    id: task.id,
    language: task.language,
    target: task.target,
    scenarioTags: task.scenarioTags,
    prompt: task.prompt,
    acceptanceCriteria: task.acceptanceCriteria,
    rubricPriority: RUBRIC,
  };
}

async function judgePair(family, task, orderedArtifacts, config) {
  const { response, runtimeMs } = await runJsonAdapter(family.judgeCommand, {
    task: blindTask(task),
    artifacts: orderedArtifacts.map((artifact, index) => ({ label: index === 0 ? "A" : "B", artifact })),
  }, { cwd: config.base, timeoutMs: config.timeoutMs, ...config.runControl });
  if (!new Set(["A", "B", "tie"]).has(response.verdict)) throw Object.assign(new Error("judge verdict must be A, B, or tie"), { runtimeMs });
  if (response.rationale !== undefined && response.rationale !== null && typeof response.rationale !== "string") throw Object.assign(new Error("judge rationale must be a string or null"), { runtimeMs });
  let tokenUsage;
  try { tokenUsage = validatedTokenUsage(response.tokenUsage, "judge"); } catch (error) { error.runtimeMs = runtimeMs; throw error; }
  return { verdict: response.verdict, rationale: response.rationale ?? null, tokenUsage, runtimeMs };
}

function variantReport(config) {
  const extension = config.variants.candidate.extension;
  return {
    candidate: {
      id: config.variants.candidate.id,
      revision: config.variants.candidate.revision,
      extension: { sourcePaths: extension.sourcePaths, config: extension.config, sourceSha256: extension.sourceSha256, configSha256: extension.configSha256, effectiveSha256: extension.effectiveSha256 },
    },
    baseline: { id: config.variants.baseline.id, revision: config.variants.baseline.revision, extension: null },
  };
}

function familySummary(records, familyId) {
  const own = records.filter((record) => record.executorFamily === familyId);
  const judged = own.filter((record) => ["candidate", "baseline", "tie"].includes(record.verdict));
  const wins = judged.filter((record) => record.verdict === "candidate").length;
  const losses = judged.filter((record) => record.verdict === "baseline").length;
  const ties = judged.filter((record) => record.verdict === "tie").length;
  const score = wins + ties * 0.5;
  return {
    familyId,
    pairs: own.length,
    judgedPairs: judged.length,
    wins,
    losses,
    ties,
    score,
    rate: judged.length === 0 ? null : score / judged.length,
    deterministicGatePassed: own.every((record) => record.deterministicChecks.candidate.status === "passed" && record.deterministicChecks.baseline.status === "passed"),
  };
}

function summarize(records, families) {
  const judged = records.filter((record) => ["candidate", "baseline", "tie"].includes(record.verdict));
  const candidateWins = judged.filter((record) => record.verdict === "candidate").length;
  const baselineWins = judged.filter((record) => record.verdict === "baseline").length;
  const ties = judged.filter((record) => record.verdict === "tie").length;
  const candidateScore = candidateWins + ties * 0.5;
  return {
    pairs: records.length,
    judgedPairs: judged.length,
    candidateWins,
    baselineWins,
    ties,
    candidateScore,
    pairwiseWinRate: judged.length === 0 ? null : candidateScore / judged.length,
    deterministicGatePassed: records.every((record) => record.deterministicChecks.candidate.status === "passed" && record.deterministicChecks.baseline.status === "passed"),
    executorFamilies: families.map(({ id }) => familySummary(records, id)),
  };
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function artifactLeak(artifact, forbiddenValues) {
  if (artifact === null) return null;
  const forbidden = [...new Set(forbiddenValues.filter((value) => typeof value === "string" && value.length >= 4))];
  let changes;
  try { changes = JSON.parse(artifact); } catch { return "artifact is not valid normalized JSON"; }
  for (const change of changes) {
    for (const value of forbidden) if (String(change.path).includes(value)) return `artifact path contains forbidden execution metadata (${sha256(value).slice(0, 12)})`;
    for (const side of [change.before, change.after]) {
      if (!side?.content) continue;
      const bytes = side.content.encoding === "base64" ? Buffer.from(side.content.value, "base64") : Buffer.from(side.content.value);
      for (const value of forbidden) if (bytes.indexOf(Buffer.from(value)) !== -1) return `artifact contains forbidden execution metadata (${sha256(value).slice(0, 12)})`;
    }
  }
  return null;
}

export async function runBenchmark(configPath, options = {}) {
  const config = await loadConfiguration(configPath, options.output);
  config.runControl = { signal: options.signal, activeChildren: new Set() };
  const corpus = await loadCorpus(config.corpus);
  const tasksById = new Map(corpus.tasks.map((task) => [task.id, task]));
  const tasks = config.taskIds.map((id) => {
    const task = tasksById.get(id);
    if (!task) throw new Error(`unknown corpus task: ${id}`);
    return task;
  });
  const random = seededRandom(config.seed);
  const report = { schemaVersion: 2, seed: config.seed, repetitions: config.repetitions, generatedAt: new Date().toISOString(), corpus: config.corpus, variants: variantReport(config), records: [], summary: null };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-file-size-benchmark-"));
  const hardErrors = [];
  try {
    for (const task of tasks) {
      for (let repetition = 0; repetition < config.repetitions; repetition++) {
        for (let executorIndex = 0; executorIndex < config.families.length; executorIndex++) {
          if (options.signal?.aborted) throw abortError();
          const executorFamily = config.families[executorIndex];
          const judgeFamily = config.families[1 - executorIndex];
          const pairNonce = sha256(`${config.seed}:${report.records.length}:${task.id}`).slice(0, 16);
          const pairRoot = join(temporaryRoot, `pair-${pairNonce}`);
          const candidateWorkspace = join(pairRoot, `workspace-${sha256(`${pairNonce}:0`).slice(0, 16)}`);
          const baselineWorkspace = join(pairRoot, `workspace-${sha256(`${pairNonce}:1`).slice(0, 16)}`);
          await mkdir(pairRoot, { recursive: true });
          const candidate = await executeTrajectory({ family: executorFamily, variant: config.variants.candidate, task, workspace: candidateWorkspace, config, environmentRoot: join(pairRoot, "environment-0") });
          const candidateCheck = await deterministicCheck(task, candidateWorkspace, candidate, config.checkTimeoutMs, join(pairRoot, "check-environment-0"), config.runControl);
          const baseline = await executeTrajectory({ family: executorFamily, variant: config.variants.baseline, task, workspace: baselineWorkspace, config, environmentRoot: join(pairRoot, "environment-1") });
          const baselineCheck = await deterministicCheck(task, baselineWorkspace, baseline, config.checkTimeoutMs, join(pairRoot, "check-environment-1"), config.runControl);
          const order = random() < 0.5 ? ["candidate", "baseline"] : ["baseline", "candidate"];
          const record = {
            taskId: task.id,
            taskRevision: task.revision,
            taskDescriptorSha256: task.taskDescriptorSha256,
            repetition,
            candidateRevision: config.variants.candidate.revision,
            baselineRevision: config.variants.baseline.revision,
            candidateExtension: {
              sourcePaths: config.variants.candidate.extension.sourcePaths,
              config: config.variants.candidate.extension.config,
              sourceSha256: config.variants.candidate.extension.sourceSha256,
              configSha256: config.variants.candidate.extension.configSha256,
              effectiveSha256: config.variants.candidate.extension.effectiveSha256,
            },
            executorFamily: executorFamily.id,
            judgeFamily: judgeFamily.id,
            randomizedOrder: order,
            verdict: "invalid",
            blindJudgeVerdict: null,
            rationale: null,
            runtimeMs: { candidate: candidate.runtimeMs, baseline: baseline.runtimeMs, judge: null },
            tokenUsage: { candidate: candidate.tokenUsage, baseline: baseline.tokenUsage, judge: null },
            deterministicChecks: { candidate: candidateCheck, baseline: baselineCheck },
            artifacts: { candidate: candidate.artifact, baseline: baseline.artifact },
            artifactSha256: { candidate: candidate.artifactSha256, baseline: baseline.artifactSha256 },
            observedSignals: { candidate: candidate.observedSignal, baseline: baseline.observedSignal },
            executorAnswers: { candidate: candidate.answer, baseline: baseline.answer },
            executionErrors: { candidate: candidate.error, baseline: baseline.error },
            artifactLeaks: { candidate: null, baseline: null },
          };
          const forbiddenArtifactValues = [
            temporaryRoot, candidateWorkspace, baselineWorkspace,
            config.variants.candidate.id, config.variants.candidate.revision,
            config.variants.baseline.id, config.variants.baseline.revision,
            ...config.families.map(({ id }) => id),
            config.variants.candidate.extension.path,
            ...config.variants.candidate.extension.sourceFiles.map(({ path }) => path),
            ...config.variants.candidate.extension.sourcePaths,
            config.variants.candidate.extension.sourceSha256,
            config.variants.candidate.extension.configSha256,
            config.variants.candidate.extension.effectiveSha256,
            stableJson(config.variants.candidate.extension.config),
            JSON.stringify(config.variants.candidate.extension.config),
          ];
          record.artifactLeaks.candidate = artifactLeak(candidate.artifact, forbiddenArtifactValues);
          record.artifactLeaks.baseline = artifactLeak(baseline.artifact, forbiddenArtifactValues);
          if (candidateCheck.status !== "passed" || baselineCheck.status !== "passed") hardErrors.push(`${task.id}/${executorFamily.id}: deterministic gate failed`);
          if (record.artifactLeaks.candidate || record.artifactLeaks.baseline) hardErrors.push(`${task.id}/${executorFamily.id}: artifact leakage detected`);
          if (candidateCheck.status === "passed" && baselineCheck.status === "passed" && !record.artifactLeaks.candidate && !record.artifactLeaks.baseline) {
            try {
              const artifactByVariant = { candidate: candidate.artifact, baseline: baseline.artifact };
              if (candidate.artifact === baseline.artifact) {
                record.blindJudgeVerdict = "tie";
                record.verdict = "tie";
                record.rationale = "Automatic tie: normalized artifacts are identical.";
              } else {
                const judged = await judgePair(judgeFamily, task, order.map((name) => artifactByVariant[name]), config);
                record.blindJudgeVerdict = judged.verdict;
                record.rationale = judged.rationale;
                record.runtimeMs.judge = judged.runtimeMs;
                record.tokenUsage.judge = judged.tokenUsage;
                record.verdict = judged.verdict === "tie" ? "tie" : order[judged.verdict === "A" ? 0 : 1];
              }
            } catch (error) {
              if (error.name === "AbortError") throw error;
              record.verdict = "error";
              record.runtimeMs.judge = error.runtimeMs ?? null;
              hardErrors.push(`${task.id}/${judgeFamily.id}: ${error.message}`);
            }
          }
          report.records.push(record);
        }
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  throwIfAborted(options.signal);
  report.summary = summarize(report.records, config.families);
  await writeReport(config.output, report);
  throwIfAborted(options.signal);
  if (hardErrors.length > 0) throw new BenchmarkRunError(`benchmark failed hard gates: ${hardErrors.join("; ")}`, report);
  return { report, output: config.output };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== "--config" || args.length > 4 || (args.length === 4 && args[2] !== "--output")) {
    console.error("Usage: node benchmark/harness.mjs --config <config.json> [--output <report.json>]");
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runBenchmark(args[1], { output: args[3], signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
  } catch (error) {
    if (error.report) process.stdout.write(`${JSON.stringify(error.report)}\n`);
    console.error(error.message);
    process.exitCode = error.name === "AbortError" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
