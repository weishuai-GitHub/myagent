import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const runtimeRequire = createRequire(__filename);
const childProcessModule = runtimeRequire('child_process');

interface ExecuteRequest {
  type: 'execute';
  entryPath: string;
  args: Record<string, unknown>;
  context: {
    env: Record<string, string>;
    workspaceDir: string;
    availableComponents?: string;
  };
  capabilities: string[];
  allowedExternalPaths?: string[];
  maxResultChars: number;
}

process.once('message', async (request: ExecuteRequest) => {
  if (!request || request.type !== 'execute') {
    send({ type: 'error', error: 'Invalid ToolHost request' });
    return;
  }

  try {
    const modulePath = runtimeRequire.resolve(request.entryPath);
    applyCapabilityGuards(
      new Set(request.capabilities),
      request.context.workspaceDir,
      request.entryPath,
      request.allowedExternalPaths ?? []
    );
    delete runtimeRequire.cache[modulePath];
    const loaded = runtimeRequire(modulePath);
    const executor = loaded.execute || loaded.default?.execute;
    if (typeof executor !== 'function') {
      throw new Error('Tool entry does not export execute(args, context)');
    }
    const context = {
      ...request.context,
      resolvePath(inputPath: string): string {
        const resolved = path.isAbsolute(inputPath)
          ? path.resolve(inputPath)
          : path.resolve(request.context.workspaceDir, inputPath);
        const relative = path.relative(request.context.workspaceDir, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Path is outside workspace: ${inputPath}`);
        }
        return resolved;
      }
    };
    const result = await executor(request.args, context);
    const serialized = safeStringify(result);
    if (serialized.length > request.maxResultChars) {
      throw new Error(
        `Raw tool result exceeds isolated-host limit (${serialized.length} > ${request.maxResultChars})`
      );
    }
    send({ type: 'result', data: JSON.parse(serialized) });
  } catch (error) {
    send({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

function applyCapabilityGuards(
  capabilities: Set<string>,
  workspaceDir: string,
  entryPath: string,
  allowedExternalPaths: string[]
): void {
  if (!capabilities.has('shell')) {
    const blocked = () => {
      throw new Error('ToolHost denied undeclared shell capability');
    };
    childProcessModule.exec = blocked;
    childProcessModule.execFile = blocked;
    childProcessModule.spawn = blocked;
    childProcessModule.fork = blocked;
  }

  if (!capabilities.has('network')) {
    (globalThis as any).fetch = async () => {
      throw new Error('ToolHost denied undeclared network capability');
    };
    for (const moduleName of ['http', 'https', 'net', 'tls', 'dgram']) {
      const module = runtimeRequire(moduleName);
      for (const method of ['request', 'get', 'connect', 'createConnection', 'createSocket']) {
        if (typeof module[method] === 'function') {
          module[method] = () => {
            throw new Error('ToolHost denied undeclared network capability');
          };
        }
      }
    }
  }

  applyFileSystemGuards(capabilities, workspaceDir, entryPath, allowedExternalPaths);
}

function applyFileSystemGuards(
  capabilities: Set<string>,
  workspaceDir: string,
  entryPath: string,
  allowedExternalPaths: string[]
): void {
  const fsModule = runtimeRequire('fs');
  const nativeRealpath = typeof fsModule.realpathSync.native === 'function'
    ? fsModule.realpathSync.native.bind(fsModule.realpathSync)
    : fsModule.realpathSync.bind(fsModule);
  const canonicalize = (inputPath: string): string => {
    const absolute = path.resolve(inputPath);
    let current = absolute;
    const suffix: string[] = [];
    while (!fsModule.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(path.basename(current));
      current = parent;
    }
    const realExisting = nativeRealpath(current);
    return path.resolve(realExisting, ...suffix);
  };
  const canRead = capabilities.has('filesystem-read') || capabilities.has('filesystem-write');
  const canWrite = capabilities.has('filesystem-write');
  const entryRoot = canonicalize(path.dirname(entryPath));
  const readRoots = [
    canonicalize(workspaceDir),
    entryRoot,
    ...allowedExternalPaths.map(canonicalize)
  ];
  const writeRoots = [
    canonicalize(workspaceDir),
    ...allowedExternalPaths.map(canonicalize)
  ];

  const assertPath = (input: unknown, write: boolean) => {
    if (typeof input === 'number') return;
    const inputPath = input instanceof URL ? fileURLToPath(input) : input;
    if (typeof inputPath !== 'string') {
      throw new Error('ToolHost denied an unrecognized filesystem path');
    }
    const candidate = canonicalize(inputPath);
    const canReadToolFiles = !write && isInside(entryRoot, candidate);
    if ((write ? !canWrite : !canRead) && !canReadToolFiles) {
      throw new Error(
        `ToolHost denied undeclared filesystem-${write ? 'write' : 'read'} capability for ${inputPath}`
      );
    }
    const roots = write ? writeRoots : readRoots;
    if (!roots.some(root => isInside(root, candidate))) {
      throw new Error(`ToolHost denied path outside approved roots: ${inputPath}`);
    }
  };

  const wrap = (target: any, method: string, write: boolean, pathIndexes: number[] = [0]) => {
    if (typeof target[method] !== 'function') return;
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      for (const index of pathIndexes) assertPath(args[index], write);
      return original(...args);
    };
  };

  for (const method of [
    'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync',
    'lstat', 'lstatSync', 'access', 'accessSync', 'realpath', 'realpathSync',
    'readlink', 'readlinkSync', 'createReadStream', 'watch'
  ]) {
    wrap(fsModule, method, false);
  }
  for (const method of [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'unlink',
    'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync',
    'chmod', 'chmodSync', 'chown', 'chownSync', 'truncate', 'truncateSync',
    'createWriteStream'
  ]) {
    wrap(fsModule, method, true);
  }
  for (const method of ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'link', 'linkSync']) {
    wrap(fsModule, method, true, [0, 1]);
  }

  const promises = fsModule.promises;
  for (const method of [
    'readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'readlink'
  ]) {
    wrap(promises, method, false);
  }
  for (const method of [
    'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'chmod',
    'chown', 'truncate'
  ]) {
    wrap(promises, method, true);
  }
  for (const method of ['rename', 'copyFile', 'link']) {
    wrap(promises, method, true, [0, 1]);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message };
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

function send(message: unknown): void {
  if (!process.send) return;
  process.send(message, () => process.disconnect());
}
