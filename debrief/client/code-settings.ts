/**
 * Paseo's code settings (font, size, syntax theme) parsed from what its app
 * stores under "@paseo:app-settings" on web. Pure; `web.ts` reads the storage.
 */
/** Paseo's code settings, as its app stores them on web. */
export interface CodeSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  syntaxTheme: string;
}

export const DEFAULT_MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
export const APP_SETTINGS_KEY = "@paseo:app-settings";

export function codeSettingsFrom(raw: string | null): CodeSettings {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = raw === null ? {} : JSON.parse(raw);
    if (value !== null && typeof value === "object") parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const family = typeof parsed.monoFontFamily === "string" ? parsed.monoFontFamily.trim() : "";
  const size =
    typeof parsed.codeFontSize === "number" && Number.isFinite(parsed.codeFontSize) && parsed.codeFontSize > 0
      ? parsed.codeFontSize
      : 12;
  const syntax = typeof parsed.syntaxTheme === "string" && parsed.syntaxTheme !== "" ? parsed.syntaxTheme : "one";
  return {
    fontFamily: family === "" ? DEFAULT_MONO_STACK : `${family}, ${DEFAULT_MONO_STACK}`,
    fontSize: size,
    lineHeight: Math.round(size * 1.5),
    syntaxTheme: syntax,
  };
}

