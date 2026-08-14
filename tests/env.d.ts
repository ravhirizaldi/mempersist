declare global {
  interface Env {
    MEMORY_API_TOKEN: string;
    TEST_MIGRATIONS: D1Migration[];
  }

  namespace Cloudflare {
    interface Env {
      MEMORY_API_TOKEN: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
