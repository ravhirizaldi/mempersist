import { en, type Messages } from "./locales/en";
import { id } from "./locales/id";

export const SUPPORTED_LOCALES = ["en", "id"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "__Host-mempersist_lang";

const catalogs: Record<Locale, Messages> = { en, id };
const MAX_LANGUAGE_HEADER_LENGTH = 1024;
const MAX_COOKIE_HEADER_LENGTH = 4096;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);
}

export function messages(locale: Locale): Messages {
  return catalogs[locale];
}

export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-z]+)\}/g, (match, key: string) => values[key] ?? match);
}

export function localeFromCookie(header: string | null): Locale | null {
  if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
  for (const item of header.split(";")) {
    const [name, ...valueParts] = item.trim().split("=");
    if (name !== LOCALE_COOKIE) continue;
    const value = valueParts.join("=");
    return isLocale(value) ? value : null;
  }
  return null;
}

export function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (!header || header.length > MAX_LANGUAGE_HEADER_LENGTH) return null;
  const preferences: Array<{ locale: Locale; quality: number; index: number }> = [];
  for (const [index, item] of header.split(",").entries()) {
    const [rawTag, ...parameters] = item.trim().split(";");
    const tag = rawTag?.trim().toLowerCase();
    if (!tag || tag === "*") continue;
    let quality = 1;
    const qualityParameter = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    if (qualityParameter) {
      const parsed = Number(qualityParameter.slice(2));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) continue;
      quality = parsed;
    }
    if (quality === 0) continue;
    const base = tag.split("-", 1)[0];
    if (isLocale(base)) preferences.push({ locale: base, quality, index });
  }
  preferences.sort((left, right) => right.quality - left.quality || left.index - right.index);
  return preferences[0]?.locale ?? null;
}

export function resolveLocale(request: Request, explicit?: string | null): Locale {
  if (isLocale(explicit)) return explicit;
  return (
    localeFromCookie(request.headers.get("cookie")) ??
    localeFromAcceptLanguage(request.headers.get("accept-language")) ??
    DEFAULT_LOCALE
  );
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}

export function localeHeaders(locale: Locale): Record<string, string> {
  return {
    "Content-Language": locale,
    Vary: "Accept-Language, Cookie",
  };
}

export function safeReturnPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  try {
    const parsed = new URL(value, "https://mempersist.invalid");
    if (parsed.origin !== "https://mempersist.invalid") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
