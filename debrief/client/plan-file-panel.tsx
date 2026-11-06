/**
 * The "Open with..." panel for a Markdown file: the file's text becomes a plan
 * (refreshed as the file changes on disk) and is reviewed like any other.
 * Feedback goes to the workspace's review agent.
 */
import { type PluginFilePanelProps, useFileText, useRpc } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { openFilePlan } from "../shared/plan";
import { messageOf } from "./format";
import { PlanView } from "./plan-view";

const SYNC_DELAY_MS = 400;

export function PlanFilePanel({ file, workspaceId, theme, layout }: PluginFilePanelProps) {
  const text = useFileText(file);
  const open = useRpc(openFilePlan);
  const [planId, setPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markdown = text.status === "ready" ? text.text : null;

  useEffect(() => {
    if (markdown === null) return;
    let cancelled = false;
    // A burst of saves becomes one new version.
    const timer = setTimeout(() => {
      open({ workspaceId, path: file.path, markdown })
        .then((answer) => {
          if (!cancelled) {
            setPlanId(answer.planId);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(messageOf(cause));
        });
    }, SYNC_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, workspaceId, file.path, markdown]);

  const failure = text.status === "error" ? text.error.message : error;
  if (failure !== null && planId === null) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.statusDanger, padding: 16 }}>{failure}</Text>
      </View>
    );
  }
  if (planId === null) return <Loading />;
  return <PlanView workspaceId={workspaceId} planId={planId} theme={theme} platform={layout.platform} compact={layout.compact} />;
}
