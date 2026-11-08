export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface CoaEntry {
  code: string;
  name: string;
  type: AccountType;
  isVatOutput?: boolean;
  isVatInput?: boolean;
}

export const OMANI_SME_COA: readonly CoaEntry[] = [
  // Assets
  { code: '1100', name: 'Cash', type: 'asset' },
  { code: '1110', name: 'Bank - Current', type: 'asset' },
  { code: '1200', name: 'Accounts Receivable', type: 'asset' },
  { code: '1300', name: 'Inventory', type: 'asset' },
  { code: '1400', name: 'VAT Recoverable', type: 'asset', isVatInput: true },
  { code: '1500', name: 'Fixed Assets', type: 'asset' },
  // Liabilities
  { code: '2100', name: 'Accounts Payable', type: 'liability' },
  { code: '2200', name: 'VAT Payable', type: 'liability', isVatOutput: true },
  { code: '2300', name: 'Accrued Expenses', type: 'liability' },
  // Equity
  { code: '3100', name: "Owner's Capital", type: 'equity' },
  { code: '3200', name: 'Retained Earnings', type: 'equity' },
  // Income
  { code: '4100', name: 'Sales - Standard-rated', type: 'income' },
  { code: '4110', name: 'Sales - Zero-rated', type: 'income' },
  { code: '4120', name: 'Sales - Exempt', type: 'income' },
  { code: '4900', name: 'Other Income', type: 'income' },
  // Expense
  { code: '5100', name: 'Cost of Sales', type: 'expense' },
  { code: '6100', name: 'Rent', type: 'expense' },
  { code: '6200', name: 'Salaries', type: 'expense' },
  { code: '6300', name: 'Utilities', type: 'expense' },
  { code: '6400', name: 'Marketing', type: 'expense' },
  { code: '6500', name: 'Bank Charges', type: 'expense' },
  { code: '6900', name: 'Other Expenses', type: 'expense' },
];

// VAT category -> income account code mapping used when posting an issued invoice.
// Standard-rated ('S'), Zero-rated ('Z'), Exempt ('E').
export const SALES_ACCOUNT_BY_VAT_CATEGORY: Record<string, string> = {
  S: '4100',
  Z: '4110',
  E: '4120',
};

export const ACCOUNT_CODES = {
  CASH: '1100',
  BANK: '1110',
  AR: '1200',
  VAT_INPUT: '1400',
  AP: '2100',
  VAT_OUTPUT: '2200',
  SALES_STANDARD: '4100',
  SALES_ZERO: '4110',
  SALES_EXEMPT: '4120',
  OTHER_EXPENSE: '6900',
} as const;
