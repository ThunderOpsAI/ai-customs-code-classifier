/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  setupFiles: ['dotenv/config'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};
