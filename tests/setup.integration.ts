import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(async () => {
  // Miniflare injects the serialized migration list under this test-only binding.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  await applyD1Migrations(env.MEMORY_DB, env.TEST_MIGRATIONS);
});
