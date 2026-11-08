// W2-B dashboard API binding. All calls go through the shared apiFetch so
// the x-firm-id header is set automatically from FirmContext.

import { apiGet } from '../../../lib/api';

export type IssueSeverity = 'error' | 'warning' | 'info';
export type VatReturnStatus = 'draft' | 'submitted' | 'overdue';

export interface FirmDashboardSummary {
  totalClients: number;
  totalInvoices30d: number;
  totalVatCollected30dOmr: string;
  overdueInvoiceCount: number;
  failedClearanceCount: number;
  pendingSubmissionCount: number;
  upcomingVatReturnCount: number;
}

export interface FirmDashboardPerClient {
  tenantId: string;
  tenantName: string;
  invoices30d: number;
  vatCollected30dOmr: string;
  lastSubmissionAt: string | null;
  openIssues: number;
}

export interface FirmDashboardIssue {
  severity: IssueSeverity;
  message: string;
  tenantId?: string;
  invoiceId?: string;
  createdAt: string;
}

export interface FirmDashboardVatReturn {
  tenantId: string;
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  status: VatReturnStatus;
}

export interface FirmDashboard {
  summary: FirmDashboardSummary;
  perClient: FirmDashboardPerClient[];
  issues: FirmDashboardIssue[];
  vatReturnsDue: FirmDashboardVatReturn[];
}

export function fetchFirmDashboard(firmId: string): Promise<FirmDashboard> {
  return apiGet<FirmDashboard>(`/firms/${encodeURIComponent(firmId)}/dashboard`);
}
