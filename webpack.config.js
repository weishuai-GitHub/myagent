const path = require('path');
const fs = require('fs');

class CopySqlJsWasmPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopySqlJsWasmPlugin', () => {
      const source = require.resolve('sql.js/dist/sql-wasm.wasm');
      const target = path.join(compiler.options.output.path, 'sql-wasm.wasm');
      fs.copyFileSync(source, target);
    });
  }
}

const webviewConfig = {
  name: 'webview',
  mode: 'development',
  devtool: 'source-map',
  entry: './src/webview/App.tsx',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'webview.js',
    library: {
      name: 'webviewApp',
      type: 'umd'
    },
    globalObject: 'this'
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx']
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  plugins: []
};

const extensionConfig = {
  name: 'extension',
  mode: 'development',
  devtool: 'source-map',
  entry: {
    extension: './src/extension.ts',
    'tool-host': './src/agent/component/tools/tool-host.ts'
  },
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  externals: {
    vscode: 'commonjs vscode',
    // sql.js 会在初始化函数内部暂时把 CommonJS 的 `module` 设为 undefined。
    // 若被 Webpack 包进模块包装器，这会破坏包装器参数并触发
    // “Cannot set properties of undefined (setting 'exports')”。
    // 保留为 Node 运行时依赖，让它在自身 CommonJS 模块作用域中执行。
    'sql.js/dist/sql-wasm.js': 'commonjs sql.js/dist/sql-wasm.js'
  },
  plugins: [new CopySqlJsWasmPlugin()]
};

module.exports = [extensionConfig, webviewConfig];
