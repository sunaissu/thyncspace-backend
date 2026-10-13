import { Types } from "mongoose";

export type ActivityKind = "edit" | "share" | "permission" | "unshare" | "restore" | "trash" | "organize" | "notebook" | "embed";
export const activityEntry = (kind: ActivityKind, actorId?: string, details: { targetId?: string; permission?: string; sourceNoteId?: string; sourceVersionId?: string } = {}) => ({ _id: new Types.ObjectId(), kind, at: new Date(), collective: kind === "edit" && !actorId, ...(actorId ? { actorId } : {}), ...details });
export const activityPush = (entry: ReturnType<typeof activityEntry>) => ({ $each: [entry], $slice: -100 });
