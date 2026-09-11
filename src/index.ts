
import { runner } from "./agent.js";

const result = await runner.run(
  "Calculate 125 * 38 and explain the result."
);

console.log(result.report);