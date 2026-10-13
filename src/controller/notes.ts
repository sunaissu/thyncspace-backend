import { withNoteMutationLock } from "../util/noteMutationLock.js";
import type { Request, RequestHandler } from "express";
import createHttpError from "http-errors";
import mongoose from "mongoose";
import NoteModel from "../models/note.model.js";
import UserModel from "../models/user.model.js";
import * as NoteRepository from "../repositories/note.repository.js";
import { NoteStatus, NoteType, PermissionLevel } from "../types/_enums.js";
import { createCollaborationToken } from "../util/collaborationToken.js";
import { sessionFingerprint } from "../util/deviceSessions.js";
import {
  cacheKeys,
  invalidateOwnedNotesCache,
  readThroughCachedJson,
} from "../util/cache.js";
import { toNoteResponse } from "../util/noteResponse.js";
import {
  disconnectCollaborator,
  disconnectNote,
  flushNoteState,
  updateCollaboratorPermission,
  updateNoteState,
} from "../collaboration/server.js";
import {
  MAX_IMPORT_CONTENT_BYTES,
  MAX_IMPORT_NOTES,
  getShareIdentifierLookupQueries,
  validateNoteContent,
  validateNoteContentForType,
  validateNoteTitle,
  validateNoteType,
  validateShareIdentifier,
  validateSourcePath,
} from "../util/validation.js";

const requireContentRevision = (expected: unknown, actual: number) => {
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
    throw createHttpError(428, "A content revision is required; reload the note before saving");
  }
  if (expected !== actual) throw createHttpError(409, "This note changed in another session. Your local draft has been kept; compare it with the latest server copy before saving.");
};

const requireValidNoteId = (noteId: string) => {
  if (!mongoose.isValidObjectId(noteId)) {
    throw createHttpError(400, "Invalid note ID");
  }
};

const getUserId = (req: Request) => {
  if (!req.user) throw createHttpError(401, "Authentication required");
  return req.user.id;
};

const getOwnedNote = async (noteId: string, userId: string) => {
  requireValidNoteId(noteId);
  const note = await NoteModel.findOne({
    _id: noteId,
    status: NoteStatus.Active,
  }).exec();
  if (!note) throw createHttpError(404, "Note not found");
  if (note.owner.toString() !== userId) {
    throw createHttpError(403, "Only the owner can manage sharing");
  }
  return note;
};

export const getNotes: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const notes = await readThroughCachedJson(
      cacheKeys.ownedNotes(userId),
      async () => {
        const storedNotes = await NoteRepository.findNotesByOwner(userId);
        return storedNotes.map((note) => toNoteResponse(note, userId));
      },
    );
    res.status(200).json(notes);
  } catch (error) {
    next(error);
  }
};

export const getSharedNotes: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const notes = await NoteRepository.findSharedNotesByUser(userId);
    res.status(200).json(notes.map((note) => toNoteResponse(note, userId)));
  } catch (error) {
    next(error);
  }
};

export const getFavoriteNotes: RequestHandler = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const notes = await NoteRepository.findFavoritedNotesByUser(userId);
    res.status(200).json(notes.map((note) => toNoteResponse(note, userId)));
  } catch (error) {
    next(error);
  }
};

export const getNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    const note = await NoteModel.findOne({
      _id: noteId,
      status: NoteStatus.Active,
    }).exec();
    if (!note) throw createHttpError(404, "Note not found");

    const userId = getUserId(req);
    const hasAccess =
      note.owner.toString() === userId ||
      note.sharedWith.some((entry) => entry.userId.toString() === userId);
    if (!hasAccess) {
      throw createHttpError(403, "You do not have access to this note");
    }
    res.status(200).json(toNoteResponse(note, userId));
  } catch (error) {
    next(error);
  }
};

export const createNote: RequestHandler = async (req, res, next) => {
  try {
    const title = validateNoteTitle(req.body?.title);
    const type = validateNoteType(req.body?.type);
    const content = validateNoteContentForType(req.body?.text, type);
    const userId = getUserId(req);
    const newNote = await NoteModel.create({
      title,
      content: content ?? "",
      type,
      owner: userId,
    });
    await invalidateOwnedNotesCache(userId);
    res.status(201).json(toNoteResponse(newNote, userId));
  } catch (error) {
    next(error);
  }
};

