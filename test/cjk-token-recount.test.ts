import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/estimate-tokens.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";

/**
 * Helper: create an in-memory DB, run migrations, and return it.
 */
function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return db;
}

function createConversation(db: DatabaseSync): number {
  db.prepare(
    `INSERT INTO conversations (session_id, title) VALUES (?, ?)`,
  ).run("test-session", "Test Conversation");
  const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return row.id;
}

/**
 * Old formula: reproduces the pre-CJK estimation used before the fix.
 */
function oldEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

describe("CJK token recount migration", () => {
  it("corrects CJK message token counts that were stored with old formula", () => {
    const db = createTestDb();
    const convId = createConversation(db);

    // Insert messages with deliberately wrong (old-formula) token counts
    const cjkContent = "今天天气真不错啊你好吗这是一个很长的中文消息用来测试";
    const wrongCount = oldEstimate(cjkContent); // ceil(24/4) = 6
    const correctCount = estimateTokens(cjkContent); // ~36

    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId, 1, "user", cjkContent, wrongCount);

    // Verify the wrong value is stored
    const before = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId, 1) as { token_count: number };
    expect(before.token_count).toBe(wrongCount);
    expect(wrongCount).toBeLessThan(correctCount);

    // Delete the migration flag so the recount runs again
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);

    // Re-run migrations
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const after = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId, 1) as { token_count: number };
    expect(after.token_count).toBe(correctCount);

    db.close();
  });

  it("corrects CJK summary token counts that were stored with old formula", () => {
    const db = createTestDb();
    const convId = createConversation(db);

    const cjkSummary = "这个对话讨论了项目架构设计使用有向无环图来管理上下文压缩";
    const wrongCount = oldEstimate(cjkSummary);
    const correctCount = estimateTokens(cjkSummary);

    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sum-cjk-1", convId, "leaf", 0, cjkSummary, wrongCount);

    const before = db.prepare(
      `SELECT token_count FROM summaries WHERE summary_id = ?`,
    ).get("sum-cjk-1") as { token_count: number };
    expect(before.token_count).toBe(wrongCount);
    expect(wrongCount).toBeLessThan(correctCount);

    // Delete the migration flag so the recount runs again
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);

    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const after = db.prepare(
      `SELECT token_count FROM summaries WHERE summary_id = ?`,
    ).get("sum-cjk-1") as { token_count: number };
    expect(after.token_count).toBe(correctCount);

    db.close();
  });

  it("does NOT change ASCII-only content (old and new formulas agree)", () => {
    const db = createTestDb();
    const convId = createConversation(db);

    const asciiContent = "This is a plain English message for testing purposes.";
    const oldCount = oldEstimate(asciiContent);
    const newCount = estimateTokens(asciiContent);
    // For pure ASCII, both formulas give the same result
    expect(oldCount).toBe(newCount);

    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId, 1, "user", asciiContent, oldCount);

    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sum-ascii-1", convId, "leaf", 0, asciiContent, oldCount);

    // Delete the flag and re-run
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const msgAfter = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId, 1) as { token_count: number };
    expect(msgAfter.token_count).toBe(oldCount);

    const sumAfter = db.prepare(
      `SELECT token_count FROM summaries WHERE summary_id = ?`,
    ).get("sum-ascii-1") as { token_count: number };
    expect(sumAfter.token_count).toBe(oldCount);

    db.close();
  });

  it("is idempotent — running the migration twice does not break anything", () => {
    const db = createTestDb();
    const convId = createConversation(db);

    const cjkContent = "你好世界这是测试消息";
    const correctCount = estimateTokens(cjkContent);

    // Insert a message with already-correct token count (simulates post-fix write)
    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId, 1, "user", cjkContent, correctCount);

    // First run already happened in createTestDb, flag is set.
    // Verify the flag exists
    const flag = db.prepare(
      `SELECT flag FROM lcm_migration_flags WHERE flag = ?`,
    ).get("cjk_token_recount_v1");
    expect(flag).toBeDefined();

    // Running migrations again should not throw and token count stays the same
    const { fts5Available } = getLcmDbFeatures(db);
    expect(() => runLcmMigrations(db, { fts5Available })).not.toThrow();

    const after = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId, 1) as { token_count: number };
    expect(after.token_count).toBe(correctCount);

    db.close();
  });

  it("handles mixed CJK and ASCII content correctly", () => {
    const db = createTestDb();
    const convId = createConversation(db);

    const mixedContent = "Hello 你好世界 this is a test 测试消息";
    const wrongCount = oldEstimate(mixedContent);
    const correctCount = estimateTokens(mixedContent);

    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId, 1, "user", mixedContent, wrongCount);

    // Delete flag and re-run
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const after = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId, 1) as { token_count: number };
    expect(after.token_count).toBe(correctCount);

    // The correct count should be higher than the old one for mixed CJK content
    expect(correctCount).toBeGreaterThan(wrongCount);

    db.close();
  });

  it("creates the lcm_migration_flags table and sets the flag", () => {
    const db = createTestDb();

    // Verify the flag table exists and flag is set
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='lcm_migration_flags'`)
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);

    const flag = db.prepare(
      `SELECT flag FROM lcm_migration_flags WHERE flag = ?`,
    ).get("cjk_token_recount_v1") as { flag: string } | undefined;
    expect(flag).toBeDefined();
    expect(flag!.flag).toBe("cjk_token_recount_v1");

    db.close();
  });

  it("recalculates across multiple conversations", () => {
    const db = createTestDb();
    const convId1 = createConversation(db);
    db.prepare(
      `INSERT INTO conversations (session_id, title) VALUES (?, ?)`,
    ).run("session-2", "Second Conversation");
    const convId2 = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;

    const cjk1 = "第一个对话的中文消息";
    const cjk2 = "第二个对话的日本語メッセージ";

    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId1, 1, "user", cjk1, oldEstimate(cjk1));
    db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(convId2, 1, "user", cjk2, oldEstimate(cjk2));

    // Delete flag and re-run
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });

    const msg1 = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId1, 1) as { token_count: number };
    expect(msg1.token_count).toBe(estimateTokens(cjk1));

    const msg2 = db.prepare(
      `SELECT token_count FROM messages WHERE conversation_id = ? AND seq = ?`,
    ).get(convId2, 1) as { token_count: number };
    expect(msg2.token_count).toBe(estimateTokens(cjk2));

    db.close();
  });

  it("handles empty messages table gracefully", () => {
    const db = createTestDb();
    // No messages or summaries inserted — just verify migration runs without error
    // Delete flag and re-run
    db.exec(`DELETE FROM lcm_migration_flags WHERE flag = 'cjk_token_recount_v1'`);
    const { fts5Available } = getLcmDbFeatures(db);
    expect(() => runLcmMigrations(db, { fts5Available })).not.toThrow();

    // Flag should still be set
    const flag = db.prepare(
      `SELECT flag FROM lcm_migration_flags WHERE flag = ?`,
    ).get("cjk_token_recount_v1");
    expect(flag).toBeDefined();

    db.close();
  });
});
