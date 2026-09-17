import { useCallback, useEffect, useRef, useState } from "react";

import { getDesktopBridgeErrorMessage, requireDesktopBridge } from "../bridge";
import type { DesktopEvent } from "../bridge";
import { mergeDesktopEvents } from "../features/activity/activity-model";

export function useRunActivity(runId: string | null) {
  const [events, setEvents] = useState<DesktopEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [generation, setGeneration] = useState(0);
  const requestGeneration = useRef(0);

  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const currentGeneration = ++requestGeneration.current;
    if (!runId) {
      setEvents([]);
      setEventsError(null);
      setStreamState("idle");
      return;
    }

    let bridge: ReturnType<typeof requireDesktopBridge>;
    try {
      bridge = requireDesktopBridge();
    } catch (error) {
      setEvents([]);
      setEventsError(error instanceof Error ? error.message : getDesktopBridgeErrorMessage());
      setStreamState("error");
      return;
    }

    let disposed = false;
    setEvents([]);
    setEventsError(null);
    setStreamState("connecting");

    let unsubscribe = () => {};
    try {
      unsubscribe = bridge.subscribeRunEvents(runId, (event) => {
        if (disposed || requestGeneration.current !== currentGeneration) return;
        setEvents((current) => mergeDesktopEvents(current, [event]));
        setEventsError(null);
        setStreamState("live");
      });
    } catch (error) {
      setEventsError(`Failed to subscribe to run events: ${error instanceof Error ? error.message : String(error)}`);
      setStreamState("error");
      return;
    }

    void bridge.getRunEvents(runId).then((persisted) => {
      if (disposed || requestGeneration.current !== currentGeneration) return;
      setEvents((current) => mergeDesktopEvents(persisted, current));
      setEventsError(null);
      setStreamState("live");
    }).catch((error) => {
      if (disposed || requestGeneration.current !== currentGeneration) return;
      setEventsError(`Failed to load run timeline: ${error instanceof Error ? error.message : String(error)}`);
      setStreamState("error");
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [generation, runId]);

  return { events, eventsError, streamState, reconnect };
}

export const useRunEvents = useRunActivity;
