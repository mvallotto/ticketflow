import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    env: {
      DATABASE_URL:
        'postgresql://ticketflow:ticketflow@localhost:5433/ticketflow_test',
    },
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
    ],
  },
});