export const importNotes: RequestHandler = async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.notes) || req.body.notes.length === 0) {
      throw createHttpError(400, "At least one note is required");
    }
    if (req.body.notes.length > MAX_IMPORT_NOTES) {
      throw createHttpError(413, `Import at most ${MAX_IMPORT_NOTES} notes at once`);
    }

    let totalContentBytes = 0;
    const userId = getUserId(req);
    const notesToCreate: Array<{ owner: string; title: string; type: NoteType; content: string; sourcePath?: string }> = req.body.notes.map((input: unknown) => {
      if (typeof input !== "object" || input === null) {
        throw createHttpError(400, "Every imported note must be an object");
      }
      const candidate = input as Record<string, unknown>;
      const content = validateNoteContentForType(candidate.text, NoteType.Document) ?? "";
      totalContentBytes += Buffer.byteLength(content, "utf8");
      return {
        owner: userId,
        title: validateNoteTitle(candidate.title),
        sourcePath: validateSourcePath(candidate.sourcePath),
        type: NoteType.Document,
        content,
      };
    });
    if (totalContentBytes > MAX_IMPORT_CONTENT_BYTES) {
      throw createHttpError(413, "The selected import is too large");
    }

    const importIds = notesToCreate.map(() => new mongoose.Types.ObjectId());
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() =>
        NoteModel.insertMany(notesToCreate.map((note, index) => ({ ...note, _id: importIds[index] })), { session }),
      );
      const createdNotes = await NoteModel.find({ _id: { $in: importIds }, owner: userId }).exec();
      const byId = new Map(createdNotes.map(note => [note.id, note]));
      const orderedNotes = importIds.map(id => byId.get(id.toString())!);
      await invalidateOwnedNotesCache(userId);
      res
        .status(201)
        .json(
          orderedNotes.map((note: InstanceType<typeof NoteModel>) =>
            toNoteResponse(note, userId),
          ),
        );
    } finally {
      await session.endSession();
    }
  } catch (error) {
    next(error);
  }
};

export const updateNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    if (req.body?.title === undefined && req.body?.text === undefined) {
      throw createHttpError(400, "Nothing to update");
    }

    const title =
      req.body?.title === undefined ? undefined : validateNoteTitle(req.body?.title);
    const content = validateNoteContent(req.body?.text);
    const userId = getUserId(req);
    const changes: { content?: string; title?: string } = {};
    if (title !== undefined) changes.title = title;
    if (content !== undefined) changes.content = content;
    await withNoteMutationLock(noteId, async () => {
      const editableNote = await NoteModel.findOne({
        _id: noteId,
        status: NoteStatus.Active,
        $or: [
          { owner: userId },
          {
            sharedWith: {
              $elemMatch: {
                userId,
                permission: PermissionLevel.Editor,
              },
            },
          },
        ],
      })
        .select("type sharedWith contentRevision")
        .exec();
      if (!editableNote) {
        const noteExists = await NoteModel.exists({
          _id: noteId,
          status: NoteStatus.Active,
        });
        throw createHttpError(
          noteExists ? 403 : 404,
          noteExists
            ? "You do not have permission to edit this note"
            : "Note not found",
        );
      }

      if (content !== undefined) {
        if (editableNote.sharedWith.length) throw createHttpError(409, "Shared content must be changed through live editing");
        requireContentRevision(req.body?.expectedRevision, editableNote.contentRevision ?? 0);
      }
      if (content !== undefined && editableNote.type === NoteType.Whiteboard) {
        validateNoteContentForType(content, NoteType.Whiteboard);
      }

      // The Yjs document is authoritative for every shared note. Updating only
      // the materialized MongoDB fields leaves the live document stale, and its
      // next autosave can overwrite this change with the older value.
      await updateNoteState(
        noteId,
        userId,
        editableNote.type as NoteType,
        changes,
        false,
      );

      const updatedNote = await NoteModel.findOne({
        _id: noteId,
        status: NoteStatus.Active,
      }).exec();
      if (!updatedNote) throw createHttpError(404, "Note not found");
      res.status(200).json(toNoteResponse(updatedNote, userId));
    });
  } catch (error) {
    next(error);
  }
};

