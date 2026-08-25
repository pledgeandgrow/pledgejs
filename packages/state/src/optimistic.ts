import { useState, useCallback, useRef, useEffect } from 'react';

export interface OptimisticOptions<T> {
  /** Called when the server confirms the update. */
  onConfirm?: (value: T) => void;
  /** Called when the server rejects the update — should rollback. */
  onRollback?: (error: Error, previousValue: T) => void;
}

export function useOptimisticState<T>(
  serverState: T,
  options: OptimisticOptions<T> = {},
): [T, (optimistic: T, mutation: () => Promise<T>) => Promise<void>] {
  const { onConfirm, onRollback } = options;
  const [optimisticState, setOptimisticState] = useState<T>(serverState);
  const previousRef = useRef<T>(serverState);
  const serverRef = useRef<T>(serverState);
  const pendingRef = useRef(false);

  // Propagate later server refreshes into the state — but not while a mutation
  // is in flight (that would clobber the optimistic value). Previously the hook
  // captured only the initial serverState, so subsequent prop changes were lost.
  useEffect(() => {
    serverRef.current = serverState;
    if (!pendingRef.current) setOptimisticState(serverState);
  }, [serverState]);

  const applyOptimistic = useCallback(
    async (optimistic: T, mutation: () => Promise<T>) => {
      previousRef.current = serverRef.current; // roll back to the latest server value
      pendingRef.current = true;
      setOptimisticState(optimistic);
      try {
        const confirmed = await mutation();
        setOptimisticState(confirmed);
        onConfirm?.(confirmed);
      } catch (err) {
        setOptimisticState(previousRef.current);
        onRollback?.(err instanceof Error ? err : new Error(String(err)), previousRef.current);
      } finally {
        pendingRef.current = false;
      }
    },
    [onConfirm, onRollback],
  );

  return [optimisticState, applyOptimistic];
}
