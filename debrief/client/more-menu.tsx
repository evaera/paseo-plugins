/**
 * The header's "..." menu: who comments go to. Drawn in the panel's popover.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";

import type { AgentChoice } from "../shared/review";
import { MenuDivider, MenuRow, MenuSection } from "./popover";

export function MoreMenu({
  agents,
  selectedAgent,
  targetAgent,
  showReviewOptions,
  theme,
  onAgent,
}: {
  agents: readonly AgentChoice[];
  /** The review's choice; null is "most recent". */
  selectedAgent: string | null;
  /** Where comments go right now, after the default rule. */
  targetAgent: string | null;
  showReviewOptions: boolean;
  theme: PluginTheme;
  onAgent: (agentId: string | null) => void;
}) {
  const check = (on: boolean) => (on ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null);
  const titleOf = (id: string | null) => agents.find((agent) => agent.id === id)?.title ?? id ?? "none yet";
  return (
    <ScrollView style={{ maxHeight: 460 }}>
      <View style={{ paddingVertical: 4 }}>
        {showReviewOptions ? (
          <>
            <MenuSection theme={theme} title="SEND COMMENTS TO" />
            <MenuRow
              label="Most recent agent"
              detail={targetAgent !== null ? `Now: ${titleOf(targetAgent)}` : "Debrief starts one if the workspace has none"}
              selected={selectedAgent === null}
              theme={theme}
              onPress={() => onAgent(null)}
              trailing={check(selectedAgent === null)}
            />
            {agents.map((agent) => (
              <MenuRow
                key={agent.id}
                label={agent.title}
                detail={`${agent.provider} · ${agent.status}`}
                selected={agent.id === selectedAgent}
                theme={theme}
                onPress={() => onAgent(agent.id)}
                trailing={check(agent.id === selectedAgent)}
              />
            ))}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
