import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "quiz-platform",
    compatibilityDate: "2026-11-02",
    entrypoint,
    assets: { runWorkerFirst: true },
    env: {
      ASSETS: bindings.assets(),
      QUIZ_DB: bindings.d1({ name: "quiz-platform-db" }),
      QUIZ_ROOM: bindings.durableObject({ worker: "quiz-platform", exportName: "QuizRoom" }),
      REACTION_ROOM: bindings.durableObject({ worker: "quiz-platform", exportName: "ReactionRoom" }),
      SETUP_TOKEN: bindings.secret(),
    },
    exports: {
      QuizRoom: exports.durableObject({ storage: "sqlite" }),
      ReactionRoom: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
