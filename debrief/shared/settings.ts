/**
 * Host-scoped preferences the panel reads and writes. The daemon reads
 * `languageServers` through `registerSettings(...).read()` but never writes.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const LANGUAGE_IDS = ["typescript", "go", "python", "rust", "cpp", "lua"] as const;
export const LanguageIdSchema = z.enum(LANGUAGE_IDS);
export type LanguageId = z.infer<typeof LanguageIdSchema>;

export const debriefSettings = defineSettings({
  id: "debrief",
  scope: "host",
  version: 1,
  schema: z.object({
    /** How the reviewer is named on comments. */
    authorName: z.string().trim().max(60).default("Reviewer"),
    layout: z.enum(["unified", "split"]).default("split"),
    hideResolved: z.boolean().default(false),
    /**
     * A command line per language, overriding discovery, e.g.
     * `{ "go": "/opt/homebrew/bin/gopls" }`. Split on whitespace; no shell.
     */
    languageServers: z.record(z.string(), z.string()).default({}),
  }),
});
