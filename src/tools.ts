import { z } from "zod";

export const calculator = {
  name: "calculator",

  description:
    "Calculate a mathematical expression.",

  parameters: z.object({
    expression: z
      .string()
      .describe("Mathematical expression such as 25 * 38"),
  }),

  execute: async ({
    expression,
  }: {
    expression: string;
  }) => {
    // Use a proper expression parser in production.
    const result = Function(`"use strict"; return (${expression})`)();

    return String(result);
  },
};