import { z } from 'zod';
import { badRequest } from '../lib/errors.js';

/**
 * All request bodies and query strings are validated with an explicit schema
 * before touching a service. Unknown keys are stripped (not passed through) and
 * every numeric economy value is an integer within a sane range, which is what
 * keeps SQL-injection and mass-assignment classes of bug structurally
 * impossible rather than "handled".
 */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, ctx: 'body' | 'query' | 'params'): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path?.join('.') ?? ctx;
    throw badRequest(
      first
        ? friendlyMessage(first.code, field)
        : `Invalid ${ctx}.`,
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function friendlyMessage(code: string, field: string): string {
  switch (code) {
    case 'invalid_type':
      return `"${field}" is required and must be the correct type.`;
    case 'too_small':
      return `"${field}" is too short or too small.`;
    case 'too_big':
      return `"${field}" is too long or too large.`;
    case 'unrecognized_keys':
      return `Unexpected field in request.`;
    default:
      return `"${field}" is not valid.`;
  }
}

/* ----------------------------- reusable schemas ----------------------------- */

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers and underscore only.');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z.string().min(8, 'At least 8 characters').max(200);

export const keySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, 'Lowercase letters, numbers and underscore (2-32 chars).');

export const idSchema = z.string().trim().min(1).max(64);

export const angleSchema = z.number().finite().min(-Math.PI * 4).max(Math.PI * 4);

export const coordSchema = z.number().finite().min(-10_000).max(10_000);

export const positiveInt = (max: number) => z.number().int().positive().max(max);

export const boolish = z
  .union([z.boolean(), z.enum(['true', 'false']), z.literal(0), z.literal(1)])
  .transform((v) => v === true || v === 'true' || v === 1);

export const intish = (fallback?: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => {
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : fallback;
    })
    .optional();

export const pageQuery = z.object({
  page: intish(1),
  limit: intish(25),
});
