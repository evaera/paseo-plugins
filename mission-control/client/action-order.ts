import type { FleetCard } from "../shared/fleet";

export interface QueueProgress {
  deferred: readonly string[];
  answered: readonly string[];
}

export function isActionCard(card: FleetCard): boolean {
  return card.column === "review" || card.column === "blocked";
}

export function actionRevision(card: FleetCard): string {
  return card.actionRevision ?? JSON.stringify([
    card.taskId ?? card.key, card.agent?.id, card.agent?.serverId, card.column,
    card.report, card.backlog?.hold, card.backlog?.review, card.backlog?.actions,
    card.agent?.pendingPermissions, card.links,
  ]);
}

export function queueCards(cards: readonly FleetCard[], progress: QueueProgress): FleetCard[] {
  const answered = new Set(progress.answered);
  const deferred = new Map(progress.deferred.map((revision, index) => [revision, index]));
  return cards.filter(isActionCard).map((card) => ({
    card, revision: actionRevision(card),
  })).filter(({ revision }) => !answered.has(revision)).sort((a, b) => {
    const aDeferred = deferred.get(a.revision);
    const bDeferred = deferred.get(b.revision);
    if (aDeferred !== undefined || bDeferred !== undefined) {
      return (aDeferred ?? -1) - (bDeferred ?? -1);
    }
    const priority = (b.card.backlog?.priority ?? 0) - (a.card.backlog?.priority ?? 0);
    return priority || Number(b.card.column === "blocked") - Number(a.card.column === "blocked");
  }).map(({ card }) => card);
}
