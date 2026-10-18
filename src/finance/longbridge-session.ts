import type { LongbridgeCredentials } from './longbridge-service.js';

// Credentials are intentionally process-memory only. This module is shared by
// the authenticated web route and the host-side Agent IPC broker; secrets are
// never serialized into ContainerInput, environment variables, logs, or the DB.
const credentialsByUserId = new Map<string, LongbridgeCredentials>();

export function getLongbridgeCredentialsForUser(
  userId: string,
): LongbridgeCredentials | undefined {
  return credentialsByUserId.get(userId);
}

export function setLongbridgeCredentialsForUser(
  userId: string,
  credentials: LongbridgeCredentials,
): void {
  credentialsByUserId.set(userId, credentials);
}

export function clearLongbridgeCredentialsForUser(userId: string): void {
  credentialsByUserId.delete(userId);
}
