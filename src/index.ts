
import { runner } from "./agent.js";

console.log("Streaming response:\n");

const result = await runner.run(
  "Use the calculator tool to calculate 125 * 38 and explain the result.",
  {
    onToken: (token) => process.stdout.write(token),
  },
);

console.log("\n\n--- Final Report ---");
console.log(result.report);