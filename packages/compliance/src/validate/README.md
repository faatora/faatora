# Faatora validation pipeline — Oman VAT engine

This folder holds every runtime check Faatora applies to an outbound Oman
e-invoice. The pipeline threads a `CanonicalInvoice` through five stages,
each of which emits structured `ValidationIssue`s, and aggregates them
into a single `ValidationReport`.

```
canonical (zod)
    ↓
canonical → semantic         (semantic/map.ts)
    ↓
VAT math                     (validate/vat-math.ts)
    ↓
semantic → pint-om → UBL
    ↓
XSD-lite                     (validate/xsd-lite.ts)
    ↓
Schematron-lite              (validate/schematron-lite.ts) — EN 16931 / BR-OM-*
    ↓
OM-R-*                       (validate/om-rules.ts)        — Oman-local rules
```

---

## The five Oman VAT categories

Royal Decree 121/2020 (in force since 16 Apr 2021) recognises five
`UNTDID 5305` / Peppol duty-category codes. All five are modelled by
`codelists/vat-category.ts` and flow through the engine unchanged.

| Code | Name            | Rate | Description                                                                         | Reverse-charge | Reason req. |
|------|-----------------|------|-------------------------------------------------------------------------------------|---------------:|------------:|
| S    | Standard        | 5%   | Default — most goods and services                                                   | no             | no          |
| Z    | Zero-rated      | 0%   | Exports, qualifying agri/fisheries, medicines, medical equipment, intl. transport   | no             | yes         |
| E    | Exempt          | —    | Financial services, residential leases, undeveloped land, bare metals, local transit | no             | yes         |
| O    | Out of scope    | —    | Transactions outside Oman's VAT territorial scope                                   | no             | yes         |
| AE   | Reverse charge  | —    | B2B cross-border — buyer accounts for VAT                                           | **yes**        | yes         |

For `AE`, the invoice tax amount is **always 0** and a mandatory
bilingual note states the buyer is liable. See `OM-R-03`.

---

## Reconciliation formulae

Every amount is handled in integer minor units of the document currency
(`10^scale`), so float drift of `1e-15` never surfaces as a spurious
error. For OMR the minor unit is the **baisa** (1 OMR = 1000 baisa,
`scale = 3`).

```
# Per line
line_net                = round(quantity * unit_price, scale)

# Per category
taxable[c]              = Σ line_net where line.category = c
tax[c]                  = round(taxable[c] * rate[c] / 100, scale)   # 0 for Z/E/O/AE

# Document-level
LineExtensionAmount     = Σ line_net                                   # BT-106
TaxExclusiveAmount      = LineExtensionAmount
                          − AllowanceTotalAmount                       # BT-109
                          + ChargeTotalAmount
TaxInclusiveAmount      = TaxExclusiveAmount + Σ tax[c]                # BT-112
PayableAmount           = TaxInclusiveAmount
                          − PrepaidAmount
                          − PayableRoundingAmount                      # BT-115
```

The semantic layer today carries allowances/charges/prepaid/rounding as
implicit zeroes; the identities still check out because the engine
threads `0` through the structure explicitly, so adding real values
later is a one-line plumbing change rather than a structural edit.

---

## Rounding

Mode: **commercial rounding — half away from zero, to the currency's
minor unit** (3 decimals for OMR, 2 for USD/EUR/AED/SAR).

The OM-PINT specification (Peppol International billing, Oman v1)
does not mandate banker's rounding; every OTA worked example rounds
half-away-from-zero, and so do the ERP packages our Omani SMB
customers use (SAP, Oracle, QuickBooks, Odoo). Picking banker's
rounding here would make the re-derived `tax[c]` disagree with the
stored one on half-baisa edge cases, producing noisy false positives.

Edge cases (OMR, scale 3):

| Input       | Output   | Note                          |
|-------------|----------|-------------------------------|
| 0.0005 OMR  | 0.001    | half rounds **up**            |
| 0.0004 OMR  | 0.000    |                               |
| 0.9995 OMR  | 1.000    |                               |
| -0.0005 OMR | -0.001   | half rounds **away from 0**   |

