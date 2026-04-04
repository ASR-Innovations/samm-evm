/**
 * SAMM Shard Orchestrator — CRE Workflow Entry Point
 * 
 * This is the main entry point for the CRE workflow.
 * Run with: cre workflow simulate my-workflow
 */

import { Runner } from '@chainlink/cre-sdk';
import { configSchema, initWorkflow } from './workflow';

export async function main() {
  const runner = await Runner.newRunner({ configSchema });
  await runner.run(initWorkflow);
}

main();
