/**
 * Storage Adapter
 * Abstract interface for file storage with filesystem and S3/R2 implementations
 */

import { mkdir, writeFile, readFile, readdir, stat, appendFile, rm } from 'fs/promises';
import { join, dirname, resolve, relative } from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

export interface StorageAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  append(path: string, content: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  deleteDir(path: string): Promise<void>;
  flush(): Promise<void>;
}

/**
 * Local filesystem storage (default for development)
 */
export class FileSystemStorage implements StorageAdapter {
  private basePath: string;

  constructor(basePath: string = process.cwd()) {
    this.basePath = resolve(basePath);
  }

  /**
   * Resolve and validate a path to prevent directory traversal attacks.
   * Ensures the resolved path stays within basePath.
   */
  private safePath(path: string): string {
    const fullPath = resolve(this.basePath, path);
    const rel = relative(this.basePath, fullPath);
    if (rel.startsWith('..') || resolve(fullPath) !== fullPath) {
      throw new Error(`Path traversal detected: "${path}" resolves outside the base directory`);
    }
    return fullPath;
  }

  async read(path: string): Promise<string> {
    return readFile(this.safePath(path), 'utf-8');
  }

  async write(path: string, content: string): Promise<void> {
    const fullPath = this.safePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async append(path: string, content: string): Promise<void> {
    const fullPath = this.safePath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await appendFile(fullPath, content);
  }

  async list(prefix: string): Promise<string[]> {
    const fullPath = this.safePath(prefix);
    try {
      const entries = await readdir(fullPath);
      return entries;
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.safePath(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.safePath(path), { recursive: true });
  }

  async deleteDir(path: string): Promise<void> {
    await rm(this.safePath(path), { recursive: true, force: true });
  }

  async flush(): Promise<void> {
    // No-op for filesystem — writes are immediate
  }
}

/**
 * S3/R2 storage (for production deployment)
 */
export class S3Storage implements StorageAdapter {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private appendBuffers: Map<string, string[]> = new Map();
  private readonly FLUSH_THRESHOLD = 20;

  constructor(config?: {
    bucket?: string;
    region?: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    prefix?: string;
  }) {
    const bucket = config?.bucket || process.env.S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_BUCKET is required for S3 storage');
    }

    this.bucket = bucket;
    this.prefix = config?.prefix || '';

    this.client = new S3Client({
      region: config?.region || process.env.S3_REGION || 'auto',
      endpoint: config?.endpoint || process.env.S3_ENDPOINT || undefined,
      credentials: {
        accessKeyId: config?.accessKeyId || process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: config?.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
    });
  }

  private key(path: string): string {
    return this.prefix ? `${this.prefix}/${path}` : path;
  }

  async read(path: string): Promise<string> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(path),
      })
    );

    return await result.Body!.transformToString('utf-8');
  }

  async write(path: string, content: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(path),
        Body: content,
        ContentType: path.endsWith('.json') ? 'application/json'
          : path.endsWith('.jsonl') ? 'application/x-ndjson'
          : 'text/plain',
      })
    );
  }

  async append(path: string, content: string): Promise<void> {
    // Buffer appends to avoid O(N²) read-concat-write on every call
    const buffer = this.appendBuffers.get(path) || [];
    buffer.push(content);
    this.appendBuffers.set(path, buffer);
    if (buffer.length >= this.FLUSH_THRESHOLD) {
      await this.flushPath(path);
    }
  }

  private async flushPath(path: string): Promise<void> {
    const buffer = this.appendBuffers.get(path);
    if (!buffer || buffer.length === 0) return;
    let existing = '';
    try {
      existing = await this.read(path);
    } catch {
      // File doesn't exist yet, start fresh
    }
    await this.write(path, existing + buffer.join(''));
    this.appendBuffers.delete(path);
  }

  async flush(): Promise<void> {
    for (const path of this.appendBuffers.keys()) {
      await this.flushPath(path);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.key(prefix);
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: fullPrefix.endsWith('/') ? fullPrefix : `${fullPrefix}/`,
        Delimiter: '/',
      })
    );

    const files: string[] = [];

    // Files at this level
    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.Key) {
          const name = obj.Key.replace(fullPrefix.endsWith('/') ? fullPrefix : `${fullPrefix}/`, '');
          if (name) files.push(name);
        }
      }
    }

    // "Directories" at this level
    if (result.CommonPrefixes) {
      for (const prefix of result.CommonPrefixes) {
        if (prefix.Prefix) {
          const name = prefix.Prefix.replace(fullPrefix.endsWith('/') ? fullPrefix : `${fullPrefix}/`, '').replace(/\/$/, '');
          if (name) files.push(name);
        }
      }
    }

    return files;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(path),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(_path: string): Promise<void> {
    // S3 doesn't need explicit directory creation
  }

  async deleteDir(path: string): Promise<void> {
    const fullPrefix = this.key(path);
    const prefix = fullPrefix.endsWith('/') ? fullPrefix : `${fullPrefix}/`;

    // List all objects under this prefix (paginate if needed)
    let continuationToken: string | undefined;
    do {
      const listResult = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      if (listResult.Contents && listResult.Contents.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: listResult.Contents.map((obj) => ({ Key: obj.Key! })),
            },
          })
        );
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  }
}

/**
 * Create storage adapter based on environment configuration
 */
export function createStorage(): StorageAdapter {
  const backend = process.env.STORAGE_BACKEND || 'fs';

  if (backend === 's3') {
    console.log('[Storage] Using S3 storage backend');
    return new S3Storage();
  }

  console.log('[Storage] Using filesystem storage backend');
  return new FileSystemStorage();
}
