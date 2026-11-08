/**
 * Mission Control's home as files: listed, read and written from the panel.
 *
 * Paths are relative to the home, `/`-separated, with `""` for the home
 * itself. The daemon refuses anything that resolves outside it — `..`, an
 * absolute path, a symlink pointing elsewhere — so the panel can only ever
 * reach what Mission Control can write.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Larger files are listed but not opened: the editor is a text box, and the RPC carries the whole file. */
export const MAX_EDITABLE_BYTES = 1024 * 1024;

export const HomeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["dir", "file"]),
  size: z.number(),
  modifiedMs: z.number(),
});
export type HomeEntry = z.infer<typeof HomeEntrySchema>;

export const listHomeFiles = defineRpc({
  name: "mission-control.files.list",
  input: z.object({ path: z.string().default("") }),
  output: z.object({ home: z.string(), path: z.string(), entries: z.array(HomeEntrySchema) }),
});

export const readHomeFile = defineRpc({
  name: "mission-control.files.read",
  input: z.object({ path: z.string().min(1) }),
  output: z.object({
    path: z.string(),
    /** Null for a binary file or one over `MAX_EDITABLE_BYTES`; the flags say which. */
    content: z.string().nullable(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
    size: z.number(),
    modifiedMs: z.number(),
  }),
});

/**
 * Saves a file. `expectedModifiedMs` is the modification time the editor
 * opened it at: a file changed since — Mission Control writes these files too
 * — is refused unless `force`, so neither side silently loses the other's
 * edit. `null` creates a new file, and refuses one that already exists.
 */
export const writeHomeFile = defineRpc({
  name: "mission-control.files.write",
  input: z.object({
    path: z.string().min(1),
    content: z.string().max(MAX_EDITABLE_BYTES),
    expectedModifiedMs: z.number().nullable(),
    force: z.boolean().default(false),
  }),
  output: z.object({ path: z.string(), size: z.number(), modifiedMs: z.number() }),
});

/** How many paths one `mission-control.files.find` call checks; a longer conversation links its latest mentions. */
export const MAX_FILE_CANDIDATES = 500;

/** The longest path `mission-control.files.find` takes; the chat does not ask about a longer word. */
export const MAX_FILE_PATH_LENGTH = 1024;

/**
 * Which of the paths the chat mentions are files, for linking them. A candidate is relative to the
 * home, or absolute (either slash, or a `file:` URL decoded by `localPathOf`). `files` maps each one
 * that is an existing file in the home to its home-relative path, the one the Files view opens;
 * `projectFiles` maps each existing file inside a registered Paseo project's root, and not in the
 * home, to its absolute path. Everything else is left out: outside every root, lexically or through
 * a symlink, missing, or a folder.
 */
export const findHomeFiles = defineRpc({
  name: "mission-control.files.find",
  input: z.object({ paths: z.array(z.string().max(MAX_FILE_PATH_LENGTH)).max(MAX_FILE_CANDIDATES) }),
  output: z.object({ files: z.record(z.string(), z.string()), projectFiles: z.record(z.string(), z.string()) }),
});

/**
 * The largest image the chat is sent. The bytes travel base64 in one RPC answer and are decoded at
 * full size, so this is what keeps a conversation of screenshots from stalling; a 1920x1080 PNG is
 * one to three megabytes.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Why an image is not shown, each with its own placeholder. */
export const ImageRefusalSchema = z.enum(["missing", "outside", "too-large", "unsupported", "not-a-file"]);
export type ImageRefusal = z.infer<typeof ImageRefusalSchema>;

/**
 * A local image for a Markdown `![alt](src)`, through the same roots as `mission-control.files.find`:
 * the home (relative or absolute) and registered project roots, never anywhere else. The type comes
 * from the file's bytes, not its name; width and height are read from its header, null when it does
 * not say.
 */
export const readImage = defineRpc({
  name: "mission-control.files.image",
  input: z.object({ src: z.string().min(1).max(MAX_FILE_PATH_LENGTH) }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      mimeType: z.string(),
      base64: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      size: z.number(),
    }),
    z.object({ status: z.literal("refused"), reason: ImageRefusalSchema, size: z.number().nullable() }),
  ]),
});

/**
 * Shows a file in the daemon machine's file manager, selected: a project file a reply links, which
 * the Files view (the home only) cannot open and the plugin API gives no way to open in Paseo's own
 * file panel. Refused outside the home and the registered project roots.
 */
export const revealFile = defineRpc({
  name: "mission-control.files.reveal",
  input: z.object({ path: z.string().min(1).max(MAX_FILE_PATH_LENGTH) }),
  output: z.object({}),
});
