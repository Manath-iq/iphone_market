/** Адрес воркера — для ссылок там, где нет входящего запроса (cron, картинки к сообщениям). DEMO: у заказчика свой */
export const PUBLIC_ORIGIN = 'https://raxi-catalog.todominate-ai.workers.dev';

/**
 * Настройки магазина. Всё, что помечено DEMO-ЗАГЛУШКА, заменить текстами продавца перед запуском.
 */
export const STORE = {
  name: 'RaXi Store',
  /** публичный канал, откуда идёт импорт и cron-проверка удалений */
  channel: 'apple_raxi',
  /** ник, который получает покупатель после оплаты постов владельца. DEMO: разработчик; у заказчика — 'Raxi_Apple' */
  sellerUsername: 'manath',
  reviewsChannel: 'otzv_RaXiStore',
  /** DEMO-ЗАГЛУШКА */
  about: {
    city: 'Москва',
    delivery: 'Встреча в городе или доставка СДЭК по России',
    warranty: 'Гарантия магазина 14 дней на все устройства',
    payment: 'Наличные, перевод, рассрочка по договорённости',
    demo: true,
  },
};
