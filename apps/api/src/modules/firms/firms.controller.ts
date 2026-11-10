import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import {
  AccountantAuthGuard,
  type AccountantAuthedRequest,
} from '../accountant/accountant-auth.guard';
import { FirmsService } from './firms.service';
import { FirmDashboardService } from './dashboard.service';
import {
  AcceptInvitationSchema,
  AddClientTenantSchema,
  AddMemberSchema,
  CreateFirmSchema,
  InviteMemberSchema,
  type AcceptInvitationDto,
  type AddClientTenantDto,
  type AddMemberDto,
  type CreateFirmDto,
  type InviteMemberDto,
} from './dto/schemas';
import { ZodValidationPipe } from './dto/zod.pipe';

/**
 * REST surface for the firm-console (EP5 Wave 1). Bare CRUD only.
 *
 * Two authentication surfaces:
 *   - FirmGuard-protected routes act under an active firm context (JWT
 *     `active_firm_id` claim, or `x-firm-id` header in dev/test).
 *   - A handful of bootstrap routes — "create my first firm", "accept an
 *     invitation", "list the firms I'm in" — cannot require an active
 *     firm context (they're what MAKES one), and are protected instead
 *     by the lighter-weight AccountantAuthGuard, which only verifies the
 *     Cognito token and resolves the local user row. AccountantAuthGuard
 *     is shared across console-style surfaces and is the right fit here.
 */
@Controller('firms')
export class FirmsController {
  constructor(
    private readonly firms: FirmsService,
    private readonly dashboard: FirmDashboardService,
  ) {}

  // ---------- bootstrap (no active firm required) ----------

  /**
   * POST /firms — create a new firm with the caller as its first owner.
   */
  @Post()
  @UseGuards(AccountantAuthGuard)
  create(
    @Req() req: AccountantAuthedRequest,
    @Body(new ZodValidationPipe(CreateFirmSchema)) dto: CreateFirmDto,
  ) {
    return this.firms.createFirm(req.userId!, dto);
  }

  /**
   * GET /firms/mine — all firms the caller is an active member of.
   */
  @Get('mine')
  @UseGuards(AccountantAuthGuard)
  listMine(@Req() req: AccountantAuthedRequest) {
    return this.firms.listMyFirms(req.userId!);
  }

  /**
   * POST /firms/invitations/accept — redeem a token sent by email. The
   * accepting user must be authenticated (so we know who's accepting)
   * but cannot already have the firm selected (that's what this
   * endpoint establishes).
   */
  @Post('invitations/accept')
  @UseGuards(AccountantAuthGuard)
  accept(
    @Req() req: AccountantAuthedRequest,
    @Body(new ZodValidationPipe(AcceptInvitationSchema)) dto: AcceptInvitationDto,
  ) {
    return this.firms.acceptInvitation(dto.token, req.userId!);
  }

  // ---------- firm-scoped (requires active firm) ----------

  /**
   * GET /firms/:id — get one firm. Caller must be a member of :id.
   */
  @Get(':id')
  @UseGuards(FirmGuard)
  get(@Req() req: FirmAuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    // FirmGuard already asserted req.firmId === id via membership check
    // on the active firm claim, so we pass req.firmId through for clarity.
    void id;
    return this.firms.getFirm(req.firmId!);
  }

  @Get(':id/members')
  @UseGuards(FirmGuard)
  listMembers(@Req() req: FirmAuthedRequest) {
    return this.firms.listMembers(req.firmId!);
  }

  @Post(':id/members')
  @UseGuards(FirmGuard)
  addMember(
    @Req() req: FirmAuthedRequest,
    @Body(new ZodValidationPipe(AddMemberSchema)) dto: AddMemberDto,
  ) {
    return this.firms.addMember(req.firmId!, dto);
  }

  @Post(':id/members/invites')
  @UseGuards(FirmGuard)
  invite(
    @Req() req: FirmAuthedRequest,
    @Body(new ZodValidationPipe(InviteMemberSchema)) dto: InviteMemberDto,
  ) {
    return this.firms.inviteMember(req.firmId!, req.userId!, dto);
  }

  @Delete(':id/members/:userId')
  @UseGuards(FirmGuard)
  revokeMember(
    @Req() req: FirmAuthedRequest,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.firms.revokeMember(req.firmId!, userId);
  }

  @Get(':id/clients')
  @UseGuards(FirmGuard)
  listClients(@Req() req: FirmAuthedRequest) {
    return this.firms.listClientTenants(req.firmId!);
  }

  @Post(':id/clients')
  @UseGuards(FirmGuard)
  addClient(
    @Req() req: FirmAuthedRequest,
    @Body(new ZodValidationPipe(AddClientTenantSchema)) dto: AddClientTenantDto,
  ) {
    return this.firms.addClientTenant(req.firmId!, dto);
  }

  @Delete(':id/clients/:tenantId')
  @UseGuards(FirmGuard)
  revokeClient(
    @Req() req: FirmAuthedRequest,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ) {
    return this.firms.revokeClientTenant(req.firmId!, tenantId);
  }

  // ---------- consolidated dashboard (W2-B) ----------

  /**
   * GET /firms/:id/dashboard — cross-tenant KPIs for the signed-in firm.
   * Single aggregated response: summary tiles, per-client rows, recent
   * issues, and upcoming VAT returns. Backed by the ADR-0003 option (a)
   * firm-SELECT RLS branch, so all aggregates run under one app.firm_id.
   */
  @Get(':id/dashboard')
  @UseGuards(FirmGuard)
  getDashboard(@Req() req: FirmAuthedRequest) {
    return this.dashboard.getDashboard(req.firmId!);
  }
}
