"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX "change_requests_draft_document_id_open_uk"
         ON "change_requests" ("draftDocumentId")
         WHERE status IN ('draft', 'submitted');`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS "change_requests_draft_document_id_open_uk";`
    );
  },
};
