export interface NatsKVStorageConfig {
  /** NATS server URLs */
  servers: string[];
  /** KV bucket name (default: "mastra-workflows") */
  bucket?: string;
  /** Number of replicas (default: 3, use 1 for single-node dev) */
  replicas?: number;
  /** TTL in seconds for snapshot keys (default: 300) */
  ttlSeconds?: number;
  /** NATS authentication (all optional) */
  credentials?: {
    user?: string;
    pass?: string;
    token?: string;
    nkey?: string;
  };
}

export interface ResolvedNatsKVStorageConfig {
  servers: string[];
  bucket: string;
  replicas: number;
  ttlSeconds: number;
  credentials: {
    user?: string;
    pass?: string;
    token?: string;
    nkey?: string;
  };
}