The mode is exported as `ROUNDING_MODE` for downstream callers.

---

## Rule catalogue

### Arithmetic (`stage: "vat"`, vat-math.ts)

| Rule         | Condition                                                               |
|--------------|-------------------------------------------------------------------------|
| `OM-VAT-001` | `line_net = round(quantity * unit_price, scale)`                        |
| `OM-VAT-002` | `taxable[c] = Σ line_net in c` (and no orphan breakdown rows)           |
| `OM-VAT-003` | `tax[c]     = round(taxable[c] * rate[c] / 100, scale)`                 |
| `OM-VAT-004` | `BT-106 = Σ line_net`                                                   |
| `OM-VAT-005` | `BT-110 = Σ tax[c]`                                                     |
| `OM-VAT-006` | `BT-112 = BT-109 + BT-110`                                              |
| `OM-VAT-007` | Reverse-charge (AE) rows must carry `tax = 0`                           |
| `OM-VAT-008` | `BT-109 = BT-106 − allowances + charges`                                |
| `OM-VAT-009` | `BT-115 = BT-112 − prepaid − rounding`                                  |
| `OM-VAT-010` | Line VAT category code is one of S / Z / E / O / AE                     |

### Business rules (`stage: "schematron"`, schematron-lite.ts + om-rules.ts)

| Rule        | Severity | Condition                                                              |
|-------------|----------|------------------------------------------------------------------------|
| `BR-01..16` | error    | EN 16931 presence / shape                                              |
| `BR-CO-*`   | error    | EN 16931 total identities                                              |
| `BR-S/Z/E`  | error    | Per-category rate shape                                                |
| `BR-OM-001` | warning  | Supplier VATIN matches `/^OM\d{10}$/` or `/^\d{10}$/`                  |
| `BR-OM-002` | warning  | Currency is OMR (unless an export)                                     |
| `BR-OM-003` | error    | Issue date is not in the future                                        |
| `OM-R-01`   | error    | Payable amount (BT-115) > 0                                            |
| `OM-R-02`   | error    | Every line's VAT category is one of S / Z / E / O / AE                 |
| `OM-R-03`   | error    | AE invoice carries the bilingual reverse-charge note (EN + AR)         |
| `OM-R-04`   | **warning** | Category-E lines should carry an exemption reason (see open qs)    |
| `OM-R-05`   | error    | `BT-109 = Σ lines ± allowances/charges` within ±1 minor unit           |
| `OM-R-06`   | error    | `BT-112 = BT-109 + Σ tax` within ±1 minor unit                         |
| `OM-R-07`   | error    | Seller VATIN set when any line is standard-rated or reverse-charge     |
| `OM-R-08`   | error    | Buyer VATIN set when any line is reverse-charge                        |

The OM-R-05 and OM-R-06 rules duplicate (with tolerance) the stricter
OM-VAT-008 / OM-VAT-006 checks. The arithmetic stage flags byte-exact
drift; OM-R-* flags business-level drift that exceeds a baisa.

---

## Open questions

- **BT-121 reason codes.** The semantic model does not yet carry the
  dedicated `VatExemptionReasonCode` field. OM-R-04 is a warning for
  now; once BT-121 is added, upgrade to error and tighten the check.
- **Signed amounts on credit notes.** OM-R-01 treats BT-115 as
  unsigned (sign conveyed by `bt3_typeCode`). If we later decide to
  store credit notes with a negative BT-115, the rule's branch per
  type code needs revisiting.
- **Arithmetic library.** We implement scaled-integer arithmetic
  in-house (see `toScaledInt` / `fromScaledInt` in `vat-math.ts`).
  A dedicated library (`bignumber.js`, `decimal.js`) would move the
  precision envelope from 15-digit JS doubles to arbitrary precision.
  Not urgent: for OMR up to the 15-digit float ceiling we have 12
  integer digits of headroom (~1 trillion OMR), well beyond any
  invoice we expect to process. Flag for review before extending
  to currencies with more than 4 minor units, or for consolidated
  reporting across many invoices.
