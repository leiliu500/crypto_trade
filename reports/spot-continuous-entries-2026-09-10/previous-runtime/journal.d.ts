/** Atomic replacement, with file and directory durability. Callers must stop on any error. */
export declare function durableSpotFile(file: string, bytes: string, exclusive: boolean): Promise<void>;
/**
 * Linux flock belongs to the open file description. The child locks an inherited
 * duplicate of our descriptor; our still-open descriptor holds it until close/crash.
 * No PID namespace assumptions, stale-file deletion, or abandoned-lock recovery.
 */
export declare function acquireSpotPaperLock(root: string): Promise<() => Promise<void>>;
