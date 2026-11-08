import type { CreateLeadDto } from './dto/create-lead.dto';
export interface ReadinessVerdict {
  ready: boolean;
  score: number;
  blockers: string[];
  recommendations: string[];
  deadline: string;
}
const VOLUME_ORDER: Record<string, number> = {
  '<100': 0,
  '100-500': 1,
  '500-2000': 2,
  '>2000': 3,
};
export function assessReadiness(input: CreateLeadDto): ReadinessVerdict {
  const blockers: string[] = [];
  const recommendations: string[] = [];
  let score = 100;
  const deadline = input.revenueBand === '>5M' ? '2027-04-01' : '2027-10-01';
  if (!input.vatRegistered) {
    recommendations.push('Register for VAT if applicable');
  }
  if (/excel|paper|whatsapp/i.test(input.currentTool)) {
    score -= 30;
    blockers.push("Current invoicing tool won't produce PINT-OM/UBL 2.1 XML");
  }
  if (input.invoiceVolumeBand === '>2000' && /excel/i.test(input.currentTool)) {
    score -= 10;
    blockers.push('High volume on manual tooling');
  }
  const erpMissing = !input.erp || input.erp.trim() === '';
  if (erpMissing && VOLUME_ORDER[input.invoiceVolumeBand] >= VOLUME_ORDER['500-2000']) {
    score -= 10;
    recommendations.push('Connect to a supported ERP/accounting system');
  }
  if (input.b2cShare === '25-50' || input.b2cShare === '>50') {
    score -= 5;
    recommendations.push('Enable B2C 24h batching mode');
  }
  const ready = score >= 70 && blockers.length === 0;
  return { ready, score, blockers, recommendations, deadline };
}
