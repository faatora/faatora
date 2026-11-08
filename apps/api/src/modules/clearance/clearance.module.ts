import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { ClearanceController } from './clearance.controller';
import { ClearanceGatewayService } from './clearance-gateway.service';
import { ClearanceScheduler } from './clearance-scheduler';
import { TransmissionCircuitBreaker } from './circuit-breaker';
import { ASP_CALLBACK_SINK, StubAspProvider } from './stub-asp';
import { TRANSMISSION_PROVIDER } from './transmission-provider.port';
import { ArchiveModule } from '../archive/archive.module';

/**
 * ClearanceModule — Wave 3 wiring.
 *
 *   TRANSMISSION_PROVIDER -> StubAspProvider  (swap for real-ASP class to
 *                                              flip providers; the port
 *                                              interface is the contract.)
 *   ASP_CALLBACK_SINK     -> ClearanceGatewayService
 *                             (the stub pushes async OTA verdicts straight
 *                              into gateway.handleCallback.)
 *
 * ArchiveModule is imported so ArchiveService can be injected into the
 * gateway for the auto-advance CLEARED -> ARCHIVED hook (B1 fix).
 */
@Module({
  imports: [ArchiveModule],
  controllers: [ClearanceController],
  providers: [
    ClearanceGatewayService,
    ClearanceScheduler,
    TransmissionCircuitBreaker,
    StubAspProvider,
    { provide: TRANSMISSION_PROVIDER, useExisting: StubAspProvider },
    { provide: ASP_CALLBACK_SINK, useExisting: ClearanceGatewayService },
  ],
  exports: [ClearanceGatewayService, TRANSMISSION_PROVIDER],
})
export class ClearanceModule implements OnApplicationShutdown {
  constructor(private readonly gateway: ClearanceGatewayService) {}

  async onApplicationShutdown(): Promise<void> {
    await this.gateway.closeInternalPool();
  }
}
