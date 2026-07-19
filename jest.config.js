module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts'
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 50,
      functions: 70,
      lines: 70
    }
  },
  moduleNameMapper: {
    '^vscode$': '<rootDir>/test/mocks/vscode.ts',
    '\\.css$': '<rootDir>/test/mocks/vscode.ts'
  },
  transform: {
    '^.+.*\\.tsx?$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-jsx',
        types: ['node', 'jest', '@testing-library/jest-dom']
      }
    }]
  },
  setupFilesAfterEnv: ['<rootDir>/test/setupTests.ts']
};
