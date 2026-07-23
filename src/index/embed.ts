import { config } from "../config.js";

export type InputType = "document" | "query";

export interface Embedder {
  readonly dimensions: number;
  readonly enabled: boolean;
  /** Returns one vector per input text (empty array when disabled). */
  embed(texts: string[], type: InputType): Promise<number[][]>;
}

/** Used when no embedding key is configured: indexing still builds the call graph. */
class NullEmbedder implements Embedder {
  readonly dimensions = config.EMBEDDING_DIMENSIONS;
  readonly enabled = false;
  async embed(): Promise<number[][]> {
    return [];
  }
}

class VoyageEmbedder implements Embedder {
  readonly enabled = true;
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[], type: InputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Voyage accepts up to 128 inputs / ~120k tokens per call; batch conservatively.
    const BATCH = 64;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const vectors = await this.call(batch, type);
      out.push(...vectors);
    }
    return out;
  }

  private async call(input: string[], type: InputType): Promise<number[][]> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input,
        model: this.model,
        input_type: type,
        output_dimension: this.dimensions,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

let singleton: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (singleton) return singleton;
  singleton = config.VOYAGE_API_KEY
    ? new VoyageEmbedder(
        config.VOYAGE_API_KEY,
        config.EMBEDDING_MODEL,
        config.EMBEDDING_DIMENSIONS,
      )
    : new NullEmbedder();
  return singleton;
}
