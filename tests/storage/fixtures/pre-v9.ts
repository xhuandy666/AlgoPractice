import type { DatabaseSync } from 'node:sqlite';

/** Synthetic legacy fixture only; production never removes review evidence or downgrades a database. */
export function stripProblemReviewSchema(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='problem_review_meta'").get()) return;
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP VIEW problem_review_effective_events;
    DROP TRIGGER legacy_review_item_insert_blocked;
    DROP TRIGGER legacy_review_item_update_blocked;
    DROP TRIGGER legacy_review_event_insert_blocked;
    DROP TRIGGER legacy_review_request_insert_blocked;
    DROP TABLE review_assessment_drafts;
    DROP TABLE review_sessions;
    DROP TABLE review_legacy_links;
    DROP TABLE problem_review_requests;
    DROP TABLE problem_review_day_assessments;
    DROP TABLE problem_review_events;
    DROP TABLE review_daily_ac_opportunities;
    DROP TABLE problem_review_plans;
    DROP TABLE problem_review_migrations;
    DROP TABLE problem_review_meta;
    PRAGMA user_version=8; PRAGMA foreign_keys=ON;`);
}
