import { Injectable } from '@nestjs/common';
export const COMPLIANCE_VALIDATOR = 'COMPLIANCE_VALIDATOR';
export interface ComplianceResult {
  ok: boolean;
  errors?: string[];
  rulePackVersion?: string;
}
export interface ComplianceValidator {
  validate(input: unknown): Promise<ComplianceResult>;
}
@Injectable()
export class NoopComplianceValidator implements ComplianceValidator {
  async validate(): Promise<ComplianceResult> {
    return { ok: true, rulePackVersion: 'noop-ep3' };
  }
}