export const updatePrivateNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    if (req.body?.title === undefined && req.body?.text === undefined) {
      throw createHttpError(400, "Nothing to update");
    }

    const title =
      req.body?.title === undefined ? undefined : validateNoteTitle(req.body?.title);
    const content = validateNoteContent(req.body?.text);
    const changes: { content?: string; title?: string } = {};
    if (title !== undefined) changes.title = title;
    if (content !== undefined) changes.content = content;

    const userId = getUserId(req);
    await withNoteMutationLock(noteId, async () => {
      const note = await NoteModel.findOne({
        _id: noteId,
        status: NoteStatus.Active,
      })
        .select("owner sharedWith type contentRevision")
        .exec();
      if (!note) throw createHttpError(404, "Note not found");
      if (note.owner.toString() !== userId) {
        throw createHttpError(403, "Only the owner can update a private note");
      }
      if (note.sharedWith.length) {
        throw createHttpError(
          409,
          "This note has collaborators and must be updated through live editing",
        );
      }

      if (content !== undefined) requireContentRevision(req.body?.expectedRevision, note.contentRevision ?? 0);
      if (content !== undefined && note.type === NoteType.Whiteboard) {
        validateNoteContentForType(content, NoteType.Whiteboard);
      }

      await updateNoteState(
        noteId,
        userId,
        note.type as NoteType,
        changes,
        true,
      );
      const updatedNote = await NoteModel.findOne({
        _id: noteId,
        status: NoteStatus.Active,
      }).exec();
      if (!updatedNote) throw createHttpError(404, "Note not found");
      if (updatedNote.sharedWith.length) {
        throw createHttpError(
          409,
          "This note started live editing before the private save completed",
        );
      }
      res.status(200).json(toNoteResponse(updatedNote, userId));
    });
  } catch (error) {
    next(error);
  }
};

export const deleteNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    const userId = getUserId(req);
    await withNoteMutationLock(noteId, async () => {
      const note = await NoteModel.findOne({
        _id: noteId,
        status: NoteStatus.Active,
      }).exec();
      if (!note) throw createHttpError(404, "Note not found");
      if (note.owner.toString() !== userId) {
        throw createHttpError(403, "Only the owner can delete this note");
      }

      await flushNoteState(noteId);
      await NoteModel.updateOne({ _id: noteId, owner: userId, status: NoteStatus.Active },
        { $set: { status: NoteStatus.Trashed, trashedAt: new Date() }, $unset: { sharedWith: 1, favoritedBy: 1 } }).exec();
      disconnectNote(noteId);
      await invalidateOwnedNotesCache(note.owner.toString());
    });
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
};

export const toggleFavorite: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    const userId = getUserId(req);
    const note = await NoteModel.findOne({
      _id: noteId,
      status: NoteStatus.Active,
    })
      .select("owner sharedWith")
      .exec();
    if (!note) throw createHttpError(404, "Note not found");

    const hasAccess =
      note.owner.toString() === userId ||
      note.sharedWith.some((entry) => entry.userId.toString() === userId);
    if (!hasAccess) {
      throw createHttpError(403, "You do not have access to this note");
    }

    const updatedNote = await NoteRepository.toggleFavorite(noteId, userId);
    if (!updatedNote) throw createHttpError(404, "Note not found");
    await invalidateOwnedNotesCache(updatedNote.owner.toString());
    res.status(200).json(toNoteResponse(updatedNote, userId));
  } catch (error) {
    next(error);
  }
};

export const createRealtimeToken: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    const userId = getUserId(req);
    const note = await NoteModel.findOne({
      _id: noteId,
      status: NoteStatus.Active,
    })
      .select("owner sharedWith")
      .exec();
    if (!note) throw createHttpError(404, "Note not found");
    const hasAccess =
      note.owner.toString() === userId ||
      note.sharedWith.some((entry) => entry.userId.toString() === userId);
    if (!hasAccess) {
      throw createHttpError(403, "You do not have access to this note");
    }
    res.status(200).json({ token: createCollaborationToken(noteId, userId, sessionFingerprint(req.sessionID)) });
  } catch (error) {
    next(error);
  }
};

export const getCollaborators: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    const note = await getOwnedNote(noteId, getUserId(req));
    const users = await UserModel.find({
      _id: { $in: note.sharedWith.map((entry) => entry.userId) },
    })
      .select("username +email")
      .exec();
    const usersById = new Map(users.map((user) => [user.id, user]));
    res.status(200).json(
      note.sharedWith.flatMap((entry) => {
        const user = usersById.get(entry.userId.toString());
        return user
          ? [{
              userId: user.id,
              username: user.username,
              email: user.email,
              permission: entry.permission,
            }]
          : [];
      }),
    );
  } catch (error) {
    next(error);
  }
};

