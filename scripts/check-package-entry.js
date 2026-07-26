const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entry = path.resolve(root, packageJson.main || '');

async function main() {
  if (!packageJson.main) {
    throw new Error('package.json 缺少 main 扩展入口');
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`扩展入口不存在: ${packageJson.main}。请先执行 npm run build`);
  }

  console.log(`扩展入口检查通过: ${packageJson.main}`);

  for (const requiredAsset of ['dist/webview.js', 'dist/tool-host.js', 'dist/sql-wasm.wasm']) {
    if (!fs.existsSync(path.join(root, requiredAsset))) {
      throw new Error(`发布产物缺失: ${requiredAsset}`);
    }
  }

  const extensionSource = fs.readFileSync(entry, 'utf8');
  if (!extensionSource.includes('sql.js/dist/sql-wasm.js')) {
    throw new Error('Extension bundle 未保留 sql.js Node 运行时依赖');
  }
  if (extensionSource.includes('We are modularizing this manually')) {
    throw new Error('Extension bundle 错误地内嵌了 sql.js，F5 初始化可能破坏 module.exports');
  }

  const initSqlJs = require('sql.js/dist/sql-wasm.js');
  const SQL = await initSqlJs({
    locateFile: () => path.join(root, 'dist', 'sql-wasm.wasm')
  });
  const database = new SQL.Database();
  try {
    database.run('CREATE TABLE package_smoke_test (id INTEGER)');
    database.run('INSERT INTO package_smoke_test VALUES (1)');
    const result = database.exec('SELECT id FROM package_smoke_test');
    if (result[0]?.values[0]?.[0] !== 1) {
      throw new Error('SQLite WASM 冒烟查询返回异常');
    }
  } finally {
    database.close();
  }

  console.log('Webview、ToolHost 与外置 SQLite WASM 产物检查通过');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
