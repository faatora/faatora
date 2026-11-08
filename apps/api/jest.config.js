module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup.ts'],
  // `@faatora/compliance` ships ESM in its `dist/`. Point jest at the TS
  // source so ts-jest handles it under CJS like the rest of the codebase.
  // The compliance package uses NodeNext relative imports with explicit
  // `.js` suffixes; the second mapper strips those so ts-jest can resolve
  // them to the matching `.ts` under `src/`.
  moduleNameMapper: {
    '^@faatora/compliance$': '<rootDir>/../../packages/compliance/src/index.ts',
    '^@faatora/compliance/(.*)$': '<rootDir>/../../packages/compliance/src/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
