import type { Transaction } from "sequelize";
import { ChangeRequestStatus } from "@shared/types";
import { InvalidRequestError } from "@server/errors";
import { ChangeRequest, Collection, Document } from "@server/models";
import type { APIContext } from "@server/types";
import { isCollectionMaintainer } from "./CollectionMaintainerHelper";

/** Key used in `proposedChanges` to record the collection at submission time. */
export const CHANGE_REQUEST_SUBMISSION_COLLECTION_KEY = "submissionCollectionId";

/**
 * Build proposed change metadata for a new-page submission.
 *
 * @param collectionId Collection the draft was submitted from.
 * @return Proposed changes payload.
 */
export function buildSubmissionProposedChanges(collectionId: string) {
  return {
    [CHANGE_REQUEST_SUBMISSION_COLLECTION_KEY]: collectionId,
  };
}

/**
 * Read the collection id recorded when a change request was submitted.
 *
 * @param changeRequest Change request to read from.
 * @return Submission collection id, if recorded.
 */
export function getSubmissionCollectionId(
  changeRequest: ChangeRequest
): string | null {
  const value =
    changeRequest.proposedChanges?.[CHANGE_REQUEST_SUBMISSION_COLLECTION_KEY];

  return typeof value === "string" ? value : null;
}

/**
 * Find a submitted change request for a draft document.
 *
 * @param draftDocumentId Draft document id.
 * @param transaction Optional database transaction.
 * @return Submitted change request, if any.
 */
export async function findSubmittedChangeRequestForDraft(
  draftDocumentId: string,
  transaction?: Transaction
) {
  return ChangeRequest.findOne({
    where: {
      draftDocumentId,
      status: ChangeRequestStatus.Submitted,
    },
    transaction,
  });
}

/**
 * Reject direct publish while a draft has a submitted change request.
 *
 * @param ctx API context.
 * @param draftDocumentId Draft document id.
 * @throws InvalidRequestError when a submitted change request exists.
 */
export async function assertDraftHasNoSubmittedChangeRequest(
  ctx: APIContext,
  draftDocumentId: string
) {
  const changeRequest = await findSubmittedChangeRequestForDraft(
    draftDocumentId,
    ctx.state.transaction
  );

  if (changeRequest) {
    throw InvalidRequestError(
      "This draft has a change request under review and cannot be published directly"
    );
  }
}

/**
 * Reject moving a draft while it has a submitted change request.
 *
 * @param ctx API context.
 * @param document Draft being moved.
 * @throws InvalidRequestError when a submitted change request exists.
 */
export async function assertDraftCanMoveWhileUnderReview(
  ctx: APIContext,
  document: Document
) {
  if (!document.isDraft) {
    return;
  }

  const changeRequest = await findSubmittedChangeRequestForDraft(
    document.id,
    ctx.state.transaction
  );

  if (changeRequest) {
    throw InvalidRequestError(
      "This draft has a change request under review and cannot be moved"
    );
  }
}

/**
 * Resolve whether the acting user may review a change request for a collection.
 *
 * @param ctx API context.
 * @param collectionId Collection to check maintainership for.
 * @return True when the user is a team admin or collection maintainer.
 */
export async function resolveChangeRequestMaintainerStatus(
  ctx: APIContext,
  collectionId: string | null | undefined
): Promise<boolean> {
  const { user } = ctx.state.auth;
  const { transaction } = ctx.state;

  if (user.isAdmin) {
    return true;
  }

  if (!collectionId) {
    return false;
  }

  const collection = await Collection.findByPk(collectionId, {
    transaction,
    paranoid: false,
  });

  if (!collection || collection.deletedAt) {
    return false;
  }

  return isCollectionMaintainer(user, collection, transaction);
}

/**
 * Validate that a submitted change request can still be reviewed for its draft.
 *
 * @param ctx API context.
 * @param changeRequest Change request being reviewed.
 * @param document Current draft document state.
 * @throws InvalidRequestError when the draft is no longer eligible for review.
 */
export async function assertChangeRequestDraftReadyForReviewAction(
  ctx: APIContext,
  changeRequest: ChangeRequest,
  document: Document
) {
  const { user } = ctx.state.auth;
  const { transaction } = ctx.state;

  if (!document.collectionId) {
    throw InvalidRequestError(
      "Draft must belong to a collection before it can be reviewed"
    );
  }

  const collection = await Collection.findByPk(document.collectionId, {
    userId: user.id,
    transaction,
    paranoid: false,
  });

  if (!collection || collection.deletedAt) {
    throw InvalidRequestError("The draft's collection is no longer available");
  }

  if (!collection.maintainerApprovalRequired) {
    throw InvalidRequestError(
      "This collection no longer requires approval before publishing"
    );
  }

  const submissionCollectionId = getSubmissionCollectionId(changeRequest);

  if (
    submissionCollectionId &&
    submissionCollectionId !== document.collectionId
  ) {
    throw InvalidRequestError(
      "This draft was moved after submission and cannot be reviewed"
    );
  }
}
