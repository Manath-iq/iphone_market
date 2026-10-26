// Создаётся scripts/render-cards.ts — не править руками
export const CARD_VERSIONS = {
  "moderator": "7a006dd7",
  "paid": "690e2dc6",
  "seller": "8428ef77",
  "welcome": "8be047e1"
} as const;

export type CardName = keyof typeof CARD_VERSIONS;
