import { OllamaClient } from "@nemesis-oss/ollama-sdk";
import {
  OllamaThoughtProcess,
} from "@nemesis-oss/agentic-runtime/brain";

import {
  ToolkitCatalogue,
  ToolDispatcher,
} from "@nemesis-oss/agentic-runtime/hands";

import {
  ContextManager,
} from "@nemesis-oss/agentic-runtime/memory";

import {
  AgentRunner,
} from "@nemesis-oss/agentic-runtime/loop";

import { calculator } from "./tools.js";

const client = new OllamaClient();

const brain = new OllamaThoughtProcess({
  client,
  model: "openbmb/minicpm5-2b",
});

const catalogue = new ToolkitCatalogue([
  calculator,
]);

const hands = new ToolDispatcher(catalogue);

const memory = new ContextManager();

export const runner = new AgentRunner({
  brain,
  hands,
  memory,

  limits: {
    maxCogStepN: 8,
    wallTimeCeilMs: 60_000,
  },
});