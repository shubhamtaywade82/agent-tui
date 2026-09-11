// import { OllamaClient } from "@nemesis-oss/ollama-sdk";
// import dotenv from "dotenv";
// dotenv.config();

// const ollama = new OllamaClient({
//   baseUrl: process.env.OLLAMA_HOST!
// });

// // ollama.listModels().then((response: any) => {
// //   console.log(response);
// // });
// //
// ollama.chat({
//   model: "agent-core:latest",
//   stream: true,
//   messages: [
//     {
//       role: "user",
//       content: "Hello, world!",
//     },
//   ],
// }).then((response: any) => {
//   console.log(response);
// });

import { runner } from "./agent.js";

const result = await runner.run(
  "Calculate 125 * 38 and explain the result."
);

console.log(result.report);