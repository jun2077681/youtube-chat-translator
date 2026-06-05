// Generic per-key session registry shared by the stateful providers. Each
// session owns one persistent CLI subprocess; the extension passes a Chrome tab
// id as the key so every tab/channel gets an isolated conversation context.
// Sessions remove themselves from the map on teardown (idle timeout, manual
// reset, or host exit) via the dispose callback wired up in get().

export interface DisposableSession {
  // Registers the teardown callback the registry uses to drop the dead instance.
  setDispose(fn: () => void): void;
  shutdown(): void;
}

export class SessionRegistry<T extends DisposableSession> {
  private readonly sessions = new Map<string, T>();

  constructor(private readonly create: () => T) {}

  // Returns the session for `key`, creating it on first use. An absent key
  // collapses to a single shared "default" session.
  get(key = "default"): T {
    let session = this.sessions.get(key);
    if (!session) {
      session = this.create();
      session.setDispose(() => this.sessions.delete(key));
      this.sessions.set(key, session);
    }
    return session;
  }

  // With a key, tears down only that session; without one, all sessions (host
  // exit). Each shutdown() also self-removes via its dispose callback.
  shutdown(key?: string): void {
    if (key !== undefined) {
      this.sessions.get(key)?.shutdown();
      return;
    }
    for (const session of Array.from(this.sessions.values())) session.shutdown();
    this.sessions.clear();
  }
}
