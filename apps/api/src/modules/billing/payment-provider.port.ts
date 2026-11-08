import { Injectable } from '@nestjs/common';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface PaymentIntent {
  id: string;
  providerSessionUrl?: string;
}

export interface PaymentProvider {
  createIntent(input: {
    amount: number;
    currency: string;
    reference: string;
  }): Promise<PaymentIntent>;
  markPaid(reference: string): Promise<void>; // webhook simulator for tests
}

/**
 * In-memory stub provider for Wave 2 — no external PSP integration.
 * Exposes `isPaid()` so tests can observe webhook simulation.
 */
@Injectable()
export class StubPaymentProvider implements PaymentProvider {
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly paid = new Set<string>();

  async createIntent(input: {
    amount: number;
    currency: string;
    reference: string;
  }): Promise<PaymentIntent> {
    const intent: PaymentIntent = {
      id: `stub_${input.reference}`,
      providerSessionUrl: `https://stub.local/pay/${encodeURIComponent(input.reference)}`,
    };
    this.intents.set(input.reference, intent);
    return intent;
  }

  async markPaid(reference: string): Promise<void> {
    this.paid.add(reference);
  }

  isPaid(reference: string): boolean {
    return this.paid.has(reference);
  }

  getIntent(reference: string): PaymentIntent | undefined {
    return this.intents.get(reference);
  }
}

/**
 * Thawani adapter placeholder — real wiring belongs to A14 or production.
 * Keep the shape stable so swapping the provider is a module binding change only.
 */
@Injectable()
export class ThawaniPaymentProvider implements PaymentProvider {
  async createIntent(_input: {
    amount: number;
    currency: string;
    reference: string;
  }): Promise<PaymentIntent> {
    throw new Error('ThawaniPaymentProvider.createIntent not implemented');
  }
  async markPaid(_reference: string): Promise<void> {
    throw new Error('ThawaniPaymentProvider.markPaid not implemented');
  }
}
