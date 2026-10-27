import type { BotCommand } from 'grammy/types';
import type { Env } from './env';
import { api } from './notify';
import { getSeller, isMod, isOwner } from './roles';

/**
 * Меню команд (кнопка «/» в Telegram) по роли человека. Всем — только /start (общее меню ставит scripts/setup-bot.ts),
 * продавцу, модератору и владельцу — их команды. Меню ставится на конкретный чат, поэтому его
 * обновляем, когда роль меняется: приглашение принято, человека отключили или включили, он нажал /start.
 */

const START: BotCommand[] = [
  { command: 'start', description: 'Открыть каталог' },
  { command: 'oferta', description: 'Условия и оферта' },
];

const SELLER: BotCommand[] = [
  { command: 'template', description: 'Шаблон объявления' },
  { command: 'my', description: 'Мои товары' },
];

const STAFF: BotCommand[] = [
  { command: 'help', description: 'Все команды' },
  { command: 'list', description: 'Что сейчас в каталоге' },
  { command: 'stats', description: 'Статистика за 7 дней' },
  { command: 'sold', description: 'Снять как проданный: /sold 12' },
  { command: 'hide', description: 'Скрыть: /hide 12' },
  { command: 'show', description: 'Вернуть в каталог: /show 12' },
  { command: 'unreserve', description: 'Снять бронь: /unreserve 12' },
];

const OWNER: BotCommand[] = [
  { command: 'invite', description: 'Ссылка для продавца' },
  { command: 'invite_mod', description: 'Ссылка для модератора' },
  { command: 'invite_admin', description: 'Ссылка для владельца' },
  { command: 'sellers', description: 'Продавцы' },
  { command: 'mods', description: 'Модераторы и владельцы' },
  { command: 'fee', description: 'Комиссия площадки' },
  { command: 'fee_mode', description: 'Комиссия к постам владельца' },
  { command: 'channel', description: 'Канал публикации' },
];

export async function commandsFor(env: Env, userId: number): Promise<BotCommand[] | null> {
  const owner = await isOwner(env, userId);
  const [mod, seller] = await Promise.all([owner ? false : isMod(env, userId), getSeller(env, userId)]);
  const isSeller = seller?.status === 'active';
  if (!owner && !mod && !isSeller) return null;
  return [...START, ...(isSeller ? SELLER : []), ...(owner || mod ? STAFF : []), ...(owner ? OWNER : [])];
}

/**
 * Поставить человеку меню его роли. Без роли — вернуть общее меню, если reset (роль только что сняли);
 * на обычный /start покупателя запрос в Telegram не тратим. Ошибки Telegram не мешают основному действию.
 */
export async function syncCommands(env: Env, userId: number, reset = true) {
  try {
    const commands = await commandsFor(env, userId);
    const scope = { type: 'chat' as const, chat_id: userId };
    if (commands) await api(env).setMyCommands(commands, { scope });
    else if (reset) await api(env).deleteMyCommands({ scope });
  } catch (e) {
    console.warn('syncCommands failed', userId, String(e));
  }
}
