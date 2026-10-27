import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from 'grammy/types';
import type { Env } from '../src/env';
import { otherParsed } from '../src/bot-seller';
import { getListing } from '../src/db';
import { publishSubmission } from '../src/publish';
import { addPart, addPartTo, clearMedia, createWizard, getSubmission, getSubmissionMedia, moveStatus, saveParsed, setWizardFields } from '../src/submissions';
import { testEnv } from './d1';

// публикация шлёт альбом в Telegram — подменяем ответом, как его вернул бы sendMediaGroup
const sent: { caption: string }[] = [];
vi.mock('../src/notify', async (orig) => ({
  ...(await orig<typeof import('../src/notify')>()),
  sendAlbum: async (_env: Env, chatId: string, media: { file_id: string }[], caption: string) => {
    sent.push({ caption });
    const chat = { id: -100500, type: 'channel', title: 'RaXi', username: 'apple_raxi' };
    return media.map((m, i) => ({ message_id: 900 + i, chat, media_group_id: 'g1', photo: [{ file_id: m.file_id, width: 10, height: 10 }] })) as unknown as Message[];
  },
}));

const SELLER = 55;
const photo = (n: number) => ({ msg_id: n, kind: 'photo' as const, file_id: `file${n}` });

describe('мастер «другой товар»', () => {
  let env: Env;
  beforeEach(() => {
    env = testEnv();
    sent.length = 0;
  });

  it('фото альбома и опоздавшие части ложатся в заявку мастера', async () => {
    const sub = await createWizard(env, SELLER);
    await setWizardFields(env, sub.id, { title: 'AirPods Pro 2' });
    await setWizardFields(env, sub.id, { seller_price_rub: 15000 });
    await addPartTo(env, sub.id, 'g77', photo(1), 'Описание из подписи\nвторая строка');
    // часть пришла, когда бот уже не ждал фото: находит заявку по ключу альбома
    const late = await addPart(env, SELLER, 'g77', photo(2), null);
    expect(late.id).toBe(sub.id);
    const s = (await getSubmission(env, sub.id))!;
    expect(s).toMatchObject({ category: 'other', title: 'AirPods Pro 2', seller_price_rub: 15000, description: 'Описание из подписи\nвторая строка' });
    expect((await getSubmissionMedia(env, sub.id)).map((m) => m.file_id)).toEqual(['file1', 'file2']);
  });

  it('новый мастер отменяет брошенный; «Исправить фото» убирает старые', async () => {
    const old = await createWizard(env, SELLER);
    const sub = await createWizard(env, SELLER);
    expect((await getSubmission(env, old.id))!.status).toBe('cancelled');
    await addPartTo(env, sub.id, 'g1', photo(1), null);
    await clearMedia(env, sub.id);
    expect(await getSubmissionMedia(env, sub.id)).toEqual([]);
    // новый альбом снова отдаёт заявке свой ключ
    await addPartTo(env, sub.id, 'g2', photo(2), null);
    expect((await addPart(env, SELLER, 'g2', photo(3), null)).id).toBe(sub.id);
  });

  it('правка поля сбрасывает разбор: на проверку — только после нового превью', async () => {
    const sub = await createWizard(env, SELLER);
    await saveParsed(env, sub.id, otherParsed('Чехол', 500));
    await setWizardFields(env, sub.id, { title: 'Чехол MagSafe' });
    expect((await getSubmission(env, sub.id))!.parsed).toBeNull();
  });

  it('публикация: карточка other с описанием без контактов, пост в формате другого товара', async () => {
    const sub = await createWizard(env, SELLER);
    await setWizardFields(env, sub.id, { title: 'AirPods Pro 2', seller_price_rub: 15000, description: 'Как новые\n\nПишите @seller_nick' });
    await addPartTo(env, sub.id, 'g9', photo(1), null);
    await addPartTo(env, sub.id, 'g9', photo(2), null);
    await saveParsed(env, sub.id, otherParsed('AirPods Pro 2', 15000));
    const pending = (await moveStatus(env, sub.id, ['draft'], 'publishing'))!;
    const l = await publishSubmission(env, pending, 1);
    expect(l).toMatchObject({ category: 'other', model_raw: 'AirPods Pro 2', family: null, description: 'Как новые\n\nПишите', status: 'active' });
    expect(sent[0].caption).toMatch(/^📦 AirPods Pro 2\n#АКТУАЛЬНО_RaXi\nЛОТ №\d+\n\nКак новые\n\nПишите\n\n💰 16 000 ₽/);
    const api = await getListing(env, l.id);
    expect(api).toMatchObject({ category: 'other', description: 'Как новые\n\nПишите' });
    expect(api!.media).toHaveLength(2);
    expect(JSON.stringify(api)).not.toContain('seller_nick');
  });
});
