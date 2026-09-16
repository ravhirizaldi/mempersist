declare global {
  interface Env {
    AUTH_EMAIL_FROM: string;
    LEGACY_AUTH_EMAIL_FROM: string;
    MEMORY_API_TOKEN: string;
    TEST_MIGRATIONS: D1Migration[];
  }

  namespace Cloudflare {
    interface Env {
      AUTH_EMAIL_FROM: string;
      LEGACY_AUTH_EMAIL_FROM: string;
      MEMORY_API_TOKEN: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
