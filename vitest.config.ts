import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**', '.git/**'],
    env: {
      // Isolate unit tests from any live Letta server connection.
      // Without this, tests that instantiate LettaBot pick up the real
      // LETTA_BASE_URL / LETTA_API_KEY from the environment and make
      // unintended API calls (error enrichment, approval recovery, etc.)
      // that can hang or interfere with the running LC session.
      LETTA_BASE_URL: '',
      LETTA_API_KEY: '',
    },
  },
});

