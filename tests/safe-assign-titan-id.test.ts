import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { safeAssignTitanId } from "../server/lib/store.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      fixture_source TEXT NOT NULL,
      titan_id TEXT
    );
    CREATE UNIQUE INDEX matches_titan_uniq ON matches(titan_id) WHERE titan_id IS NOT NULL;
  `);
  return db;
}

describe("safeAssignTitanId", () => {
  it("assigns when target has no titan_id", () => {
    const db = makeDb();
    db.prepare("INSERT INTO matches VALUES('hkjc:1','hkjc',NULL)").run();
    const result = safeAssignTitanId(db, "hkjc:1", "titan-42", "hkjc");
    expect(result.ok).toBe(true);
    const row = db.prepare("SELECT titan_id FROM matches WHERE id='hkjc:1'").get() as { titan_id: string };
    expect(row.titan_id).toBe("titan-42");
  });

  it("is a no-op when target already has the same titan_id", () => {
    const db = makeDb();
    db.prepare("INSERT INTO matches VALUES('hkjc:1','hkjc','titan-42')").run();
    const result = safeAssignTitanId(db, "hkjc:1", "titan-42", "hkjc");
    expect(result.ok).toBe(true);
  });

  it("refuses to overwrite a titan_id owned by another match", () => {
    const db = makeDb();
    db.prepare("INSERT INTO matches VALUES('hkjc:1','hkjc','titan-42')").run();
    db.prepare("INSERT INTO matches VALUES('hkjc:2','hkjc',NULL)").run();
    const result = safeAssignTitanId(db, "hkjc:2", "titan-42", "hkjc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("owned_by_other");
      expect(result.ownerId).toBe("hkjc:1");
    }
    const row = db.prepare("SELECT titan_id FROM matches WHERE id='hkjc:2'").get() as { titan_id: string | null };
    expect(row.titan_id).toBeNull();
  });

  it("returns target_missing when the match row does not exist", () => {
    const db = makeDb();
    const result = safeAssignTitanId(db, "hkjc:missing", "titan-42", "hkjc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("target_missing");
  });

  it("respects fixtureSource filter", () => {
    const db = makeDb();
    db.prepare("INSERT INTO matches VALUES('pinnacle:1','pinnacle',NULL)").run();
    const result = safeAssignTitanId(db, "pinnacle:1", "titan-42", "hkjc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("target_missing");
    const row = db.prepare("SELECT titan_id FROM matches WHERE id='pinnacle:1'").get() as { titan_id: string | null };
    expect(row.titan_id).toBeNull();
  });

  it("does not raise when partial UNIQUE index would have been violated", () => {
    const db = makeDb();
    db.prepare("INSERT INTO matches VALUES('hkjc:1','hkjc','titan-42')").run();
    db.prepare("INSERT INTO matches VALUES('hkjc:2','hkjc',NULL)").run();
    // Directly calling UPDATE would raise UNIQUE constraint failed. safeAssignTitanId
    // must swallow that and return ok=false without throwing.
    expect(() => safeAssignTitanId(db, "hkjc:2", "titan-42", "hkjc")).not.toThrow();
  });
});
