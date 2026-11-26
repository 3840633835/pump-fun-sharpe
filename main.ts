// Crowd-Selective Paper Bot — entrypoint.
//
// The strategy lives in strategy.ts; this file only hands it to the kit's
// protocol shim, which reads hello/batch/done JSON lines on stdin and writes
// one JSON reply line per batch. Run exactly as the grader does:
//
//   node main.ts
//
// See METHODOLOGY.md for the design and the dev-window results.
import { runBot } from './vendor/makefun-bot.ts';
import { bot } from './strategy.ts';

runBot(bot);
