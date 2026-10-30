import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/**
 * Two-person control: the operator who approves a credit must not be the one
 * who requested it. Compared by admin user id — the identity. Display names
 * are editable and not unique: comparing them let an admin approve their own
 * credit after a rename (or with a near-duplicate name), and blocked two
 * different people who happen to share a name.
 */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
