import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from '@nemesis-oss/termina-core';
import { getHealth, getGoal, listGoals, listRuns, supervisorBaseUrl } from '../cli-supervisor.js';

interface SupervisorPanelProps {
  width: number;
  height: number;
  theme?: any;
  /** Only poll + render when the tab is visible. */
  isActive?: boolean;
  /** Refresh interval in ms. Default 5_000. */
  pollMs?: number;
}

interface HealthState {
  ok: boolean;
  retrievalMode?: string;
  runCap: string;
  goalCap: string;
}

interface RunRow {
  runId: string;
  status: string;
  intent?: string;
  updatedAt: string;
}

interface GoalRow {
  goalId: string;
  status: string;
  title: string;
  taskCount?: number;
}

interface PanelState {
  health: HealthState | null;
  runs: RunRow[];
  goals: GoalRow[];
  error: string | null;
  loading: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  COMPLETED: 'green',
  SUCCEEDED: 'green',
  FAILED: 'red',
  ESCALATED: 'yellow',
  RETRYING: 'yellow',
  RUNNING: 'cyan',
  ACTIVE: 'cyan',
  BLOCKED: 'magenta',
  PENDING: 'gray',
  CANCELLED: 'gray',
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'white';
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

/**
 * Supervisor status panel — surfaces the Agentic Supervisor's health,
 * recent runs, and goal chains as a TUI tab.
 *
 * This panel is read-only: it polls the supervisor's HTTP API (the same
 * endpoints `agent-tui supervisor health/runs/goals` uses). Writes (create
 * goal, advance chain) stay on the CLI/HTTP surface.
 *
 * When the supervisor is not running the panel shows a hint instead of
 * erroring — the rest of the TUI is unaffected.
 */
export const SupervisorPanel: React.FC<SupervisorPanelProps> = ({
  width,
  height,
  isActive = true,
  pollMs = 5_000,
}) => {
  const [state, setState] = useState<PanelState>({
    health: null,
    runs: [],
    goals: [],
    error: null,
    loading: true,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Health is cheap and unauthenticated; use it as the liveness probe.
      const h = await getHealth();
      const health: HealthState = {
        ok: h.ok,
        retrievalMode: h.retrievalMode,
        runCap: h.costBudget
          ? Number.isFinite(h.costBudget.maxCostPerRunUsd)
            ? `$${h.costBudget.maxCostPerRunUsd}`
            : '∞'
          : '∞',
        goalCap: h.costBudget
          ? Number.isFinite(h.costBudget.maxCostPerGoalUsd)
            ? `$${h.costBudget.maxCostPerGoalUsd}`
            : '∞'
          : '∞',
      };

      // Runs + goals need auth when the supervisor binds non-loopback —
      // degrade gracefully if the key is missing.
      let runs: RunRow[] = [];
      let goals: GoalRow[] = [];
      try {
        const r = await listRuns(8);
        runs = r.runs.map((run) => ({
          runId: run.runId,
          status: run.status,
          intent: run.intent,
          updatedAt: run.updatedAt,
        }));
      } catch {
        runs = [];
      }
      try {
        const g = await listGoals(8);
        goals = g.goals.map((goal) => ({
          goalId: goal.goalId,
          status: goal.status,
          title: goal.title,
          taskCount: goal.taskCount,
        }));
      } catch {
        goals = [];
      }

      setState({ health, runs, goals, error: null, loading: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((prev) => ({
        ...prev,
        health: null,
        runs: [],
        goals: [],
        error: msg,
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    if (!isActive) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    void refresh();
    timerRef.current = setInterval(() => void refresh(), pollMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [isActive, pollMs, refresh]);

  const inner = Math.max(4, height - 2);

  if (state.loading && !state.health) {
    return (
      <Box width={width} height={inner} flexDirection="column" paddingX={1}>
        <Text dimColor>connecting to supervisor…</Text>
      </Box>
    );
  }

  if (state.error && !state.health) {
    return (
      <Box width={width} height={inner} flexDirection="column" paddingX={1}>
        <Text color="red" bold>
          ✗ supervisor unreachable
        </Text>
        <Text dimColor>{supervisorBaseUrl()}</Text>
        <Text> </Text>
        <Text dimColor>{truncateMiddle(state.error, Math.max(20, width - 4))}</Text>
        <Text> </Text>
        <Text>Start it with:</Text>
        <Text color="cyan">  npm run supervisor:serve</Text>
        <Text dimColor>  (or: agent-tui supervisor serve)</Text>
        <Text> </Text>
        <Text dimColor>
          Setup guide: docs/supervisor/usage.md — supports Ollama, vLLM,
        </Text>
        <Text dimColor>  OpenAI, Anthropic, and Gemini backends.</Text>
      </Box>
    );
  }

  const h = state.health;
  return (
    <Box width={width} height={inner} flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        ⚡ Agentic Supervisor{' '}
      </Text>
      <Text dimColor>  {supervisorBaseUrl()}</Text>
      <Text> </Text>

      <Text>
        <Text color={h?.ok ? 'green' : 'red'} bold>
          {h?.ok ? '● healthy' : '○ down'}
        </Text>
        <Text dimColor>
          {'  '}retrieval: {h?.retrievalMode ?? '—'}
        </Text>
        <Text dimColor>
          {'  '}cost caps: run {h?.runCap ?? '—'} / goal {h?.goalCap ?? '—'}
        </Text>
      </Text>
      <Text> </Text>

      <Text bold>Recent runs ({state.runs.length})</Text>
      {state.runs.length === 0 ? (
        <Text dimColor>  (none yet)</Text>
      ) : (
        state.runs.slice(0, 5).map((r) => (
          <Box key={r.runId} flexDirection="row">
            <Text color={statusColor(r.status)}>{'●'} </Text>
            <Text dimColor>{truncateMiddle(r.runId, 12)} </Text>
            <Text color={statusColor(r.status)}>{r.status.padEnd(12)}</Text>
            <Text dimColor>{(r.intent ?? '-').padEnd(16)}</Text>
            <Text dimColor>{r.updatedAt.slice(0, 19)}</Text>
          </Box>
        ))
      )}
      <Text> </Text>

      <Text bold>Goal chains ({state.goals.length})</Text>
      {state.goals.length === 0 ? (
        <Text dimColor>  (none yet)</Text>
      ) : (
        state.goals.slice(0, 4).map((g) => (
          <Box key={g.goalId} flexDirection="row">
            <Text color={statusColor(g.status)}>{'●'} </Text>
            <Text dimColor>{truncateMiddle(g.goalId, 12)} </Text>
            <Text color={statusColor(g.status)}>{g.status.padEnd(10)}</Text>
            <Text>{truncateMiddle(g.title, Math.max(10, width - 34))}</Text>
            {g.taskCount !== undefined && <Text dimColor> ({g.taskCount} tasks)</Text>}
          </Box>
        ))
      )}
      <Text> </Text>
      <Text dimColor>
        CLI: agent-tui supervisor runs list · goals list · health — refresh every{' '}
        {Math.round(pollMs / 1000)}s
      </Text>
    </Box>
  );
};

export default SupervisorPanel;
