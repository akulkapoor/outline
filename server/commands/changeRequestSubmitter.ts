import { Op, UniqueConstraintError } from "sequelize";
import { ChangeRequestStatus } from "@shared/types";
import { InvalidRequestError } from "@server/errors";
import { ChangeRequest, Collection, Document } from "@server/models";
import { authorize } from "@server/policies";
import type { APIContext } from "@server/types";

type Props = {
  /** Draft document to submit for review. */
  draftDocumentId: string;
};

/**
 * Find an open change request for a draft document.
 *
 * @param draftDocumentId Draft document id.
 * @param transaction Database transaction.
 * @return Open change request, if any.
 */
async function findOpenChangeRequest(
  draftDocumentId: string,
  transaction: APIContext["state"]["transaction"]
) {
  return ChangeRequest.findOne({
    where: {
      draftDocumentId,
      status: {
        [Op.in]: [ChangeRequestStatus.Draft, ChangeRequestStatus.Submitted],
      },
    },
    transaction,
  });
}

/**
 * Transition an open change request to submitted.
 *
 * @param ctx API context.
 * @param changeRequest Change request to submit.
 * @return Submitted change request.
 */
async function submitOpenChangeRequest(
  ctx: APIContext,
  changeRequest: ChangeRequest
) {
  const { user } = ctx.state.auth;

  changeRequest.status = ChangeRequestStatus.Submitted;
  changeRequest.submittedById = user.id;
  changeRequest.submittedAt = new Date();
  await changeRequest.saveWithCtx(ctx, undefined, {
    name: "submit",
  });

  return changeRequest;
}

/**
 * Submit a new-page draft for maintainer review.
 *
 * @param ctx API context.
 * @param props Submission properties.
 * @return The submitted change request.
 */
export default async function changeRequestSubmitter(
  ctx: APIContext,
  { draftDocumentId }: Props
): Promise<ChangeRequest> {
  const { user } = ctx.state.auth;
  const { transaction } = ctx.state;

  const document = await Document.scope("withDrafts").findByPk(draftDocumentId, {
    userId: user.id,
    transaction,
    rejectOnEmpty: true,
  });

  if (!document.isDraft) {
    throw InvalidRequestError("Only drafts can be submitted for review");
  }

  const collection = document.collectionId
    ? await Collection.findByPk(document.collectionId, {
        userId: user.id,
        transaction,
        rejectOnEmpty: true,
      })
    : null;

  if (!collection?.maintainerApprovalRequired) {
    throw InvalidRequestError(
      "This collection does not require approval before publishing"
    );
  }

  authorize(user, "update", document);

  const existingChangeRequest = await findOpenChangeRequest(
    document.id,
    transaction
  );

  if (existingChangeRequest?.status === ChangeRequestStatus.Submitted) {
    throw InvalidRequestError("This draft has already been submitted for review");
  }

  if (existingChangeRequest) {
    return submitOpenChangeRequest(ctx, existingChangeRequest);
  }

  try {
    return await ChangeRequest.createWithCtx(
      ctx,
      {
        teamId: document.teamId,
        documentId: null,
        draftDocumentId: document.id,
        baseRevisionId: null,
        status: ChangeRequestStatus.Submitted,
        submittedById: user.id,
        submittedAt: new Date(),
      },
      { name: "submit" }
    );
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) {
      throw err;
    }

    const racedChangeRequest = await findOpenChangeRequest(
      document.id,
      transaction
    );

    if (!racedChangeRequest) {
      throw err;
    }

    if (racedChangeRequest.status === ChangeRequestStatus.Submitted) {
      throw InvalidRequestError(
        "This draft has already been submitted for review"
      );
    }

    return submitOpenChangeRequest(ctx, racedChangeRequest);
  }
}
