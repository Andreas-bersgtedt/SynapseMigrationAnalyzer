import { useEffect, useState } from "react";

export type SseEvent = { type: string; [k: string]: unknown };

/**
 * Subscribe to /api/runs/<id>/events. Returns the latest event list and a
 * `done` flag once the stream terminates.
 */
export function useSseProgress(runId: string | null): {
  events: SseEvent[];
  done: boolean;
  error: string | null;
} {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents([]);
    setDone(false);
    setError(null);
    if (!runId) return;
    const url = `/api/runs/${encodeURIComponent(runId)}/events`;
    const es = new EventSource(url);
    const onMessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as SseEvent;
        setEvents((prev) => [...prev, data]);
        if (data.type === "done") {
          setDone(true);
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    // FastAPI sse-starlette uses event names; listen to the catch-all.
    es.onmessage = onMessage;
    for (const name of [
      "run_started",
      "module_started",
      "module_finished",
      "done",
      "ping",
    ]) {
      es.addEventListener(name, onMessage as unknown as EventListener);
    }
    es.onerror = () => {
      setError("SSE connection lost");
      es.close();
    };
    return () => es.close();
  }, [runId]);

  return { events, done, error };
}
