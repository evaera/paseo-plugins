/**
 * Which of the paths a conversation's Markdown names are files, the daemon's say, since only it
 * can see the disk: in the home (opened in Files) or in a registered project (shown in the file
 * manager). Asked once for the whole conversation, the most recently mentioned kept past the cap,
 * and again every 30 seconds, so a file named before it was written becomes a link. Until the answer
 * arrives, and if it fails, the paths are text.
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { MAX_FILE_CANDIDATES, findHomeFiles } from "../shared/files";
import { lookupIn, recentCandidates, type FileLookup, type InlineOptions } from "./file-links";

export function useFileLinks(messages: readonly string[], options: InlineOptions = {}, enabled = true): FileLookup {
  const find = useRpc(findHomeFiles);
  const baseDir = options.baseDir;
  const candidates = useMemo(
    () => (enabled ? recentCandidates(messages, MAX_FILE_CANDIDATES, baseDir === undefined ? {} : { baseDir }) : []),
    [messages, baseDir, enabled],
  );
  const found = useQuery({
    queryKey: ["mission-control", "files", "find", candidates],
    queryFn: () => find({ paths: candidates }),
    enabled: candidates.length > 0,
    refetchInterval: 30_000,
    // A new mention asks again; the links already drawn stay while it does.
    placeholderData: (previous) => previous,
  });
  const files = found.data?.files;
  const projectFiles = found.data?.projectFiles;
  return useMemo(() => lookupIn(files ?? {}, projectFiles ?? {}), [files, projectFiles]);
}
