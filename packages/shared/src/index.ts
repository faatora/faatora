// Cross-cutting types shared between api and web (DTOs, enums) land here.
export type ClearanceStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'CLEARED'
  | 'REJECTED'
  | 'ARCHIVED';
