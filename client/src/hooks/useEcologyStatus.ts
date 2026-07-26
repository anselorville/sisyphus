import { useEffect, useReducer } from "react";

/**
 * The four ecology/food bands from agent-runtime/src/economy/types.ts's
 * `FoodState`, plus "unknown" -- the one value THIS process can be in before
 * the sidecar has ever reported either band (see app/server.py's
 * `agent_runtime_status()` handler, which returns exactly this string for
 * both `ecology` and `food` until the first `ecology.state.changed` /
 * `budget.updated` event has ever arrived).
 */
export const FOOD_BANDS = ["prosperous", "conserving", "reserve", "hibernating"] as const;
export type FoodBand = (typeof FOOD_BANDS)[number] | "unknown";

function isFoodBand(value: unknown): value is (typeof FOOD_BANDS)[number] {
  return typeof value === "string" && (FOOD_BANDS as readonly string[]).includes(value);
}

export interface EcologyState {
  readonly ecology: FoodBand;
  readonly food: FoodBand;
  /** Whether app/server.py ever managed to construct a bridge to the sidecar at all -- see its SidecarEventBridge/`_start_event_bridge`. */
  readonly sidecarConfigured: boolean;
  /** Whether that bridge currently holds a live connection. */
  readonly sidecarConnected: boolean;
}

export const INITIAL_ECOLOGY_STATE: EcologyState = {
  ecology: "unknown",
  food: "unknown",
  sidecarConfigured: false,
  sidecarConnected: false,
};

/**
 * Wire shape for the two live ecology/budget events -- see
 * useAgentConnection.ts's documented wire-shape extension. `state` is
 * `unknown`-typed on purpose (untrusted network input, narrowed by
 * isFoodBand() below).
 */
export interface EcologyWireEvent {
  readonly type: string;
  readonly state?: unknown;
}

/** Internal action carrying a GET /api/agent-runtime/status poll result -- see useEcologyStatus()'s poll effect. Not part of the wire protocol; this is REST, not the data channel. */
export interface EcologyPollResultAction {
  readonly type: "__poll_result__";
  readonly ecology: FoodBand;
  readonly food: FoodBand;
  readonly sidecarConfigured: boolean;
  readonly sidecarConnected: boolean;
}

export type EcologyAction = EcologyWireEvent | EcologyPollResultAction;

/**
 * Pure state-reduction step, exported standalone for direct unit testing
 * (see useEcologyStatus.test.ts) the same way reduceAgentTasks() is.
 *
 * A poll result (see EcologyPollResultAction) always wins outright -- it's
 * the periodic REST source of truth. A live `ecology.state.changed` /
 * `budget.updated` wire event updates only its OWN band, leaving the other
 * untouched, and is ignored entirely (state unchanged) if its `state` value
 * isn't one of the four real bands -- a malformed/garbled live update must
 * never blank out a previously known-good reading.
 */
export function reduceEcologyStatus(state: EcologyState, action: EcologyAction): EcologyState {
  // Discriminated on property presence ("ecology" in action), not on `type`
  // equality: EcologyWireEvent.type is deliberately the wide `string` (so
  // dispatch() can accept ANY AgentWireEvent and safely no-op for the ones
  // it doesn't care about), which means TypeScript can't narrow this union
  // via a `type === "__poll_result__"` check alone -- a wide `string` member
  // is never excluded by comparing it to one specific literal.
  if ("ecology" in action) {
    return {
      ecology: action.ecology,
      food: action.food,
      sidecarConfigured: action.sidecarConfigured,
      sidecarConnected: action.sidecarConnected,
    };
  }
  if (action.type === "ecology.state.changed" && isFoodBand(action.state)) {
    return { ...state, ecology: action.state };
  }
  if (action.type === "budget.updated" && isFoodBand(action.state)) {
    return { ...state, food: action.state };
  }
  return state;
}

export interface UseEcologyStatusResult extends EcologyState {
  /** Feeds one live wire event (of ANY recognized type) in; a no-op for anything that isn't ecology.state.changed/budget.updated. Stable identity. */
  readonly dispatch: (event: EcologyWireEvent) => void;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Tracks the swarm's ecology (compute/system) and food (budget) bands.
 *
 * Right now (see this task's own known-gap note) nothing forwards the
 * sidecar's `ecology.state.changed`/`budget.updated` events from Python to
 * the browser, so `dispatch()` -- wired to live wire events by whoever owns
 * the data channel (see useAgentConnection.ts) -- never actually fires in
 * the running app today. GET /api/agent-runtime/status (polled here on an
 * interval) is therefore the ONLY real data source currently reachable; it
 * already mirrors the sidecar's last-known state server-side (see
 * app/server.py's `_cache_ecology_and_food_state`), so polling it is a
 * correct, if coarser-grained (up to POLL_INTERVAL_MS stale), stand-in until
 * a future task wires the live push through. `dispatch()` exists so that
 * hookup is a pure addition later, not a rewrite.
 */
export function useEcologyStatus(serverAddress: string): UseEcologyStatusResult {
  const [state, dispatch] = useReducer(reduceEcologyStatus, INITIAL_ECOLOGY_STATE);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      fetch(`${serverAddress}/api/agent-runtime/status`)
        .then((response) => {
          if (!response.ok) throw new Error(`server responded ${response.status}`);
          return response.json();
        })
        .then((data: { ecology?: unknown; food?: unknown; sidecar?: { configured?: unknown; connected?: unknown } }) => {
          if (cancelled) return;
          dispatch({
            type: "__poll_result__",
            ecology: isFoodBand(data?.ecology) ? data.ecology : "unknown",
            food: isFoodBand(data?.food) ? data.food : "unknown",
            sidecarConfigured: Boolean(data?.sidecar?.configured),
            sidecarConnected: Boolean(data?.sidecar?.connected),
          });
        })
        .catch(() => {
          if (cancelled) return;
          dispatch({
            type: "__poll_result__",
            ecology: "unknown",
            food: "unknown",
            sidecarConfigured: false,
            sidecarConnected: false,
          });
        });
    };

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverAddress]);

  return { ...state, dispatch };
}
