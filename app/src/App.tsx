import { useEffect, useRef, useState } from 'preact/hooks';
import type { Facets, Listing } from '../../shared/types';
import { api, type StoreInfo } from './api';
import { EMPTY, type Filters } from './filters';
import { haptic, inTelegram, popBack, startParam, tg } from './tg';
import { Catalog } from './components/Catalog';
import { FilterSheet } from './components/FilterSheet';
import { Detail } from './components/Detail';
import { Subscriptions } from './components/Subscriptions';
import { About } from './components/About';
import { IconBell, IconGrid, IconStore } from './icons';

type Tab = 'catalog' | 'subs' | 'about';
const BOT_USERNAME = 'Raxi_store_bot';
const FILTERS_KEY = 'raxi:filters';
/** через сколько секунд после ухода из приложения перезапрашивать каталог */
const STALE_SEC = 60;

/** ?tab=subs из кнопки бота «Сообщить о поступлении» или startapp=subs */
const initialTab: Tab = (() => {
  const t = new URLSearchParams(location.search).get('tab') ?? startParam;
  return t === 'subs' || t === 'about' ? t : 'catalog';
})();

function loadFilters(): Filters {
  try {
    return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? '{}') };
  } catch {
    return EMPTY;
  }
}

export function App() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [error, setError] = useState(false);
  const [filters, setFiltersRaw] = useState<Filters>(loadFilters);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  // вкладки монтируются при первом заходе — чтобы не грузить их картинки и анимации заранее
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(['catalog', initialTab]));
  const [detailId, setDetailId] = useState<number | null>(() => {
    const m = startParam.match(/^l?_?(\d+)$/) ?? new URLSearchParams(location.search).get('l')?.match(/^(\d+)$/);
    return m ? +m[1] : null;
  });
  const [subPreset, setSubPreset] = useState<{ family: string | null; n: number }>({ family: null, n: 0 });
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const scrollByTab = useRef<Record<Tab, number>>({ catalog: 0, subs: 0, about: 0 });
  const loadedAt = useRef(0);

  const setFilters = (f: Filters) => {
    setFiltersRaw(f);
    try {
      sessionStorage.setItem(FILTERS_KEY, JSON.stringify(f));
    } catch {}
  };

  const toast = (msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 2800);
  };

  const load = () => {
    setError(false);
    return Promise.all([api.listings(), api.facets()])
      .then(([l, f]) => {
        setItems(l);
        setFacets(f);
        loadedAt.current = Date.now();
      })
      .catch(() => setError(true));
  };

  useEffect(() => {
    load();
    api.store().then(setStore).catch(() => {});
    api.event('app_open');
    // вернулись в мини-апп через минуту и больше — тихо обновить каталог (вдруг что-то продали)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > STALE_SEC * 1000) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    if (inTelegram) tg!.onEvent('activated', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // если выбранной модели больше нет в наличии — сбросить чип
  useEffect(() => {
    if (facets && filters.family && !facets.families.some((f) => f.family === filters.family)) setFilters({ ...filters, family: null });
  }, [facets]);

  const goTab = (t: Tab) => {
    if (t === tab) return window.scrollTo({ top: 0, behavior: 'smooth' });
    haptic.select();
    scrollByTab.current[tab] = window.scrollY;
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
    setTab(t);
    requestAnimationFrame(() => window.scrollTo(0, scrollByTab.current[t] ?? 0));
  };

  const openSubscribe = (family: string | null) => {
    setSubPreset((p) => ({ family, n: p.n + 1 }));
    setSheet(false);
    setDetailId(null);
    goTab('subs');
  };

  // «Назад» (Telegram, Esc): верхний слой → лист → карточка → вкладка каталога
  const back = () => {
    if (popBack()) return;
    if (sheet) return setSheet(false);
    if (detailId !== null) return setDetailId(null);
    if (tab !== 'catalog') goTab('catalog');
  };
  const backRef = useRef(back);
  backRef.current = back;
  const canGoBack = sheet || detailId !== null || tab !== 'catalog';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && backRef.current();
    window.addEventListener('keydown', onKey);
    if (!inTelegram || !tg!.isVersionAtLeast('6.1')) return () => window.removeEventListener('keydown', onKey);
    const handler = () => backRef.current();
    tg!.BackButton.onClick(handler);
    return () => {
      window.removeEventListener('keydown', onKey);
      tg!.BackButton.offClick(handler);
    };
  }, []);
  useEffect(() => {
    if (!inTelegram || !tg!.isVersionAtLeast('6.1')) return;
    canGoBack ? tg!.BackButton.show() : tg!.BackButton.hide();
  }, [canGoBack]);
  useEffect(() => {
    document.documentElement.classList.toggle('lock', detailId !== null || sheet);
  }, [detailId, sheet]);

  const preview = detailId !== null ? items?.find((i) => i.id === detailId) ?? null : null;

  return (
    <div class="app">
      <main>
        <div class="tab-pane" hidden={tab !== 'catalog'}>
          <Catalog
            items={items}
            facets={facets}
            filters={filters}
            setFilters={setFilters}
            storeName={store?.name ?? 'RaXi Store'}
            error={error}
            onOpen={(l) => (haptic.tap(), setDetailId(l.id))}
            onOpenFilters={() => setSheet(true)}
            onSubscribe={openSubscribe}
            onRetry={load}
          />
        </div>
        {visited.has('subs') && (
          <div class="tab-pane" hidden={tab !== 'subs'}>
            <Subscriptions preset={subPreset} available={facets?.families.map((f) => f.family) ?? []} toast={toast} />
          </div>
        )}
        {visited.has('about') && (
          <div class="tab-pane" hidden={tab !== 'about'}>
            <About store={store} />
          </div>
        )}
      </main>

      <nav class={`tabbar glass-strong ${detailId !== null ? 'away' : ''}`} aria-label="Разделы">
        {([
          ['catalog', 'Каталог', IconGrid],
          ['subs', 'Подписки', IconBell],
          ['about', 'Магазин', IconStore],
        ] as const).map(([t, label, Icon]) => (
          <button class={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => goTab(t)}>
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <FilterSheet
        open={sheet}
        items={items ?? []}
        facets={facets}
        filters={filters}
        onApply={(f) => (setFilters(f), setSheet(false), window.scrollTo({ top: 0 }))}
        onClose={() => setSheet(false)}
      />

      {detailId !== null && (
        <div class="overlay">
          <Detail
            key={detailId}
            id={detailId}
            preview={preview}
            botUsername={BOT_USERNAME}
            onClose={() => setDetailId(null)}
            onReserved={load}
            toast={toast}
          />
        </div>
      )}

      <div class={`toast glass-strong ${toastMsg ? 'show' : ''}`} role="status" aria-live="polite">
        {toastMsg}
      </div>
    </div>
  );
}
