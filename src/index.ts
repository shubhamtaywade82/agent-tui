
import { runner } from "./agent.js";

console.log("Running agent...\n");

const result = await runner.run("Use the calculator tool to calculate 125 * 38 and explain the result.");

console.log("\n\n--- Final Report ---");
console.log(result.report);