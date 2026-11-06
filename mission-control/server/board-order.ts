/**
 * `state/board-order.md`: the order the user dragged the board's cards
 * into, for Mission Control. The board keeps the order itself in its display
 * settings, which Mission Control cannot read, so every drag also rewrites
 * this file from `templates/state/board-order.md`. Mission Control only reads
 * it; charter §2 says it is the user's priority.
 */
import type { RpcInput } from "@getpaseo/plugin";

import type { saveBoardOrder } from "../shared/fleet";
import { writeTextFile } from "./files";
import { TEMPLATES, fill, readTemplate } from "./templates";

type Columns = RpcInput<typeof saveBoardOrder>["columns"];

/** The file's sections: `## <column>` and a numbered line per card, `<task id> - <title>` or the worker's. */
export function orderSections(columns: Columns): string {
  return columns
    .filter((column) => column.cards.length > 0)
    .map((column) => {
      const lines = column.cards.map((card, index) => {
        const worker = card.agentId === null ? "" : ` (agent: ${card.agentId}${card.host === null ? "" : `, host: ${card.host}`})`;
        const name = card.taskId === null ? `"${card.title}"` : `${card.taskId} - ${card.title}`;
        return `${index + 1}. ${name}${worker}`;
      });
      return `## ${column.title}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export async function writeBoardOrder(home: string, columns: Columns): Promise<void> {
  const content = fill(await readTemplate(TEMPLATES.boardOrder), { columns: orderSections(columns) });
  await writeTextFile(home, { path: TEMPLATES.boardOrder, content: `${content.trimEnd()}\n`, expectedModifiedMs: null, force: true });
}
