import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createSale,
  listProducts,
  lookupByBarcode,
  PosApiError,
  type CreateSaleInput,
  type Product,
  type Sale,
  type TenderMethod,
} from './api';
import { ReceiptView } from './ReceiptView';

interface CartLine {
  key: string; // product id or free-text key
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatCategory: string;
  vatRate: number;
}

const PENDING_KEY = 'faatora_pos_pending';
const FLUSH_INTERVAL_MS = 15_000;

function money(n: number): string {
  return n.toFixed(3);
}

function readQueue(): CreateSaleInput[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CreateSaleInput[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: CreateSaleInput[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(items));
  } catch {
    // storage unavailable (private mode etc.) — queue degrades to in-memory only
  }
}

function computeTotals(lines: CartLine[]): { subtotal: number; vat: number; grand: number } {
  const SCALE = 1000;
  const round = (n: number) => Math.round(n);
  const lineNetsMinor = lines.map((l) => round(l.quantity * round(l.unitPrice * SCALE)));
  const groups = new Map<string, { rate: number; taxable: number }>();
  lines.forEach((l, i) => {
    const key = `${l.vatCategory}|${l.vatRate}`;
    const g = groups.get(key) ?? { rate: l.vatRate, taxable: 0 };
    g.taxable += lineNetsMinor[i];
    groups.set(key, g);
  });
  let subtotal = 0;
  let vat = 0;
  for (const g of groups.values()) {
    const tax = round((g.taxable * g.rate) / 100);
    subtotal += g.taxable;
    vat += tax;
  }
  return { subtotal: subtotal / SCALE, vat: vat / SCALE, grand: (subtotal + vat) / SCALE };
}