export const shareNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  try {
    requireValidNoteId(noteId);
    const ownerId = getUserId(req);
    const identifier = validateShareIdentifier(req.body?.identifier);
    const permission = req.body?.permission as PermissionLevel;
    const rawSnapshot: unknown = req.body?.snapshot;
    if (![PermissionLevel.Viewer, PermissionLevel.Editor].includes(permission)) {
      throw createHttpError(400, "Permission must be viewer or editor");
    }

    let collaborator: InstanceType<typeof UserModel> | null = null;
    for (const query of getShareIdentifierLookupQueries(identifier)) {
      collaborator = await UserModel.findOne(query)
        .collation({ locale: "en", strength: 2 })
        .select("username +email")
        .exec();
      if (collaborator) break;
    }
    if (!collaborator) throw createHttpError(404, "User not found");
    const resolvedCollaborator = collaborator;
    if (resolvedCollaborator.id === ownerId) {
      throw createHttpError(400, "The owner already has full access");
    }

    const collaboratorAlreadyExists = await withNoteMutationLock(
      noteId,
      async () => {
        const note = await getOwnedNote(noteId, ownerId);
        const existing = note.sharedWith.find(
          (entry) => entry.userId.toString() === resolvedCollaborator.id,
        );
        const isFirstShare = !existing && note.sharedWith.length === 0;
        let snapshotContent: string | undefined;

        if (isFirstShare && rawSnapshot !== undefined) {
          if (typeof rawSnapshot !== "object" || rawSnapshot === null) {
            throw createHttpError(400, "The note snapshot is invalid");
          }
          const snapshot = rawSnapshot as Record<string, unknown>;
          requireContentRevision(snapshot.expectedRevision, note.contentRevision ?? 0);
          snapshotContent = validateNoteContentForType(snapshot.text, note.type as NoteType);
          if (snapshotContent === undefined) {
            throw createHttpError(400, "The note snapshot is missing its content");
          }
        }

        if (existing) existing.permission = permission;
        else note.sharedWith.push({ userId: resolvedCollaborator._id, permission });
        await note.save();
        updateCollaboratorPermission(noteId, resolvedCollaborator.id, permission);
        await invalidateOwnedNotesCache(ownerId);

        if (isFirstShare && snapshotContent !== undefined) {
          try {
            // Access is recorded first, so any late private save is rejected;
            // this latest snapshot then becomes the initial live state.
            await updateNoteState(
              noteId,
              ownerId,
              note.type as NoteType,
              { content: snapshotContent },
              false,
            );
          } catch (promotionError) {
            await NoteModel.updateOne(
              { _id: noteId, owner: ownerId, status: NoteStatus.Active },
              { $pull: { sharedWith: { userId: resolvedCollaborator._id } } },
            ).exec();
            await invalidateOwnedNotesCache(ownerId);
            disconnectCollaborator(noteId, resolvedCollaborator.id);
            throw promotionError;
          }
        }

        return Boolean(existing);
      },
    );

    res.status(collaboratorAlreadyExists ? 200 : 201).json({
      userId: resolvedCollaborator.id,
      username: resolvedCollaborator.username,
      email: resolvedCollaborator.email,
      permission,
    });
  } catch (error) {
    next(error);
  }
};

export const unshareNote: RequestHandler = async (req, res, next) => {
  const noteId = req.params.noteId as string;
  const collaboratorId = req.params.userId as string;
  try {
    requireValidNoteId(collaboratorId);
    const ownerId = getUserId(req);
    await withNoteMutationLock(noteId, async () => {
      const note = await getOwnedNote(noteId, ownerId);
      const previousLength = note.sharedWith.length;
      note.sharedWith = note.sharedWith.filter(
        (entry) => entry.userId.toString() !== collaboratorId,
      );
      if (note.sharedWith.length === previousLength) {
        throw createHttpError(404, "Collaborator not found");
      }
      await note.save();
      disconnectCollaborator(noteId, collaboratorId);
      await invalidateOwnedNotesCache(note.owner.toString());
    });
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
};
