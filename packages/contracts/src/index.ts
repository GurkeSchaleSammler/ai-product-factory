import { z } from "zod";

export const evidenceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  summary: z.string().min(1),
  independentGroup: z.string().min(1),
});

export const productPitchSchema = z.object({
  id: z.string().uuid(),
  windowId: z.string().regex(/^\d{10}$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  name: z.string().min(1).max(120),
  targetAudience: z.string().min(1),
  problem: z.string().min(1),
  valueProposition: z.string().min(1),
  scope: z.array(z.string().min(1)).min(1).max(12),
  differentiation: z.string().min(1),
  revenueHypothesis: z.string().min(1),
  risks: z.array(z.string().min(1)).min(1),
  validationPlan: z.string().min(1),
  evidence: z.array(evidenceSchema).max(12),
});

export const replacementSchema = z.object({
  productId: z.string().uuid(),
  incumbentScore: z.number().int().min(0).max(100),
  hasRealUsers: z.boolean(),
  hasPersistentData: z.boolean(),
  humanApprovalId: z.string().min(1).optional(),
});

export const portfolioDecisionSchema = z.object({
  id: z.string().uuid(),
  pitchId: z.string().uuid(),
  portfolioRevision: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100),
  recommendation: z.enum(["ADMIT", "BACKLOG", "REJECT", "REPLACE"]),
  rationale: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  replacement: replacementSchema.optional(),
});

export const managementCommandSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(16),
  decisionId: z.string().uuid(),
  expectedPortfolioRevision: z.number().int().nonnegative(),
  operation: z.enum(["ADMIT", "REPLACE", "ARCHIVE"]),
  productId: z.string().uuid(),
  approvedAt: z.string().datetime(),
});

export const developmentOrderSchema = z.object({
  id: z.string().uuid(),
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(16),
  productId: z.string().uuid(),
  pitch: productPitchSchema,
  createdAt: z.string().datetime(),
});

export const verifiedReleaseSchema = z.object({
  orderId: z.string().uuid(),
  productId: z.string().uuid(),
  sourceRepository: z.string().min(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/i),
  imageRepository: z.string().min(1),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
  ciEvidenceUrl: z.string().url(),
  reviewEvidenceUrl: z.string().url(),
  registryEvidenceUrl: z.string().url(),
  verifiedAt: z.string().datetime(),
});

export const managementResultSchema = z.object({
  commandId: z.string().uuid(),
  status: z.enum(["ACCEPTED", "REJECTED", "COMPLETED", "NEEDS_HUMAN_REVIEW"]),
  reason: z.string().min(1),
  occurredAt: z.string().datetime(),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type ProductPitch = z.infer<typeof productPitchSchema>;
export type PortfolioDecision = z.infer<typeof portfolioDecisionSchema>;
export type ManagementCommand = z.infer<typeof managementCommandSchema>;
export type DevelopmentOrder = z.infer<typeof developmentOrderSchema>;
export type VerifiedRelease = z.infer<typeof verifiedReleaseSchema>;
export type ManagementResult = z.infer<typeof managementResultSchema>;

export const occupiedProductStates = [
  "RESERVED",
  "BUILDING",
  "REVIEWING",
  "DEPLOYING",
  "LIVE",
  "ARCHIVING",
  "ARCHIVE_FAILED",
] as const;
