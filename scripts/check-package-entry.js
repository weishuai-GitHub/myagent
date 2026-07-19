const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entry = path.resolve(root, packageJson.main || '');

if (!packageJson.main) {
  throw new Error('package.json 缺少 main 扩展入口');
}
if (!fs.existsSync(entry)) {
  throw new Error(`扩展入口不存在: ${packageJson.main}。请先执行 npm run build`);
}

console.log(`扩展入口检查通过: ${packageJson.main}`);

for (const requiredAsset of ['dist/webview.js', 'dist/tool-host.js']) {
  if (!fs.existsSync(path.join(root, requiredAsset))) {
    throw new Error(`发布产物缺失: ${requiredAsset}`);
  }
}
console.log('Webview 与 ToolHost 产物检查通过');
