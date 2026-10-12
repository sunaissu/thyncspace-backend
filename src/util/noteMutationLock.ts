const noteMutationLocks = new Map<string, Promise<void>>();

export const withNoteMutationLock = async <Result>(
  noteId: string,
  operation: () => Promise<Result>,
) => {
  const previous = noteMutationLocks.get(noteId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  noteMutationLocks.set(noteId, current);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (noteMutationLocks.get(noteId) === current) {
      noteMutationLocks.delete(noteId);
    }
  }
};
