import type { Client, Pool } from "pg";

/**
 * `CREATE EXTENSION IF NOT EXISTS` is not safe against a concurrent create: the `IF NOT EXISTS`
 * check and the insert into `pg_extension` are not atomic against another session doing the same
 * thing, so two test files starting at the same moment can both pass the check and then one loses
 * the race on `pg_extension_name_index` with `23505`. Every suite in this directory opens with this
 * call, `node --test` runs them concurrently, and CI is where they actually start together — so the
 * race was latent for a long time and became likely the moment one more file was added.
 *
 * Losing this race means the extension exists, which is the whole point of the call, so the two
 * error codes that say exactly that are the ones swallowed: `23505` (the unique violation above)
 * and `42710` (duplicate_object, which a concurrent plain `CREATE EXTENSION` raises).
 */
export async function ensureVectorExtension(admin: Client | Pool) {
  try {
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "23505" && code !== "42710") throw error;
  }
}
