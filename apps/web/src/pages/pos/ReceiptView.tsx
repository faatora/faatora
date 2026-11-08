import { useTranslation } from 'react-i18next';
import type { Sale } from './api';

type ReceiptViewProps = {
  sale: Sale;
  onNewSale?: () => void;
};

function money(v: string | number): string {
  const n = typeof v === 'string' ? Number(v) : v;
  return n.toFixed(3);
}

export function ReceiptView({ sale, onNewSale }: ReceiptViewProps) {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').split('-')[0];
  const soldAt = new Date(sale.soldAt);
  const print = () => window.print();

  return (
    <section
      className="mx-auto max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none print:max-w-full"
      aria-label={t('pos.receiptTitle')}
    >
      <header className="text-center">
        <h2 className="text-lg font-bold">{t('brand')}</h2>
        <p className="text-sm text-slate-600">{t('pos.receiptTitle')}</p>
      </header>

      <dl className="mt-4 text-sm">
        <div className="flex justify-between py-1">
          <dt className="text-slate-500">{t('pos.saleNumber')}</dt>
          <dd className="font-mono">{sale.number}</dd>
        </div>
        <div className="flex justify-between py-1">
          <dt className="text-slate-500">{t('pos.soldAt')}</dt>
          <dd>{soldAt.toLocaleString(lang)}</dd>
        </div>
      </dl>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-start">
            <th className="py-1 text-start font-medium text-slate-500">#</th>
            <th className="py-1 text-start font-medium text-slate-500">{t('pos.cart')}</th>
            <th className="py-1 text-end font-medium text-slate-500">{t('pos.qty')}</th>
            <th className="py-1 text-end font-medium text-slate-500">{t('pos.subtotal')}</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-slate-100">
              <td className="py-1 text-slate-500">{l.lineNo}</td>
              <td className="py-1">{l.description}</td>
              <td className="py-1 text-end tabular-nums">{Number(l.quantity)}</td>
              <td className="py-1 text-end tabular-nums">{money(l.lineNet)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-4 text-sm">
        <div className="flex justify-between py-1">
          <dt className="text-slate-500">{t('pos.subtotal')}</dt>
          <dd className="tabular-nums">{money(sale.subtotal)}</dd>
        </div>
        <div className="flex justify-between py-1">
          <dt className="text-slate-500">{t('pos.vatTotal')}</dt>
          <dd className="tabular-nums">{money(sale.vatTotal)}</dd>
        </div>
        <div className="flex justify-between py-1 text-base font-semibold">
          <dt>{t('pos.grandTotal')}</dt>
          <dd className="tabular-nums">{money(sale.grandTotal)}</dd>
        </div>
        <div className="mt-2 flex justify-between py-1">
          <dt className="text-slate-500">{t(`pos.tender.${sale.tenderMethod}`)}</dt>
          <dd className="tabular-nums">
            {money(Number(sale.tenderCash) + Number(sale.tenderCard))}
          </dd>
        </div>
        {Number(sale.changeGiven) > 0 && (
          <div className="flex justify-between py-1">
            <dt className="text-slate-500">{t('pos.change')}</dt>
            <dd className="tabular-nums">{money(sale.changeGiven)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-3 print:hidden">
        <button
          type="button"
          onClick={print}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('pos.print')}
        </button>
        {onNewSale && (
          <button
            type="button"
            onClick={onNewSale}
            className="ps-5 pe-5 py-2 rounded-md border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('pos.newSale')}
          </button>
        )}
      </div>
    </section>
  );
}

export default ReceiptView;
