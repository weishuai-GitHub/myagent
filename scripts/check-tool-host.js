const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const root = path.resolve(__dirname, '..');
const hostPath = path.join(root, 'dist', 'tool-host.js');

async function runHost(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(hostPath, [], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let diagnostics = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ToolHost smoke test timed out'));
    }, 3_000);
    child.stderr.on('data', chunk => {
      diagnostics = `${diagnostics}${String(chunk)}`.slice(-4_000);
    });
    child.on('message', message => {
      clearTimeout(timer);
      if (child.connected) child.disconnect();
      resolve(message);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`ToolHost exited with ${code}: ${diagnostics}`));
      }
    });
    child.send(request);
  });
}

async function main() {
  if (!fs.existsSync(hostPath)) {
    throw new Error('dist/tool-host.js 不存在，请先执行 npm run build');
  }
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-tool-host-'));
  const entryPath = path.join(temporaryDir, 'index.js');
  fs.writeFileSync(entryPath, `
    const fs = require('fs');
    exports.execute = async (args, context) => {
      if (args.readPath) return fs.readFileSync(args.readPath, 'utf8');
      return { value: args.value, safeEnv: context.env.SAFE_ENV, leaked: context.env.SECRET_ENV };
    };
  `);
  try {
    const baseRequest = {
      type: 'execute',
      entryPath,
      context: { env: { SAFE_ENV: 'visible' }, workspaceDir: root },
      allowedExternalPaths: [],
      maxResultChars: 10_000
    };
    const success = await runHost({
      ...baseRequest,
      args: { value: 'ok' },
      capabilities: []
    }, { SAFE_ENV: 'visible' });
    if (
      success.type !== 'result' ||
      success.data?.value !== 'ok' ||
      success.data?.safeEnv !== 'visible' ||
      success.data?.leaked !== undefined
    ) {
      throw new Error(`ToolHost 环境隔离检查失败: ${JSON.stringify(success)}`);
    }

    const denied = await runHost({
      ...baseRequest,
      args: { readPath: '/etc/passwd' },
      capabilities: ['filesystem-read']
    });
    if (denied.type !== 'error' || !/outside approved roots/.test(denied.error || '')) {
      throw new Error(`ToolHost 路径边界检查失败: ${JSON.stringify(denied)}`);
    }
    console.log('ToolHost 进程、环境与路径边界检查通过');
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
