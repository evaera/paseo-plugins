import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";

import { activateToolbarAction, toolbarIcon, type ToolbarAction, type ToolbarItem, type ToolbarMenu } from "../shared/toolbar";
import { FONT_SIZE } from "./type-scale";
import { errorText } from "./ui";

type Anchor = { x: number; y: number; width: number; height: number };

export function ToolbarControls({ items, theme, touch, workspaceId, openWorkspace }: {
  items: readonly ToolbarItem[];
  theme: PluginTheme;
  touch: boolean;
  workspaceId: string | null;
  openWorkspace?: ((workspaceId: string) => void) | undefined;
}) {
  const invoke = useRpc(activateToolbarAction);
  const toast = useToast();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [popup, setPopup] = useState<{ anchor: Anchor; trail: ToolbarMenu[] } | null>(null);
  const { width, height } = useWindowDimensions();
  const { colors } = theme;

  function activate(action: ToolbarAction): void {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setPopup(null);
    void invoke({ action, workspaceId, placement: "missionControl" }).then(({ workspaceId }) => {
      if (workspaceId !== null) openWorkspace?.(workspaceId);
      else toast.show(action.type === "prompt" ? "Sent to Mission Control" : `Started ${action.label}`, { variant: "success" });
    }).catch((error: unknown) => toast.error(errorText(error))).finally(() => {
      running.current = false;
      setBusy(false);
    });
  }

  function renderItems(list: readonly ToolbarItem[], inMenu = false, grouped = false): ReactNode[] {
    return list.map((item, index) => item.type === "group" ? (
      <View key={index} style={{
        flexDirection: inMenu ? "column" : "row",
        borderRadius: 9,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        padding: 2,
        gap: 1,
      }}>
        {renderItems(item.items, inMenu, true)}
      </View>
    ) : (
      <ToolbarButton
        key={index}
        item={item}
        theme={theme}
        menuRow={inMenu}
        grouped={grouped}
        touch={touch}
        disabled={busy}
        onPress={(anchor) => {
          if (item.type !== "menu") { activate(item); return; }
          if (inMenu && popup !== null) setPopup({ ...popup, trail: [...popup.trail, item] });
          else if (anchor !== null) setPopup({ anchor, trail: [item] });
        }}
      />
    ));
  }

  const menu = popup?.trail.at(-1);
  const menuWidth = Math.min(Math.max(240, popup?.anchor.width ?? 0), Math.max(0, width - 16));
  const below = (popup?.anchor.y ?? 0) + (popup?.anchor.height ?? 0) + 4;
  const above = (popup?.anchor.y ?? 0) - 4;
  const openBelow = height - below >= Math.min(200, above);
  const placement = openBelow ? { top: Math.max(8, below) } : { bottom: Math.max(8, height - above) };

  return (
    <>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
        contentContainerStyle={{ alignItems: "center", gap: 6 }}
      >
        {renderItems(items)}
      </ScrollView>
      {popup === null || menu === undefined ? null : (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPopup(null)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close toolbar menu"
            onPress={() => setPopup(null)}
            style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
          />
          <ScrollView
            accessibilityRole="menu"
            accessibilityLabel={menu.label}
            keyboardShouldPersistTaps="handled"
            style={{
              position: "absolute",
              left: Math.max(8, Math.min(popup.anchor.x, width - menuWidth - 8)),
              ...placement,
              width: menuWidth,
              maxHeight: Math.max(80, (openBelow ? height - below : above) - 8),
              backgroundColor: colors.surface1,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
              elevation: 8,
            }}
            contentContainerStyle={{ padding: 4, gap: 3 }}
          >
            {popup.trail.length > 1 ? (
              <ToolbarButton
                item={{ type: "menu", label: "Back", icon: "ChevronLeft", items: [] }}
                theme={theme}
                menuRow
                touch={touch}
                back
                onPress={() => setPopup({ ...popup, trail: popup.trail.slice(0, -1) })}
              />
            ) : null}
            {renderItems(menu.items, true)}
          </ScrollView>
        </Modal>
      )}
    </>
  );
}

function ToolbarButton({ item, theme, touch, grouped = false, menuRow = false, back = false, disabled, onPress }: {
  item: Exclude<ToolbarItem, { type: "group" }>;
  theme: PluginTheme;
  touch: boolean;
  grouped?: boolean;
  menuRow?: boolean;
  back?: boolean;
  disabled?: boolean;
  onPress: (anchor: Anchor | null) => void;
}) {
  const anchor = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  const { colors } = theme;
  const menu = item.type === "menu" && !back;
  return (
    <View ref={anchor} collapsable={false}>
      <Pressable
        accessibilityRole={menuRow ? "menuitem" : "button"}
        accessibilityLabel={item.label}
        accessibilityState={{ disabled: disabled === true }}
        disabled={disabled === true}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          if (menu && !menuRow) {
            anchor.current?.measureInWindow((x, y, width, height) => onPress({ x, y, width, height }));
          } else onPress(null);
        }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          minHeight: touch ? 44 : menuRow ? 34 : grouped ? 24 : 28,
          paddingHorizontal: 8,
          gap: 6,
          borderRadius: 7,
          borderWidth: menuRow || grouped ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: hovered || pressed ? colors.surface2 : colors.surface1,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        })}
      >
        <Icon name={toolbarIcon(item)} color={colors.foreground} size={14} />
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: FONT_SIZE.small, fontWeight: "500", flex: menuRow ? 1 : undefined, maxWidth: menuRow ? undefined : 160 }}>
          {item.label}
        </Text>
        {menu ? <Icon name={menuRow ? "ChevronRight" : "ChevronDown"} color={colors.foregroundMuted} size={13} /> : null}
      </Pressable>
    </View>
  );
}
