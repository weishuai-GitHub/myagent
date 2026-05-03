// 列出目录文件工具
const fs = require('fs').promises;
const path = require('path');

module.exports = {
  name: 'listFile',
  description: '列出目录下的所有文件',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目录路径'
      }
    },
    required: ['path']
  },
  execute: async function(args, context) {
    const dirPath = args.path;
    
    // 检查路径是否存在
    const exists = await fs.access(dirPath).then(() => true).catch(() => false);
    if (!exists) {
      throw new Error(`目录不存在: ${dirPath}`);
    }

    // 检查是否为目录
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`路径不是目录: ${dirPath}`);
    }

    // 读取目录内容
    const files = await fs.readdir(dirPath);
    
    // 分离文件和目录信息
    const result = await Promise.all(files.map(async (file) => {
      const fullPath = path.join(dirPath, file);
      const fileStats = await fs.stat(fullPath);
      return {
        name: file,
        isFile: fileStats.isFile(),
        path: fullPath
      };
    }));

    // 构建结果对象
    const finalResult = {
      path: dirPath,
      files: result,
      count: result.length
    };

    // 🌟 将结果转换为带有 2 个空格缩进的 JSON 字符串
    return JSON.stringify(finalResult, null, 2);
  }
};