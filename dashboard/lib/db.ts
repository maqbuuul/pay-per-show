import { neon } from '@neondatabase/serverless';

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

// Constructed lazily: Next imports this module at build time, and DATABASE_URL
// is only present at runtime.
let client: Query | null = null;

/** Tagged-template query. Interpolated values are always sent as parameters. */
export async function sql<T = Record<string, any>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  client ??= neon(process.env.DATABASE_URL!) as unknown as Query;
  return (await client(strings, ...values)) as T[];
}

/** Rule violations raised by the billing functions carry a message written for the operator. */
export function businessError(e: unknown): string | null {
  const err = e as { code?: string; message?: string } | null;
  return err?.code === 'P0001' && err.message ? err.message : null;
}
