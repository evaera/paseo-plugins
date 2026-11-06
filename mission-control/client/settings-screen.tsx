/**
 * Settings › Plugins › Mission Control.
 *
 * Two stores behind one screen, split on which side reads the value: the
 * home, Mission Control's id and the crew's model are the daemon's (its
 * handlers and the charter act on them), so they go through
 * `mission-control.config.*`; the refresh interval only draws the board, so it is a
 * host settings document the app reads itself.
 */
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ScrollView, Text } from "react-native";

import { enableAgentTools, readConfig, releaseCoordinator, writeConfig, type MissionControlConfig } from "../shared/fleet";
import { POLL_SECONDS, displaySettings } from "../shared/settings";
import { FLEET_QUERY_KEY, useFleet } from "./fleet";
import { agentStatusLabel, modelLabel } from "./format";
import { useModeOptions, useModelOptions, withCurrent } from "./models";
import { OptionPicker } from "./option-picker";
import { errorText } from "./ui";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

const CONFIG_QUERY_KEY = ["mission-control", "config"] as const;
const PROVIDER_DEFAULT = "";

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const read = useRpc(readConfig);
  const write = useRpc(writeConfig);
  const release = useRpc(releaseCoordinator);
  const enable = useRpc(enableAgentTools);
  const toast = useToast();
  const queryClient = useQueryClient();
  const display = useSettings(displaySettings);
  const fleet = useFleet(display.status === "ready" ? display.values.pollSeconds : 5);

  const config = useQuery({ queryKey: CONFIG_QUERY_KEY, queryFn: () => read({}) });
  const current = config.data?.config ?? null;
  const [homeDraft, setHomeDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const models = useModelOptions();
  const crewModes = useModeOptions(current?.crewProvider ?? "");
  const crewModeOptions = useMemo(
    () => [{ label: "Provider default", value: PROVIDER_DEFAULT }, ...crewModes],
    [crewModes],
  );
  const crewModelOptions = useMemo(
    () => [
      { label: "Let Mission Control choose", value: "", detail: "its own model, unless a task needs another" },
      ...withCurrent(models.options, current?.crewProvider ?? ""),
    ],
    [models.options, current],
  );

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 20, gap: 16 },
      note: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small, lineHeight: lineHeightFor(FONT_SIZE.small) },
      value: { color: theme.colors.foreground, fontSize: FONT_SIZE.body },
    }),
    [theme, layout.compact],
  );

  function refreshAll(): void {
    void queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: FLEET_QUERY_KEY });
  }

  function apply(patch: Partial<MissionControlConfig>, message: string): void {
    setBusy(true);
    write(patch)
      .then((result) => {
        queryClient.setQueryData(CONFIG_QUERY_KEY, result);
        void queryClient.invalidateQueries({ queryKey: FLEET_QUERY_KEY });
        toast.show(message, { variant: "success" });
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setBusy(false));
  }

  const coordinator = fleet.data?.coordinator ?? null;
  const tools = fleet.data?.agentTools ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} automaticallyAdjustKeyboardInsets>
      <SettingsGroup title="Mission Control">
        <SettingsSection title="Running">
          <SettingsRow
            label="Mission Control"
            hint={coordinator === null ? "None yet. Launch one from the Mission Control board." : `${modelLabel(coordinator)} · ${agentStatusLabel(coordinator)}`}
          >
            <Text style={styles.value} numberOfLines={1}>
              {coordinator === null ? "—" : (coordinator.title ?? coordinator.id)}
            </Text>
          </SettingsRow>
          <SettingsAction
            label="Release it"
            hint="Forgets which agent is Mission Control, so another can be launched or adopted. The agent itself keeps running."
            actionLabel="Release"
            disabled={busy || current?.coordinatorAgentId === ""}
            onPress={() => {
              setBusy(true);
              release({})
                .then(() => {
                  refreshAll();
                  toast.show("Released. The agent is still running.", { variant: "success" });
                })
                .catch((caught: unknown) => toast.error(errorText(caught)))
                .finally(() => setBusy(false));
            }}
          />
        </SettingsSection>
        <SettingsSection
          title="Home"
          info={
            <Text style={styles.note}>
              The directory Mission Control runs in and the only one it writes to: its charter (AGENTS.md, rewritten on
              every launch), its standing orders (prompts/user.md — yours to edit), the project registry and the
              backlog. It can only be moved while no Mission Control agent is running — release it first.
            </Text>
          }
        >
          {current === null ? null : (
            <SettingsInput
              key={current.home}
              label="Home directory"
              hint={`Empty means ${config.data?.resolvedHome ?? "the plugin's own directory"}.`}
              initialValue={current.home}
              placeholder={config.data?.resolvedHome ?? ""}
              onChangeText={setHomeDraft}
              disabled={busy || current.coordinatorAgentId !== ""}
            />
          )}
          <SettingsAction
            label="Save the home"
            actionLabel="Save"
            disabled={
              busy || current?.coordinatorAgentId !== "" || homeDraft === null || homeDraft.trim() === (current?.home ?? "")
            }
            onPress={() => {
              if (homeDraft === null) return;
              apply({ home: homeDraft.trim() }, "Home saved.");
              setHomeDraft(null);
            }}
          />
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup title="The crew">
        <SettingsSection
          title="Workers"
          info={
            <Text style={styles.note}>
              Written into Mission Control's charter, so it gives every worker this model, mode and speed unless you tell it
              otherwise for a task. A running Mission Control reads the change the next time it rereads its charter.
            </Text>
          }
        >
          <OptionPicker
            label="Model"
            title="The crew's model"
            value={current?.crewProvider ?? ""}
            options={crewModelOptions}
            searchPlaceholder={models.loading ? "Loading models…" : "Search models"}
            disabled={busy || current === null}
            onSelect={(value) => apply({ crewProvider: value, crewModeId: "" }, "The crew's model is saved.")}
            theme={theme}
            compact={layout.compact}
          />
          <SettingsSelect
            label="Mode"
            hint="The workers' permission mode. A mode that asks before each tool means Mission Control answers a lot of permission requests."
            value={
              crewModeOptions.some((option) => option.value === current?.crewModeId)
                ? (current?.crewModeId ?? PROVIDER_DEFAULT)
                : PROVIDER_DEFAULT
            }
            options={crewModeOptions}
            disabled={busy || current === null || current.crewProvider === ""}
            onValueChange={(value) => apply({ crewModeId: value }, "The crew's mode is saved.")}
          />
          <SettingsSwitch
            label="Fast mode"
            hint="Workers start with the provider's fast mode on, where their model has one (Claude Opus does): lower latency at a higher token cost."
            value={current?.crewFastMode ?? false}
            disabled={busy || current === null}
            onValueChange={(value) =>
              apply({ crewFastMode: value }, value ? "The crew starts in fast mode." : "The crew starts without fast mode.")
            }
          />
        </SettingsSection>
      </SettingsGroup>

      <SettingsGroup title="Paseo">
        <SettingsSection title="Agent tools">
          <SettingsAction
            label={tools === true ? "On" : tools === false ? "Off" : "Unknown"}
            hint="Mission Control starts its workers and hears back from them through Paseo's agent tools (mcp.injectIntoAgents in the daemon's config). Only sessions started afterwards get them."
            actionLabel="Turn on"
            disabled={busy || tools === true}
            onPress={() => {
              setBusy(true);
              enable({})
                .then(() => {
                  refreshAll();
                  toast.show("Agent tools are on.", { variant: "success" });
                })
                .catch((caught: unknown) => toast.error(errorText(caught)))
                .finally(() => setBusy(false));
            }}
          />
        </SettingsSection>
        <SettingsSection title="Board">
          <SettingsSelect
            label="Refresh every"
            value={String(display.status === "ready" ? display.values.pollSeconds : 5)}
            options={POLL_SECONDS.map((seconds) => ({ label: `${seconds} seconds`, value: String(seconds) }))}
            disabled={display.status !== "ready"}
            onValueChange={(value) => {
              if (display.status !== "ready") return;
              void display.save({ ...display.values, pollSeconds: Number(value) }, display.revision).then((ok) => {
                if (!ok) toast.error(display.saveError ?? "The interval was not saved.");
              });
            }}
          />
        </SettingsSection>
      </SettingsGroup>
    </ScrollView>
  );
}