export function PosPage() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').split('-')[0];

  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tenderMethod, setTenderMethod] = useState<TenderMethod>('cash');
  const [tendered, setTendered] = useState<string>('');
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCount, setPendingCount] = useState(() => readQueue().length);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // --- product catalog -----------------------------------------------------
  useEffect(() => {
    let active = true;
    void listProducts()
      .then((p) => {
        if (active) setProducts(p);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setProductsError(err instanceof Error ? err.message : 'load failed');
      });
    return () => {
      active = false;
    };
  }, []);

  const totals = useMemo(() => computeTotals(cart), [cart]);

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = products.filter((p) => !p.archived);
    if (!q) return visible;
    return visible.filter(
      (p) =>
        p.nameEn.toLowerCase().includes(q) ||
        (p.nameAr ?? '').toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q),
    );
  }, [products, query]);

  const addProduct = useCallback(
    (p: Product) => {
      setCart((prev) => {
        const existing = prev.find((l) => l.productId === p.id);
        if (existing) {
          return prev.map((l) => (l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l));
        }
        return [
          ...prev,
          {
            key: p.id,
            productId: p.id,
            description: lang === 'ar' && p.nameAr ? p.nameAr : p.nameEn,
            quantity: 1,
            unitPrice: Number(p.unitPrice),
            vatCategory: p.vatCategory,
            vatRate: Number(p.vatRate),
          },
        ];
      });
    },
    [lang],
  );

  const changeQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const removeLine = (key: string) => {
    setCart((prev) => prev.filter((l) => l.key !== key));
  };

  // --- barcode scan path ---------------------------------------------------
  const handleSearchKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const code = query.trim();
    if (!code) return;
    e.preventDefault();
    // local catalog first
    const local = products.find((p) => p.barcode === code || p.sku === code);
    if (local) {
      addProduct(local);
      setQuery('');
      setNotFoundCode(null);
      return;
    }
    try {
      const remote = await lookupByBarcode(code);
      if (remote) {
        addProduct(remote);
        setQuery('');
        setNotFoundCode(null);
      } else {
        setNotFoundCode(code);
      }
    } catch {
      setNotFoundCode(code);
    }
  };

  // --- offline queue + online tracking ------------------------------------
  const flushQueue = useCallback(async () => {
    const queue = readQueue();
    if (queue.length === 0) return;
    const remaining: CreateSaleInput[] = [];
    for (const item of queue) {
      try {
        await createSale(item);
      } catch (err) {
        // keep this sale and anything after it, bail out — we'll retry later
        remaining.push(item);
        if (err instanceof PosApiError && err.status && err.status >= 400 && err.status < 500) {
          // a 4xx won't fix itself — drop it so the queue drains
          remaining.pop();
        } else {
          const idx = queue.indexOf(item);
          remaining.push(...queue.slice(idx + 1));
          break;
        }
      }
    }
    writeQueue(remaining);
    setPendingCount(remaining.length);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = () => {
      setOnline(true);
      void flushQueue();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const timer = window.setInterval(() => {
      if (navigator.onLine) void flushQueue();
    }, FLUSH_INTERVAL_MS);
    // try once on mount
    if (navigator.onLine) void flushQueue();
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.clearInterval(timer);
    };
  }, [flushQueue]);

  // --- complete sale -------------------------------------------------------
  const complete = async () => {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    const tenderedNum = Number(tendered) || 0;
    const grand = totals.grand;
    const cash = tenderMethod === 'cash' || tenderMethod === 'mixed' ? tenderedNum : 0;
    const card =
      tenderMethod === 'card' ? grand : tenderMethod === 'mixed' ? Math.max(0, grand - cash) : 0;
    const change = tenderMethod === 'cash' ? Math.max(0, tenderedNum - grand) : 0;
    const payload: CreateSaleInput = {
      tenderMethod,
      tenderCash: Number(cash.toFixed(3)),
      tenderCard: Number(card.toFixed(3)),
      changeGiven: Number(change.toFixed(3)),
      lines: cart.map((l) => ({
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatCategory: l.vatCategory,
        vatRate: l.vatRate,
      })),
    };
    try {
      const sale = await createSale(payload);
      setCompletedSale(sale);
      setCart([]);
      setTendered('');
    } catch {
      // offline fallback — queue
      const queue = readQueue();
      queue.push(payload);
      writeQueue(queue);
      setPendingCount(queue.length);
      // show a synthetic receipt so the cashier is not blocked
      const now = new Date().toISOString();
      const synthetic: Sale = {
        id: `offline-${Date.now()}`,
        number: `OFFLINE-${Date.now()}`,
        soldAt: now,
        subtotal: money(totals.subtotal),
        vatTotal: money(totals.vat),
        grandTotal: money(totals.grand),
        tenderMethod,
        tenderCash: money(cash),
        tenderCard: money(card),
        changeGiven: money(change),
        clearanceStatus: 'OFFLINE_QUEUED',
        lines: payload.lines.map((l, i) => ({
          lineNo: i + 1,
          description: l.description,
          quantity: money(l.quantity),
          unitPrice: money(l.unitPrice),
          vatCategory: l.vatCategory ?? 'S',
          vatRate: (l.vatRate ?? 5).toFixed(2),
          lineNet: money(l.quantity * l.unitPrice),
        })),
      };
      setCompletedSale(synthetic);
      setCart([]);
      setTendered('');
    } finally {
      setSubmitting(false);
    }
  };

  if (completedSale) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-5xl px-6 py-10">
          <ReceiptView sale={completedSale} onNewSale={() => setCompletedSale(null)} />
        </div>
      </div>
    );
  }

  const tenderedNum = Number(tendered) || 0;
  const change = tenderMethod === 'cash' ? Math.max(0, tenderedNum - totals.grand) : 0;
  const disableComplete =
    cart.length === 0 || submitting || (tenderMethod === 'cash' && tenderedNum < totals.grand);

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-start">{t('pos.title')}</h1>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
                online
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
              role="status"
            >
              {online ? t('pos.online') : t('pos.offline')}
            </span>
            {pendingCount > 0 && (
              <span
                className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 ps-3 pe-3 py-1 text-xs font-medium text-amber-800"
                role="status"
              >
                {t('pos.offline_pending', { count: pendingCount })}
              </span>
            )}
          </div>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* Catalog */}
          <section className="lg:col-span-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <label className="block">
              <span className="sr-only">{t('pos.search')}</span>
              <input
                ref={searchRef}
                type="text"
                inputMode="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setNotFoundCode(null);
                }}
                onKeyDown={(e) => void handleSearchKey(e)}
                placeholder={t('pos.search')}
                aria-label={t('pos.search')}
                className="w-full rounded-md border border-slate-300 ps-3 pe-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </label>
            {notFoundCode && (
              <p className="mt-2 text-sm text-amber-700" role="alert">
                {t('pos.notFound')} <span className="font-mono">{notFoundCode}</span>
              </p>
            )}
            {productsError && (
              <p className="mt-2 text-sm text-rose-700" role="alert">
                {productsError}
              </p>
            )}
            <div
              className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3"
              role="list"
              aria-label={t('pos.title')}
            >
              {filteredProducts.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => addProduct(p)}
                  role="listitem"
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-start transition hover:border-indigo-400 hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <div className="text-sm font-semibold text-slate-900">
                    {lang === 'ar' && p.nameAr ? p.nameAr : p.nameEn}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{p.sku}</div>
                  <div className="mt-1 text-sm tabular-nums text-slate-700">
                    {money(Number(p.unitPrice))}
                  </div>
                </button>
              ))}
              {filteredProducts.length === 0 && !productsError && (
                <div className="col-span-full text-sm text-slate-500">{t('pos.empty')}</div>
              )}
            </div>
          </section>

          {/* Cart */}
          <section className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-start text-lg font-semibold">{t('pos.cart')}</h2>
            {cart.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">{t('pos.empty')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {cart.map((l) => (
                  <li key={l.key} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-slate-900">
                          {l.description}
                        </div>
                        <div className="text-xs tabular-nums text-slate-500">
                          {money(l.unitPrice)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => changeQty(l.key, -1)}
                          aria-label={`-1 ${l.description}`}
                          className="h-8 w-8 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                        >
                          −
                        </button>
                        <span
                          className="min-w-6 text-center text-sm tabular-nums"
                          aria-label={t('pos.qty')}
                        >
                          {l.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => changeQty(l.key, +1)}
                          aria-label={`+1 ${l.description}`}
                          className="h-8 w-8 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          onClick={() => removeLine(l.key)}
                          className="ms-2 text-xs text-rose-700 hover:underline"
                        >
                          {t('pos.remove')}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-4 border-t border-slate-200 pt-3 text-sm">
              <div className="flex justify-between py-1">
                <dt className="text-slate-500">{t('pos.subtotal')}</dt>
                <dd className="tabular-nums">{money(totals.subtotal)}</dd>
              </div>
              <div className="flex justify-between py-1">
                <dt className="text-slate-500">{t('pos.vatTotal')}</dt>
                <dd className="tabular-nums">{money(totals.vat)}</dd>
              </div>
              <div className="flex justify-between py-1 text-base font-semibold">
                <dt>{t('pos.grandTotal')}</dt>
                <dd className="tabular-nums">{money(totals.grand)}</dd>
              </div>
            </dl>

            <div className="mt-4" role="group" aria-label={t('pos.tendered')}>
              <div className="flex gap-2">
                {(['cash', 'card', 'mixed'] as TenderMethod[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setTenderMethod(m)}
                    aria-pressed={tenderMethod === m}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
                      tenderMethod === m
                        ? 'border-indigo-600 bg-indigo-600 text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {t(`pos.tender.${m}`)}
                  </button>
                ))}
              </div>
              {tenderMethod !== 'card' && (
                <label className="mt-3 block">
                  <span className="text-xs font-medium text-slate-500">{t('pos.tendered')}</span>
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 ps-3 pe-3 py-2 text-sm tabular-nums focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </label>
              )}
              {tenderMethod === 'cash' && (
                <div className="mt-2 flex justify-between text-sm">
                  <span className="text-slate-500">{t('pos.change')}</span>
                  <span className="tabular-nums">{money(change)}</span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void complete()}
              disabled={disableComplete}
              className="mt-5 w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('pos.complete')}
            </button>
          </section>
        </div>
      </div>
    </main>
  );
}

export default PosPage;
