/**
 * Debrief's settings screen: how the reviewer is named, the default diff
 * layout and resolved-thread visibility (a tab can still override both), and
 * a command line per language that overrides language-server discovery.
 * Text fields are drafts saved together, so another client's save in the
 * meantime is a conflict rather than a silent overwrite.
 */
import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text } from "react-native";

import { debriefSettings, LANGUAGE_IDS } from "../shared/settings";

type Ready = Extract<SettingsState<typeof debriefSettings.schema>, { status: "ready" }>;

const LAYOUTS = [
  { label: "Unified", value: "unified" },
  { label: "Split", value: "split" },
] as const;

const LANGUAGE_NAMES: Record<(typeof LANGUAGE_IDS)[number], string> = {
  typescript: "TypeScript and JavaScript",
  go: "Go",
  python: "Python",
  rust: "Rust",
  cpp: "C and C++",
  lua: "Lua",
};

function TextSettings({ settings }: { settings: Ready }) {
  const [author, setAuthor] = useState(settings.values.authorName);
  const [servers, setServers] = useState<Record<string, string>>(settings.values.languageServers);
  const [revision] = useState(settings.revision);
  const dirty =
    author !== settings.values.authorName ||
    LANGUAGE_IDS.some((id) => (servers[id] ?? "") !== (settings.values.languageServers[id] ?? ""));

  const save = () => {
    const languageServers: Record<string, string> = {};
    Object.entries(servers).forEach(([id, command]) => {
      if (command.trim() !== "") languageServers[id] = command.trim();
    });
    void settings.save({ ...settings.values, authorName: author.trim() || "Reviewer", languageServers }, revision);
  };

  return (
    <>
      <SettingsSection title="Reviewer">
        <SettingsCard>
          <SettingsInput
            label="Your name on comments"
            hint="Shown on comments and replies, and to the agent"
            initialValue={settings.values.authorName}
            placeholder="Reviewer"
            onChangeText={setAuthor}
            disabled={settings.saving}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Language servers">
        <SettingsCard>
          {LANGUAGE_IDS.map((id) => (
            <SettingsInput
              key={id}
              label={LANGUAGE_NAMES[id]}
              hint="A command line that replaces discovery, split on spaces (no shell). Empty uses discovery."
              initialValue={settings.values.languageServers[id] ?? ""}
              placeholder={id === "go" ? "/opt/homebrew/bin/gopls" : "discovered automatically"}
              onChangeText={(command) => setServers((current) => ({ ...current, [id]: command }))}
              disabled={settings.saving}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsCard>
        <SettingsAction
          label={dirty ? "Unsaved changes" : "Name and language servers"}
          actionLabel="Save"
          disabled={settings.saving || !dirty}
          error={settings.saveError}
          onPress={save}
        />
      </SettingsCard>
    </>
  );
}

export function DebriefSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(debriefSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings...</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Debrief">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return (
    <>
      <SettingsSection title="Review">
        <SettingsCard>
          <SettingsSelect
            label="Diff layout"
            hint="The default; each Debrief tab can switch on its own"
            value={settings.values.layout}
            options={LAYOUTS}
            disabled={settings.saving}
            onValueChange={(layout) => void settings.save({ ...settings.values, layout }, settings.revision)}
          />
          <SettingsSwitch
            label="Hide resolved threads"
            value={settings.values.hideResolved}
            disabled={settings.saving}
            onValueChange={(hideResolved) => void settings.save({ ...settings.values, hideResolved }, settings.revision)}
          />
        </SettingsCard>
      </SettingsSection>
      {/* Keyed on the revision another client's save moves, so the drafts start from what is stored. */}
      <TextSettings key={settings.revision} settings={settings} />
    </>
  );
}
