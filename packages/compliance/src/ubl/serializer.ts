/**
 * UBL 2.1 Invoice serialiser for PINT-OM.
 *
 * This is a PURE function: same `PintOmInvoice` in -> byte-identical
 * UTF-8 XML out. Determinism is important because the signing layer
 * (A6) hashes the canonical XML for `jws` payload; any order drift
 * would invalidate signatures across replays.
 *
 * We rely on three guarantees:
 *   1. V8 preserves string-key insertion order on plain objects.
 *   2. `fast-xml-parser`'s `XMLBuilder` iterates children in that
 *      insertion order and emits attributes before text / children.
 *   3. We always format amounts with `.toFixed(scale)` so float
 *      rendering jitter never leaks into the bytes.
 *
 * Element order below matches UBL 2.1 sequencing for every parent
 * node that has multiple children, so the output is also schema-
 * ordered for an XSD-friendly consumer.
 */

import { XMLBuilder } from 'fast-xml-parser';
import type { PintOmInvoice } from '../pint-om/types.js';
import type { SemanticLine, SemanticParty, SemanticVatBreakdownRow } from '../semantic/en16931.js';

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decimal places for monetary rendering.
 *
 * OMR is baisa (3 decimal places, 1 OMR = 1000 baisa). Everything
 * else we currently emit (USD / EUR / AED / SAR) is 2. If we add a
 * zero-decimal currency (JPY, KWD-adjacent) we'd need to grow this
 * table — until then, 2 is the safe fallback.
 */
function amountScale(currency: string): number {
  return currency === 'OMR' ? 3 : 2;
}

function fmtAmount(value: number, currency: string): string {
  return value.toFixed(amountScale(currency));
}

/** Wrap a decimal value as a UBL monetary element payload (with currencyID). */
function money(value: number, currency: string): Record<string, unknown> {
  return {
    '@_currencyID': currency,
    '#text': fmtAmount(value, currency),
  };
}

/** Render BT-153 / BT-119 percent values. Trailing-zero free. */
function fmtPercent(rate: number): string {
  return String(rate);
}

/* -------------------------------------------------------------------------- */
/* Subtree builders                                                           */
/* -------------------------------------------------------------------------- */

function buildPartyBlock(p: SemanticParty): Record<string, unknown> {
  // UBL document order inside cac:Party:
  //   cac:PartyIdentification?, cac:PartyName*, cac:PostalAddress?,
  //   cac:PartyTaxScheme*, cac:PartyLegalEntity*, cac:Contact?, ...
  // We emit only PartyName and (when a VATIN exists) PartyTaxScheme.
  const party: Record<string, unknown> = {
    'cac:PartyName': { 'cbc:Name': p.bt27_name },
  };
  if (p.bt31_vatIdentifier) {
    party['cac:PartyTaxScheme'] = {
      'cbc:CompanyID': p.bt31_vatIdentifier,
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    };
  }
  return { 'cac:Party': party };
}

function buildTaxSubtotal(row: SemanticVatBreakdownRow, currency: string): Record<string, unknown> {
  // UBL document order inside cac:TaxSubtotal:
  //   cbc:TaxableAmount, cbc:TaxAmount, ..., cac:TaxCategory.
  return {
    'cbc:TaxableAmount': money(row.bt116_categoryTaxableAmount, currency),
    'cbc:TaxAmount': money(row.bt117_categoryTaxAmount, currency),
    'cac:TaxCategory': {
      'cbc:ID': row.bt118_categoryCode,
      'cbc:Percent': fmtPercent(row.bt119_categoryRate),
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    },
  };
}

function buildInvoiceLine(line: SemanticLine, currency: string): Record<string, unknown> {
  return {
    'cbc:ID': line.bt126_lineId,
    'cbc:InvoicedQuantity': {
      '@_unitCode': line.bt130_unitCode,
      '#text': String(line.bt129_quantity),
    },
    'cbc:LineExtensionAmount': money(line.bt131_lineNetAmount, currency),
    'cac:Item': { 'cbc:Name': line.bt146_itemName },
    'cac:Price': {
      'cbc:PriceAmount': money(line.bt146_itemNetPrice, currency),
    },
    'cac:TaxCategory': {
      'cbc:ID': line.bt152_itemVatCategoryCode,
      'cbc:Percent': fmtPercent(line.bt153_itemVatRate),
      'cac:TaxScheme': { 'cbc:ID': 'VAT' },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const UBL_NS_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const UBL_NS_CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const UBL_NS_CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

export function pintOmToUbl(invoice: PintOmInvoice): string {
  const currency = invoice.bt5_currencyCode;

  const invoiceRoot: Record<string, unknown> = {
    '@_xmlns': UBL_NS_INVOICE,
    '@_xmlns:cac': UBL_NS_CAC,
    '@_xmlns:cbc': UBL_NS_CBC,
    'cbc:CustomizationID': invoice.customizationId,
    'cbc:ProfileID': invoice.profileId,
    'cbc:ID': invoice.bt1_invoiceNumber,
  };

  if (invoice.documentUuid) {
    invoiceRoot['cbc:UUID'] = invoice.documentUuid;
  }

  invoiceRoot['cbc:IssueDate'] = invoice.bt2_issueDate;
  invoiceRoot['cbc:InvoiceTypeCode'] = invoice.bt3_typeCode;
  invoiceRoot['cbc:DocumentCurrencyCode'] = invoice.bt5_currencyCode;
  invoiceRoot['cac:AccountingSupplierParty'] = buildPartyBlock(invoice.supplier);
  invoiceRoot['cac:AccountingCustomerParty'] = buildPartyBlock(invoice.buyer);
  invoiceRoot['cac:TaxTotal'] = {
    'cbc:TaxAmount': money(invoice.bg22_documentTotals.bt110_totalVatAmount, currency),
    'cac:TaxSubtotal': invoice.bg23_vatBreakdown.map((row) => buildTaxSubtotal(row, currency)),
  };
  invoiceRoot['cac:LegalMonetaryTotal'] = {
    'cbc:LineExtensionAmount': money(
      invoice.bg22_documentTotals.bt106_sumOfLineNetAmounts,
      currency,
    ),
    'cbc:TaxExclusiveAmount': money(
      invoice.bg22_documentTotals.bt109_totalAmountWithoutVat,
      currency,
    ),
    'cbc:TaxInclusiveAmount': money(invoice.bg22_documentTotals.bt112_totalAmountWithVat, currency),
    'cbc:PayableAmount': money(invoice.bg22_documentTotals.bt115_amountDueForPayment, currency),
  };
  invoiceRoot['cac:InvoiceLine'] = invoice.bg25_lines.map((line) =>
    buildInvoiceLine(line, currency),
  );

  const builder = new XMLBuilder({
    attributeNamePrefix: '@_',
    ignoreAttributes: false,
    textNodeName: '#text',
    format: true,
    indentBy: '  ',
    processEntities: true,
    suppressEmptyNode: false,
  });

  const body = builder.build({ Invoice: invoiceRoot }) as string;
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
}
