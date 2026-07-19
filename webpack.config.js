const path = require('path');

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
    vscode: 'commonjs vscode'
  }
};

module.exports = [extensionConfig, webviewConfig];
