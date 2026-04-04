/**
 * Embedding module placeholder.
 *
 * In v0.1.0, embedding is not yet implemented. The importance detector
 * uses lexical (Jaccard) approximations instead of real embeddings.
 *
 * Future versions will integrate ONNX Runtime with a vendored embedding model.
 */

export interface EmbeddingResult {
  vector: Float32Array;
  dimensions: number;
}

export interface Embedder {
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * Stub embedder that returns zero vectors.
 * Used as a placeholder until ONNX integration is complete.
 */
export class StubEmbedder implements Embedder {
  constructor(private dimensions = 384) {}

  async embed(_text: string): Promise<EmbeddingResult> {
    return {
      vector: new Float32Array(this.dimensions),
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map(() => ({
      vector: new Float32Array(this.dimensions),
      dimensions: this.dimensions,
    }));
  }
}
