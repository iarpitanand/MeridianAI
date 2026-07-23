import { pool } from "../db.js";
import type { Extracted } from "./parser.js";
import type { Chunk } from "./chunk.js";

export interface StoredChunk extends Chunk {
  contentHash: string;
  embedding: number[] | null;
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Replace all index rows for one file in a single transaction:
 * symbols, refs, chunks, and the files bookkeeping row.
 */
export async function storeFile(params: {
  repoId: number;
  path: string;
  contentHash: string;
  indexedSha: string;
  extracted: Extracted | null;
  chunks: StoredChunk[];
}): Promise<void> {
  const { repoId, path, contentHash, indexedSha, extracted, chunks } = params;
  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `delete from symbols where repo_id = $1 and file_path = $2`,
      [repoId, path],
    );
    await client.query(
      `delete from symbol_refs where repo_id = $1 and ref_file = $2`,
      [repoId, path],
    );
    await client.query(
      `delete from code_chunks where repo_id = $1 and file_path = $2`,
      [repoId, path],
    );

    if (extracted) {
      for (const s of extracted.symbols) {
        await client.query(
          `insert into symbols (repo_id, file_path, symbol_name, kind, start_line, end_line, language)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [repoId, path, s.name, s.kind, s.startLine, s.endLine, extracted.language],
        );
      }
      for (const r of extracted.refs) {
        await client.query(
          `insert into symbol_refs (repo_id, ref_name, ref_file, ref_line)
           values ($1,$2,$3,$4)`,
          [repoId, r.name, path, r.line],
        );
      }
    }

    for (const c of chunks) {
      await client.query(
        `insert into code_chunks (repo_id, file_path, symbol_name, start_line, end_line, content_hash, embedding)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          repoId,
          path,
          c.symbolName,
          c.startLine,
          c.endLine,
          c.contentHash,
          c.embedding ? toVectorLiteral(c.embedding) : null,
        ],
      );
    }

    await client.query(
      `insert into files (repo_id, path, content_hash, last_indexed_sha)
       values ($1,$2,$3,$4)
       on conflict (repo_id, path) do update
         set content_hash = excluded.content_hash,
             last_indexed_sha = excluded.last_indexed_sha`,
      [repoId, path, contentHash, indexedSha],
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Remove a deleted file's rows. */
export async function removeFile(repoId: number, path: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from symbols where repo_id=$1 and file_path=$2`, [repoId, path]);
    await client.query(`delete from symbol_refs where repo_id=$1 and ref_file=$2`, [repoId, path]);
    await client.query(`delete from code_chunks where repo_id=$1 and file_path=$2`, [repoId, path]);
    await client.query(`delete from files where repo_id=$1 and path=$2`, [repoId, path]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function getFileHash(
  repoId: number,
  path: string,
): Promise<string | null> {
  const res = await pool.query<{ content_hash: string }>(
    `select content_hash from files where repo_id=$1 and path=$2`,
    [repoId, path],
  );
  return res.rows[0]?.content_hash ?? null;
}

export async function setRepoIndexStatus(
  repoId: number,
  status: "pending" | "indexing" | "ready" | "failed",
  lastIndexedSha?: string,
): Promise<void> {
  if (lastIndexedSha) {
    await pool.query(
      `update repos set index_status=$2, last_indexed_sha=$3, updated_at=now() where repo_id=$1`,
      [repoId, status, lastIndexedSha],
    );
  } else {
    await pool.query(
      `update repos set index_status=$2, updated_at=now() where repo_id=$1`,
      [repoId, status],
    );
  }
}
