import * as userRepository from "../repositories/user.repository.js";

export async function loadSessionIdentity(identity: unknown) {
  const value = identity && typeof identity === "object" ? identity as { id?: unknown; version?: unknown } : null;
  const id = typeof identity === "string" ? identity : value?.id;
  const version = typeof identity === "string" ? 0 : value?.version;
  if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return null;
  // Credential checks must not use a potentially stale profile cache.
  const user = await userRepository.findUserById(id);
  if (!user || (user.credentialVersion ?? 0) !== version) return null;
  return { id: user.id, email: user.email, username: user.username, credentialVersion: version };
}
